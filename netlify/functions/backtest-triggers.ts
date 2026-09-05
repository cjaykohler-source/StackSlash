import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { computeFactors, computeRegime } from "./lib/dailySnapshot";
import { evaluateTrigger, type TriggerDefinition, type TriggerInputs } from "./lib/triggers";
import type { Bar } from "./lib/indicators";

/**
 * Replays every backtestable trigger's declarative definition against
 * real bars_daily history, and records what actually happened afterward
 * — the historical expectancy deep-dive.ts uses in place of its old
 * placeholder score. HTTP-triggered, not scheduled: run once after a
 * meaningful backfill, and again whenever a trigger's definition or the
 * factor computation changes.
 *
 * Excludes:
 * - category='outlier' (realtime_outlier_zscore): tick-level, bars_daily
 *   is end-of-day only — can't be replayed this way. Its expectancy has
 *   to accumulate from real live fires instead.
 * - category='exit' (momentum_exit): depends on shadow_positions state
 *   (is there an open position, how long has it been held), not a
 *   stateless per-symbol factor check — not something a day-by-day
 *   factor replay can evaluate the same way.
 *
 * Known limitation: assumes each symbol's own bar sequence has no gaps
 * (no halts/delistings) — forward-return "N trading days later" is
 * computed as +N array index within that symbol's own bar array, and
 * cross-sectional ranking within computeFactors uses each symbol's value
 * as of the same calendar date. A gap in one symbol's data would misalign
 * its own forward-return horizon without erroring — acceptable for the
 * continuously-traded large-cap symbols currently in the universe, worth
 * revisiting if more thinly-traded names are added.
 *
 * Chunking: at S&P-500 scale a full run exceeds Netlify's execution
 * timeout. The cross-sectional factors (momentum_rank_pct etc.) need
 * every symbol present for a given day, so this can't be chunked by
 * symbol the way backfill-history is — it's chunked by date range
 * instead. Pass {"startDate": "...", "endDate": "..."} to scope a call to
 * a sub-range of evalDates; omit both to use the full history (fine at
 * small universe sizes, will time out at S&P-500 scale). Each call
 * appends this range's real per-fire returns into backtest_returns_raw
 * and re-finalizes trigger_stats from everything accumulated there so
 * far — safe to call repeatedly across date-range chunks. Pass
 * {"reset": true} on the first chunk of a fresh full run to clear
 * previously-accumulated raw returns first.
 */

const HORIZONS = [5, 10, 20];
const LOOKBACK_WINDOW = 300; // bars fed to computeFactors per day — covers the deepest indicator lookback (~260) with room to spare
const MIN_HISTORY_BEFORE_EVAL = 260; // don't evaluate until ret_12m_ex1m/dist_sma200 etc. have enough history to be non-null

