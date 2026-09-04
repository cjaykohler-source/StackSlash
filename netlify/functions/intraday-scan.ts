import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { fetchSnapshots } from "./lib/alpaca";
import { evaluateTrigger, type TriggerDefinition, type TriggerInputs } from "./lib/triggers";

/**
 * Job B — intraday polling scan.
 *
 * Per the design, this only evaluates technical/entry-timing triggers
 * (category = 'technical') on symbols that already passed the cross-
 * sectional momentum filter in eod-scan (top momentum_rank_pct from the
 * latest factor_state), not the whole universe. That keeps this job cheap
 * and keeps chart-pattern triggers acting as timing on names the slower,
 * better-evidenced signals already flagged — not a standalone scan.
 *
 * Scheduled via netlify.toml: every 10 min, 13:00-20:59 UTC, Mon-Fri.
 * The market-hours check below is a belt-and-suspenders no-op guard in
 * case the cron window is ever widened.
 */
export default async () => {
  const db = getSupabaseAdmin();

  await withJobRun(db, "intraday-scan", async () => {
    if (!isLikelyMarketHours()) {
      return { rowsProcessed: 0, result: null };
    }

    const today = new Date().toISOString().slice(0, 10);

    // Candidate universe: top-third momentum names from today's factor_state.
    const { data: candidates, error } = await db
      .from("factor_state")
      .select("symbol_id, bb_pctb, rsi14, rsi2, momentum_rank_pct, symbols(ticker)")
      .eq("as_of", today)
      .gte("momentum_rank_pct", 0.67);
    if (error) throw error;
    if (!candidates?.length) {
      return { rowsProcessed: 0, result: null };
    }

    const tickerBySymbolId = new Map<number, string>();
    for (const c of candidates) {
      const ticker = (c as unknown as { symbols: { ticker: string } | null }).symbols?.ticker;
      if (ticker) tickerBySymbolId.set(c.symbol_id, ticker);
    }
    const tickers = [...tickerBySymbolId.values()];
    if (!tickers.length) return { rowsProcessed: 0, result: null };

    const snapshots = await fetchSnapshots(tickers);

    const { data: triggers, error: trigErr } = await db
      .from("triggers")
      .select("id, definition")
      .eq("enabled", true)
      .eq("category", "technical");
    if (trigErr) throw trigErr;

    const { data: regime } = await db
      .from("regime_state")
      .select("risk_on")
      .eq("as_of", today)
      .maybeSingle();

    const evaluations: Record<string, unknown>[] = [];
    const fires: Record<string, unknown>[] = [];

    for (const candidate of candidates) {
      const ticker = tickerBySymbolId.get(candidate.symbol_id);
      const snap = ticker ? snapshots[ticker] : undefined;
      const dailyBar = snap?.dailyBar;
      const latestPrice = snap?.latestTrade?.p ?? dailyBar?.c ?? null;

      // Cheap volume-vs-day-open proxy; a real implementation would compare
      // running intraday volume to the 20-day average volume at this same
      // time of day (needs a small history of intraday-volume-by-minute —
      // left as a follow-up once bars_intraday has real data).
      const inputs: TriggerInputs = {
        bb_pctb: candidate.bb_pctb,
        rsi14: candidate.rsi14,
        rsi2: candidate.rsi2,
        momentum_rank_pct: candidate.momentum_rank_pct,
        latest_price: latestPrice,
        risk_on: regime?.risk_on ?? null,
      };

      for (const trigger of triggers ?? []) {
        const fired = evaluateTrigger(trigger.definition as unknown as TriggerDefinition, inputs);
        evaluations.push({ trigger_id: trigger.id, symbol_id: candidate.symbol_id, inputs, fired });
        if (fired) {
          fires.push({ trigger_id: trigger.id, symbol_id: candidate.symbol_id, snapshot: inputs });
        }
      }
    }

    if (evaluations.length) {
      const { error } = await db.from("trigger_evaluations").insert(evaluations);
      if (error) throw error;
    }
    if (fires.length) {
      const { error } = await db.from("trigger_events").insert(fires);
      if (error) throw error;
    }

    return { rowsProcessed: candidates.length, result: null };
  });

  return new Response("ok");
};

function isLikelyMarketHours(): boolean {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcDay = now.getUTCDay(); // 0 = Sunday
  // Rough US market hours in UTC (13:30-20:00), Mon-Fri. Doesn't account
  // for holidays — fine for a v1 no-op guard, not a trading calendar.
  return utcDay >= 1 && utcDay <= 5 && utcHour >= 13 && utcHour < 21;
}

// Schedule is configured in netlify.toml under [functions."intraday-scan"].
