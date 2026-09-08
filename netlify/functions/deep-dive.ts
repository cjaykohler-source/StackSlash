import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { dispatchAlert } from "./lib/notify";
import { fetchSnapshots } from "./lib/alpaca";

// Anything trading below this gets an extra "high priority" flag in the
// dossier and the alert, on top of whatever the confluence tier is.
const SUB_PRICE_FLAG = 5;

/**
 * Job C — deep-dive worker.
 *
 * HTTP-triggered by a Postgres trigger (deep_dive_webhook -> notify_deep_dive)
 * on every trigger_events insert, from any source (eod-scan, intraday-scan,
 * or the realtime worker). Supabase's http_request-equivalent posts the
 * new row as { record: {...} } in the body.
 *
 * Scoring combines two real signals instead of the old placeholder
 * (a single reused factor field, defaulting to a flat 0.5 for anything
 * that didn't have it):
 *
 * 1. Historical expectancy — trigger_stats, built by replaying this
 *    trigger's actual declarative definition against 5 years of real
 *    bars_daily history (see backtest-triggers.ts). Only trusted once
 *    sample_size clears MIN_RELIABLE_SAMPLE — a handful of historical
 *    fires isn't a real base rate.
 * 2. Live multi-signal confirmation — checks the symbol's current
 *    factor_state/regime_state against a few corroborating signals
 *    (trend intact, volume confirming, favorable regime), independent
 *    of whichever single field the trigger itself fired on.
 *
 * When there's no reliable history yet (a new trigger, or one like
 * realtime_outlier_zscore/momentum_exit that backtest-triggers can't
 * replay), score falls back to live confirmation alone rather than a
 * blind 0.5 — still a real read, just a narrower one.
 */

const HISTORICAL_HORIZON_DAYS = 10;
const MIN_RELIABLE_SAMPLE = 30;

