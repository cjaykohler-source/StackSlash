import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { dispatchAlert } from "./lib/notify";
import { fetchSnapshots, fetchNews } from "./lib/alpaca";
import { riskFlags, tradeSuggestion } from "./lib/riskFlags";
import { fetchProfile } from "./lib/fmp";

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

const DEFAULT_HISTORICAL_HORIZON_DAYS = 3; // overridden by scan_config.score_horizon_days
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
    .select(
      "id, snapshot, symbol_id, trigger_id, priority, symbols(ticker, alert_excluded, sector, industry, market_cap, is_adr, profile_synced_at), triggers(name, cooldown_minutes)",
    )
    .eq("id", triggerEventId)
    .single();
  if (error || !event) {
    return new Response(`trigger_event not found: ${error?.message ?? triggerEventId}`, { status: 404 });
  }

  // Mega-cap blue chips are excluded from all signal output. The gate
  // already won't promote them; this also covers non-gated paths
  // (momentum_exit) that insert a trigger_event directly.
  if ((event as unknown as { symbols: { alert_excluded?: boolean } | null }).symbols?.alert_excluded) {
    await db.from("trigger_events").update({ status: "dismissed" }).eq("id", event.id);
    return new Response(JSON.stringify({ skipped: "alert_excluded symbol" }), {
      headers: { "Content-Type": "application/json" },
    });
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

  const sym = (event as unknown as {
    symbols: {
      sector: string | null;
      industry: string | null;
      market_cap: number | null;
      is_adr: boolean | null;
      profile_synced_at: string | null;
    } | null;
  }).symbols;

  // On-demand FMP profile fill. fundamentals-sync backfills the universe
  // slowly (one call per symbol); if this symbol fired before the sweep
  // reached it — or its profile is stale — fetch it now so the risk
  // flags below see a real sector / market cap. Best-effort: a failure
  // must not block the dossier.
  let profile = {
    sector: sym?.sector ?? null,
    industry: sym?.industry ?? null,
    market_cap: sym?.market_cap ?? null,
    is_adr: sym?.is_adr ?? null,
  };
  const profileStale =
    !sym?.profile_synced_at ||
    Date.now() - Date.parse(sym.profile_synced_at) > 45 * 86400_000;
  if (profileStale) {
    try {
      const p = await fetchProfile(ticker);
      if (p) {
        profile = {
          sector: p.sector,
          industry: p.industry,
          market_cap: p.marketCap,
          is_adr: p.isAdr,
        };
        await db
          .from("symbols")
          .update({
            sector: p.sector,
            industry: p.industry,
            market_cap: p.marketCap,
            is_etf: p.isEtf,
            is_fund: p.isFund,
            is_adr: p.isAdr,
            profile_synced_at: new Date().toISOString(),
          })
          .eq("id", event.symbol_id);
      }
    } catch {
      /* non-critical */
    }
  }

  // Current share price — one snapshot call, best-effort. A failure here
  // must not block the dossier/alert.
  let currentPrice: number | null = null;
  try {
    const snap = (await fetchSnapshots([ticker]))[ticker];
    currentPrice = snap?.latestTrade?.p ?? snap?.dailyBar?.c ?? null;
  } catch {
    /* non-critical */
  }

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
  const { data: horizonCfg } = await db
    .from("scan_config")
    .select("score_horizon_days")
    .eq("id", 1)
    .maybeSingle();
  const historicalHorizonDays = Number(
    (horizonCfg as { score_horizon_days?: number } | null)?.score_horizon_days ??
      DEFAULT_HISTORICAL_HORIZON_DAYS,
  );

  const statTriggerIds = confluence?.triggers.length
    ? confluence.triggers.map((t) => t.id)
    : [event.trigger_id];
  const { data: statRows } = await db
    .from("trigger_stats")
    .select("trigger_id, sample_size, win_rate, avg_return, cev_score")
    .in("trigger_id", statTriggerIds)
    .eq("horizon_days", historicalHorizonDays);

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

  // --- 2. Live multi-signal confirmation + risk context ---
  const nowIso = new Date().toISOString().slice(0, 10);
  const [{ data: factors }, { data: regime }, { data: earn }, { data: cfg }, { data: fundamentals }] =
    await Promise.all([
    db
      .from("factor_state")
      .select("dist_sma200, volume_ratio_20d, vol_percentile_252d, ret_1m, last_close")
      .eq("symbol_id", event.symbol_id)
      .order("as_of", { ascending: false })
      .limit(1)
      .maybeSingle(),
    db.from("regime_state").select("risk_on").order("as_of", { ascending: false }).limit(1).maybeSingle(),
    db
      .from("earnings")
      .select("report_date")
      .eq("symbol_id", event.symbol_id)
      .gte("report_date", new Date(Date.now() - 15 * 86400_000).toISOString().slice(0, 10))
      .order("report_date", { ascending: true })
      .limit(20),
    db
      .from("scan_config")
      .select("account_size, max_risk_pct, default_stop_pct, suppress_earnings_days")
      .eq("id", 1)
      .maybeSingle(),
    db
      .from("fundamentals")
      .select("runway_quarters, share_change_yoy, book_equity, net_cash_to_mktcap, revenue_growth_yoy, zacks_rank, next_earnings_date")
      .eq("symbol_id", event.symbol_id)
      .maybeSingle(),
  ]);

  currentPrice = currentPrice ?? (factors?.last_close != null ? Number(factors.last_close) : null);

  // Nearest earnings report to today (upcoming preferred, else most recent).
  const earnDates = ((earn as { report_date: string }[] | null) ?? []).map((e) => e.report_date);
  const upcoming = earnDates.find((d) => d >= nowIso);
  const nearestEarnings = upcoming ?? (earnDates.length ? earnDates[earnDates.length - 1] : null);
  const earningsDays = nearestEarnings
    ? Math.round((Date.parse(nearestEarnings) - Date.parse(nowIso)) / 86400_000)
    : null;

  // Recent headlines for the symbol — best-effort "why is it moving"
  // context. fetchNews never throws (returns [] on any failure).
  const newsItems = (await fetchNews([ticker], { limit: 4 })).slice(0, 4);
  const news = newsItems.map((n) => ({
    headline: n.headline,
    url: n.url,
    source: n.source,
    ts: n.created_at,
  }));
  const newsAgeHours = news.length
    ? Math.max(0, (Date.now() - Date.parse(news[0].ts)) / 3_600_000)
    : null;

  const flags = riskFlags({
    price: currentPrice,
    vol_percentile_252d: factors?.vol_percentile_252d ?? null,
    ret_1m: factors?.ret_1m ?? null,
    dist_sma200: factors?.dist_sma200 ?? null,
    volume_ratio_20d: factors?.volume_ratio_20d ?? null,
    sector: profile.sector,
    industry: profile.industry,
    market_cap: profile.market_cap,
    is_adr: profile.is_adr,
    earnings_days: earningsDays,
    earnings_date: nearestEarnings,
    news_age_hours: newsAgeHours,
    runway_quarters: fundamentals?.runway_quarters != null ? Number(fundamentals.runway_quarters) : null,
    share_change_yoy: fundamentals?.share_change_yoy != null ? Number(fundamentals.share_change_yoy) : null,
    book_equity: fundamentals?.book_equity != null ? Number(fundamentals.book_equity) : null,
    net_cash_to_mktcap:
      fundamentals?.net_cash_to_mktcap != null ? Number(fundamentals.net_cash_to_mktcap) : null,
    revenue_growth_yoy:
      fundamentals?.revenue_growth_yoy != null ? Number(fundamentals.revenue_growth_yoy) : null,
    zacks_rank: fundamentals?.zacks_rank != null ? Number(fundamentals.zacks_rank) : null,
  });

  const riskCfg = {
    account_size: Number(cfg?.account_size ?? 40),
    max_risk_pct: Number(cfg?.max_risk_pct ?? 0.2),
    default_stop_pct: Number(cfg?.default_stop_pct ?? 0.12),
  };
  const trade = currentPrice != null ? tradeSuggestion(currentPrice, riskCfg) : null;

  // Suppress the alert (keep the dossier) if earnings are imminent.
  const suppressDays = Number(cfg?.suppress_earnings_days ?? 0);
  const earningsSuppressed =
    suppressDays > 0 && earningsDays != null && earningsDays >= 0 && earningsDays <= suppressDays;

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
    risk_flags: flags,
    trade,
    earnings: nearestEarnings ? { date: nearestEarnings, days: earningsDays } : null,
    news,
    fundamentals: fundamentals
      ? {
          runway_quarters: fundamentals.runway_quarters != null ? Number(fundamentals.runway_quarters) : null,
          share_change_yoy: fundamentals.share_change_yoy != null ? Number(fundamentals.share_change_yoy) : null,
          net_cash_to_mktcap:
            fundamentals.net_cash_to_mktcap != null ? Number(fundamentals.net_cash_to_mktcap) : null,
          revenue_growth_yoy:
            fundamentals.revenue_growth_yoy != null ? Number(fundamentals.revenue_growth_yoy) : null,
          zacks_rank: fundamentals.zacks_rank != null ? Number(fundamentals.zacks_rank) : null,
        }
      : null,
    fired_on: snapshot,
    historical: hasReliableHistory
      ? {
          horizon_days: historicalHorizonDays,
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

  if (earningsSuppressed) {
    await db.from("trigger_events").update({ status: "dismissed" }).eq("id", event.id);
    return new Response(
      JSON.stringify({ dossierId: dossier.id, alert: { status: "skipped", reason: "earnings imminent" } }),
      { headers: { "Content-Type": "application/json" } },
    );
  }

  const confluentNames = confluence?.triggers.map((t) => t.name).filter(Boolean) ?? [];
  const headline =
    priority === "high" ? `🔴 *HIGH PRIORITY* — *${ticker}*` : `*${ticker}* — ${triggerName}`;
  const priceLine = currentPrice != null ? `  ·  $${currentPrice.toFixed(2)}` : "";
  const confluenceLine = confluentNames.length
    ? `\n${confluentNames.length} signals: ${confluentNames.join(", ")}`
    : "";
  const redFlags = flags.filter((x) => x.level === "red");
  const amberFlags = flags.filter((x) => x.level === "amber");
  const greenFlags = flags.filter((x) => x.level === "green");
  const flagLine = flags.length
    ? `\n${redFlags.length ? "⚠️" : "🔹"} ${[...redFlags, ...amberFlags, ...greenFlags]
        .map((x) => x.label)
        .join(" · ")}`
    : "";
  const tradeLine = trade
    ? `\nrisk-defined: ${trade.shares} sh ≈ $${trade.position_cost.toFixed(2)}, stop $${trade.stop.toFixed(2)} (−${Math.round(trade.stop_pct * 100)}%), max loss $${trade.max_loss.toFixed(2)}`
    : "";
  const newsLine = news.length
    ? `\n📰 ${news[0].headline.slice(0, 160)}${newsAgeHours != null ? ` (${newsAgeHours < 1 ? "<1h" : `${Math.round(newsAgeHours)}h`} ago)` : ""}`
    : "";
  const fundBits: string[] = [];
  const fz = fundamentals?.zacks_rank != null ? Number(fundamentals.zacks_rank) : null;
  if (fz != null) fundBits.push(`Zacks ${["", "Strong Buy", "Buy", "Hold", "Sell", "Strong Sell"][fz] ?? fz}`);
  if (fundamentals?.net_cash_to_mktcap != null)
    fundBits.push(`net cash ${Math.round(Number(fundamentals.net_cash_to_mktcap) * 100)}% of cap`);
  if (fundamentals?.revenue_growth_yoy != null)
    fundBits.push(`rev ${Number(fundamentals.revenue_growth_yoy) > 0 ? "+" : ""}${Math.round(Number(fundamentals.revenue_growth_yoy) * 100)}% YoY`);
  const fundLine = fundBits.length ? `\n📊 ${fundBits.join(" · ")}` : "";

  const alertResult = await dispatchAlert(db, {
    dossierId: dossier.id,
    dedupKey: `${event.trigger_id}:${event.symbol_id}:${priority}${redFlags.length ? ":rf" : ""}`,
    cooldownMinutes,
    message: `${headline}${priceLine}${confluenceLine}${flagLine}${tradeLine}${fundLine}${newsLine}\nscore: ${score.toFixed(2)}`,
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
