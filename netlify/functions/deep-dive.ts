import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { dispatchAlert } from "./lib/notify";

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
    .select("id, snapshot, symbol_id, trigger_id, symbols(ticker), triggers(name, cooldown_minutes)")
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

  // --- 1. Historical expectancy, if there's enough of it to trust ---
  const { data: stats } = await db
    .from("trigger_stats")
    .select("sample_size, win_rate, avg_return, cev_score")
    .eq("trigger_id", event.trigger_id)
    .eq("horizon_days", HISTORICAL_HORIZON_DAYS)
    .maybeSingle();

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
    })
    .select("id")
    .single();
  if (dossierError) throw dossierError;

  await db.from("trigger_events").update({ status: "dossier_ready" }).eq("id", event.id);

  const alertResult = await dispatchAlert(db, {
    dossierId: dossier.id,
    dedupKey: `${event.trigger_id}:${event.symbol_id}`,
    cooldownMinutes,
    message: `*${ticker}* — ${triggerName}\nscore: ${score.toFixed(2)}`,
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