export default async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const db = getSupabaseAdmin();
  const body = (await req.json()) as { record?: { id: number } } | { trigger_event_id?: number };
  const triggerEventId =
    "record" in body ? body.record?.id : (body as { trigger_event_id?: number }).trigger_event_id;

  if (!triggerEventId) {
    return new Response("Missing trigger_event id", { status: 400 });
  }

  const { data: event, error } = await db
    .from("trigger_events")
    .select("id, snapshot, symbol_id, trigger_id, priority, symbols(ticker), triggers(name, cooldown_minutes)")
    .eq("id", triggerEventId)
    .single();
  if (error || !event) {
    return new Response(`trigger_event not found: ${error?.message ?? triggerEventId}`, { status: 404 });
  }

  const ticker = (event as unknown as { symbols: { ticker: string } | null }).symbols?.ticker ?? "?";
  const triggerName =
    (event as unknown as { triggers: { name: string; cooldown_minutes: number } | null }).triggers?.name ??
    "unknown trigger";
  const cooldownMinutes =
    (event as unknown as { triggers: { name: string; cooldown_minutes: number } | null }).triggers
      ?.cooldown_minutes ?? 1440;

  const snapshot = event.snapshot as Record<string, unknown>;
  const priority =
    ((event as unknown as { priority?: string }).priority as "normal" | "high" | undefined) ?? "normal";

  // Current share price — one snapshot call, best-effort. Used only for
  // the sub-$5 flag; a failure here must not block the dossier/alert.
  let currentPrice: number | null = null;
  try {
    const snap = (await fetchSnapshots([ticker]))[ticker];
    currentPrice = snap?.latestTrade?.p ?? snap?.dailyBar?.c ?? null;
  } catch {
    /* non-critical */
  }
  const subPriceFlag = currentPrice != null && currentPrice < SUB_PRICE_FLAG;

  // Confluence metadata, when this event was promoted by the confluence
  // gate (lib/confluenceGate.ts). `trigger_id` above is the cluster's
  // primary trigger; `confluence.triggers` is the full contributing set.
  const confluence = (snapshot.confluence ?? null) as {
    count: number;
    direction: "long" | "short";
    tier: "normal" | "high";
    triggers: { id: number; name: string | null }[];
  } | null;

  // --- 1. Historical expectancy, if there's enough of it to trust ---
  // For a confluence event, blend the historical win rate across every
  // contributing trigger (sample-size weighted) rather than reading only
  // the primary trigger's stats — the whole point of the cluster is that
  // more than one signal agreed.
  const statTriggerIds = confluence?.triggers.length
    ? confluence.triggers.map((t) => t.id)
    : [event.trigger_id];
  const { data: statRows } = await db
    .from("trigger_stats")
    .select("trigger_id, sample_size, win_rate, avg_return, cev_score")
    .in("trigger_id", statTriggerIds)
    .eq("horizon_days", HISTORICAL_HORIZON_DAYS);

  const usableStats = (statRows ?? []).filter((s) => (s.sample_size ?? 0) > 0 && s.win_rate !== null);
  const totalSample = usableStats.reduce((a, s) => a + (s.sample_size ?? 0), 0);
  const stats =
    usableStats.length > 0
      ? {
          sample_size: totalSample,
          win_rate: usableStats.reduce((a, s) => a + (s.win_rate ?? 0) * (s.sample_size ?? 0), 0) / totalSample,
          avg_return:
            usableStats.reduce((a, s) => a + (s.avg_return ?? 0) * (s.sample_size ?? 0), 0) / totalSample,
          cev_score:
            usableStats.reduce((a, s) => a + (s.cev_score ?? 0) * (s.sample_size ?? 0), 0) / totalSample,
          blended_from: usableStats.length,
        }
      : null;

  const hasReliableHistory = (stats?.sample_size ?? 0) >= MIN_RELIABLE_SAMPLE;

  // --- 2. Live multi-signal confirmation — the symbol's current state, ---
  //        independent of which single field the trigger itself checked.
  const [{ data: factors }, { data: regime }] = await Promise.all([
    db
      .from("factor_state")
      .select("dist_sma200, volume_ratio_20d")
      .eq("symbol_id", event.symbol_id)
      .order("as_of", { ascending: false })
      .limit(1)
      .maybeSingle(),
    db.from("regime_state").select("risk_on").order("as_of", { ascending: false }).limit(1).maybeSingle(),
  ]);

  const confirmations: { name: string; confirmed: boolean; note: string }[] = [];
  if (typeof factors?.dist_sma200 === "number") {
    confirmations.push({
      name: "Trend intact",
      confirmed: factors.dist_sma200 > 0,
      note: "Price above its 200-day average",
    });
  }
  if (typeof factors?.volume_ratio_20d === "number") {
    confirmations.push({
      name: "Volume confirming",
      confirmed: factors.volume_ratio_20d >= 1,
      note: "Trading volume at or above its 20-day average",
    });
  }
  if (typeof regime?.risk_on === "boolean") {
    confirmations.push({ name: "Favorable regime", confirmed: regime.risk_on, note: "Market in a risk-on regime" });
  }

  const confirmationRatio = confirmations.length
    ? confirmations.filter((c) => c.confirmed).length / confirmations.length
    : 0.5;

  // --- 3. Combine ---
  // With reliable history: mostly the historical win rate, nudged by
  // current confirmation. Without it: confirmation is all there is —
  // better than a placeholder, but the analysis below says so plainly.
  const score = hasReliableHistory
    ? clamp01((stats!.win_rate ?? 0.5) * 0.7 + confirmationRatio * 0.3)
    : confirmationRatio;

  const analysis = {
    trigger: triggerName,
    ticker,
    priority,
    confluence: confluence
      ? {
          count: confluence.count,
          direction: confluence.direction,
          triggers: confluence.triggers.map((t) => t.name).filter(Boolean),
        }
      : null,
    price: currentPrice,
    sub_price_flag: subPriceFlag,
    fired_on: snapshot,
    historical: hasReliableHistory
      ? {
          horizon_days: HISTORICAL_HORIZON_DAYS,
          sample_size: stats!.sample_size,
          win_rate: stats!.win_rate,
          avg_return: stats!.avg_return,
          cev_score: stats!.cev_score,
        }
      : {
          sample_size: stats?.sample_size ?? 0,
          note:
            (stats?.sample_size ?? 0) > 0
              ? `Only ${stats!.sample_size} historical fires — too few to be a reliable base rate yet.`
              : "No backtest history for this trigger yet — it may need backtest-triggers run, or (like realtime_outlier_zscore/momentum_exit) isn't backtestable this way at all.",
        },
    confirmations,
  };

  const { data: dossier, error: dossierError } = await db
    .from("dossiers")
    .insert({
      trigger_event_id: event.id,
      symbol_id: event.symbol_id,
      analysis,
      score,
      priority,
    })
    .select("id")
    .single();
  if (dossierError) throw dossierError;

  await db.from("trigger_events").update({ status: "dossier_ready" }).eq("id", event.id);

  // High-priority (3+ confluent triggers) gets a visible tag and its own
  // dedup tier, so an escalation still pings even if the normal-tier alert
  // for one of the contributing triggers already went out in the window.
  const confluentNames = confluence?.triggers.map((t) => t.name).filter(Boolean) ?? [];
  const headline =
    priority === "high"
      ? `🔴 *HIGH PRIORITY* — *${ticker}*`
      : `*${ticker}* — ${triggerName}`;
  const subPriceLine = subPriceFlag ? `\n🔻 *UNDER $${SUB_PRICE_FLAG}* — trading at $${currentPrice!.toFixed(2)}` : "";
  const confluenceLine = confluentNames.length
    ? `\n${confluentNames.length} signals: ${confluentNames.join(", ")}`
    : "";

  const alertResult = await dispatchAlert(db, {
    dossierId: dossier.id,
    dedupKey: `${event.trigger_id}:${event.symbol_id}:${priority}${subPriceFlag ? ":sub" : ""}`,
    cooldownMinutes,
    message: `${headline}${subPriceLine}${confluenceLine}\nscore: ${score.toFixed(2)}`,
  });

  if (alertResult.status === "sent") {
    await db.from("trigger_events").update({ status: "alerted" }).eq("id", event.id);
  }

  return new Response(JSON.stringify({ dossierId: dossier.id, alert: alertResult }), {
    headers: { "Content-Type": "application/json" },
  });
};

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