export default async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const db = getSupabaseAdmin();

  let body: { startDate?: string; endDate?: string; reset?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    // no body is fine — full-history single-call mode (small universes only)
  }

  const result = await withJobRun(db, "backtest-triggers", async () => {
    if (body.reset) {
      const { error: resetErr } = await db.from("backtest_returns_raw").delete().gte("id", 0);
      if (resetErr) throw resetErr;
    }

    const { data: symbols, error: symErr } = await db.from("symbols").select("id, ticker").eq("active", true);
    if (symErr) throw symErr;
    if (!symbols?.length) return { rowsProcessed: 0, result: null };

    const spySymbol = symbols.find((s) => s.ticker === "SPY");
    if (!spySymbol) throw new Error("SPY not found in symbols — needed as the regime/calendar reference.");

    // --- Load full bars_daily history per symbol ---
    // Paginated explicitly rather than trusting a single large .limit() —
    // Supabase's default PostgREST row cap (commonly 1000) would silently
    // truncate a 1,255-row 5-year history otherwise, which would corrupt
    // every downstream calculation without ever raising an error.
    const barsBySymbolId = new Map<number, Bar[]>();
    const PAGE_SIZE = 1000;
    for (const symbol of symbols) {
      const rows: { date: string; close: number; volume: number }[] = [];
      let from = 0;
      for (;;) {
        const { data, error } = await db
          .from("bars_daily")
          .select("date, close, volume")
          .eq("symbol_id", symbol.id)
          .order("date", { ascending: true })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        if (!data?.length) break;
        rows.push(...data.map((b) => ({ date: b.date, close: Number(b.close), volume: Number(b.volume) })));
        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }
      barsBySymbolId.set(symbol.id, rows);
    }

    // date -> index, per symbol, for O(1) lookup while iterating SPY's calendar
    const dateIndexBySymbolId = new Map<number, Map<string, number>>();
    for (const [symbolId, bars] of barsBySymbolId) {
      const idx = new Map<string, number>();
      bars.forEach((b, i) => idx.set(b.date, i));
      dateIndexBySymbolId.set(symbolId, idx);
    }

    const spyBars = barsBySymbolId.get(spySymbol.id) ?? [];
    const maxHorizon = Math.max(...HORIZONS);
    let evalDates = spyBars
      .slice(MIN_HISTORY_BEFORE_EVAL, spyBars.length - maxHorizon)
      .map((b) => b.date);
    if (body.startDate) evalDates = evalDates.filter((d) => d >= body.startDate!);
    if (body.endDate) evalDates = evalDates.filter((d) => d <= body.endDate!);

    // --- Triggers to backtest ---
    const { data: triggers, error: trigErr } = await db
      .from("triggers")
      .select("id, name, definition")
      .eq("enabled", true)
      .in("category", ["momentum", "earnings", "technical", "breakout"]);
    if (trigErr) throw trigErr;
    if (!triggers?.length) return { rowsProcessed: 0, result: null };

    // Bearish/short-direction triggers profit when price FALLS — a "win"
    // for them means a negative raw close-to-close return, the opposite
    // of every other (long/bullish) trigger. Without this, a short
    // setup's stats would report the wrong direction's performance
    // entirely (confirmed happening before this fix: bb_rsi_confluence_short
    // showed a *positive* average return as though it were a long signal).
    const isShortDirection = (name: string) => /_short$/.test(name) || /bearish/.test(name);

    // trigger_id -> horizon -> forward returns observed
    const returnsByTriggerHorizon = new Map<number, Map<number, number[]>>();
    for (const t of triggers) {
      returnsByTriggerHorizon.set(t.id, new Map(HORIZONS.map((h) => [h, []])));
    }

    let evaluatedDays = 0;
    for (const date of evalDates) {
      const windowBySymbolId = new Map<number, Bar[]>();
      const idxBySymbolId = new Map<number, number>();
      for (const [symbolId, bars] of barsBySymbolId) {
        const idx = dateIndexBySymbolId.get(symbolId)?.get(date);
        if (idx === undefined) continue; // this symbol has no bar for this calendar date — skip it for this day only
        windowBySymbolId.set(symbolId, bars.slice(Math.max(0, idx + 1 - LOOKBACK_WINDOW), idx + 1));
        idxBySymbolId.set(symbolId, idx);
      }

      const factors = computeFactors(windowBySymbolId);
      const regime = computeRegime(windowBySymbolId.get(spySymbol.id));
      evaluatedDays++;

      for (const [symbolId, fields] of factors) {
        const inputs: TriggerInputs = { ...fields, risk_on: regime?.risk_on ?? null };
        const bars = barsBySymbolId.get(symbolId)!;
        const idx = idxBySymbolId.get(symbolId)!;
        const entryClose = bars[idx].close;

        for (const trigger of triggers) {
          const fired = evaluateTrigger(trigger.definition as unknown as TriggerDefinition, inputs);
          if (!fired) continue;

          const byHorizon = returnsByTriggerHorizon.get(trigger.id)!;
          const directionMultiplier = isShortDirection(trigger.name) ? -1 : 1;
          for (const horizon of HORIZONS) {
            const exitIdx = idx + horizon;
            if (exitIdx >= bars.length) continue;
            const rawReturn = bars[exitIdx].close / entryClose - 1;
            byHorizon.get(horizon)!.push(rawReturn * directionMultiplier);
          }
        }
      }
    }

    // --- Persist this chunk's real per-fire returns, then re-finalize
    // trigger_stats from everything accumulated in backtest_returns_raw so
    // far (this call's chunk plus any prior chunks of the same run). The
    // aggregation math itself (win_rate, avg_return, median_return,
    // cev_score — same expectancy formula as before: winRate*avgWin -
    // (1-winRate)*avgLoss) lives in the finalize_backtest_stats() Postgres
    // function so it's identical regardless of how many chunks fed it.
    const rawRows: { trigger_id: number; horizon_days: number; return_value: number }[] = [];
    for (const [triggerId, byHorizon] of returnsByTriggerHorizon) {
      for (const [horizon, returns] of byHorizon) {
        for (const r of returns) {
          rawRows.push({ trigger_id: triggerId, horizon_days: horizon, return_value: r });
        }
      }
    }

    const INSERT_BATCH = 1000;
    for (let i = 0; i < rawRows.length; i += INSERT_BATCH) {
      const { error } = await db.from("backtest_returns_raw").insert(rawRows.slice(i, i + INSERT_BATCH));
      if (error) throw error;
    }

    const { data: statRowCount, error: finalizeErr } = await db.rpc("finalize_backtest_stats");
    if (finalizeErr) throw finalizeErr;

    return { rowsProcessed: evaluatedDays, result: { firesThisChunk: rawRows.length, statRows: statRowCount } };
  });

  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
};
