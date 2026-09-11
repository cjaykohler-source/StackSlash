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
 * Data-integrity guards (added 2026-09-11, after this cost real accuracy):
 * forward-return "N trading days later" is computed as +N array index
 * within a symbol's own bar array. That is only "N trading days" if the
 * series has no holes, which stopped being true when the universe grew
 * from large caps to ~5,000 sub-$5 names — see horizonIsAligned() and
 * hasSplitArtifact() below for what goes wrong and how much it moved the
 * numbers. Fires whose exit bar fails either guard are dropped rather
 * than recorded, and counted into skippedGapMisaligned /
 * skippedSplitArtifact on the response so the rejection rate stays
 * visible instead of silently shaping trigger_stats.
 *
 * Still assumed: cross-sectional ranking within computeFactors uses each
 * symbol's value as of the same calendar date, so a symbol simply missing
 * a given day is excluded from that day's ranking rather than misaligned.
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

// Short horizons (1-3d) matter most for the quick-flip strategy this is
// tuned for; 5/10/20 kept for continuity with the earlier swing-oriented
// stats and for triggers that genuinely drift.
const HORIZONS = [1, 2, 3, 5, 10, 20];
const LOOKBACK_WINDOW = 300; // bars fed to computeFactors per day — covers the deepest indicator lookback (~260) with room to spare
const MIN_HISTORY_BEFORE_EVAL = 260; // don't evaluate until ret_12m_ex1m/dist_sma200 etc. have enough history to be non-null

// A symbol's bars are indexed positionally, so "N trading days later" is
// bars[idx + N]. Across a halt, delisting, or listing gap that silently
// becomes "N *bars* later" — which can span years. The header's original
// caveat ("acceptable for the continuously-traded large-cap symbols
// currently in the universe") stopped holding when the universe grew to
// ~5,000 sub-$5 names: 736 of them (14.7%) carry a >7-day gap and 193 a
// >30-day one, and those gaps sit on exactly the halt/delist/reverse-split
// events with the largest dislocations. The misaligned returns are
// therefore both enormous and systematically optimistic — they were
// supplying ~85% of bb_rsi_confluence_long's measured edge, and all of
// macd_bullish_cross's. Require the exit bar to land within a plausible
// calendar window for the horizon (~1.45 calendar days per trading day,
// plus slack for holidays).
const CAL_DAYS_PER_TRADING_DAY = 1.45;
const GAP_SLACK_DAYS = 5;

// A reverse split re-scales a symbol's entire history. When only part of
// a series carries the adjustment the two scales interleave and produce
// fabricated moves of many thousand percent — observed in this universe
// as CETX closing at $2,639,700/share and OGEN alternating between ~$3
// and ~$213. No real session moves 10x, so treat that as a scale break
// rather than a price.
const SPLIT_ARTIFACT_RATIO = 10;

function horizonIsAligned(entryDate: string, exitDate: string, horizon: number): boolean {
  const spanDays = (Date.parse(exitDate) - Date.parse(entryDate)) / 86_400_000;
  return spanDays <= Math.ceil(horizon * CAL_DAYS_PER_TRADING_DAY) + GAP_SLACK_DAYS;
}

function hasSplitArtifact(bars: Bar[], fromIdx: number, toIdx: number): boolean {
  for (let i = Math.max(1, fromIdx + 1); i <= toIdx; i++) {
    const prev = bars[i - 1].close;
    const cur = bars[i].close;
    if (prev <= 0) continue;
    const ratio = cur / prev;
    if (ratio >= SPLIT_ARTIFACT_RATIO || ratio <= 1 / SPLIT_ARTIFACT_RATIO) return true;
  }
  return false;
}

export default async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const db = getSupabaseAdmin();

  let body: { startDate?: string; endDate?: string; reset?: boolean; skipFinalize?: boolean; finalizeOnly?: boolean } =
    {};
  try {
    body = await req.json();
  } catch {
    // no body is fine — full-history single-call mode (small universes only)
  }

  if (body.finalizeOnly) {
    const finalizeResult = await withJobRun(db, "backtest-triggers", async () => {
      const { data: statRowCount, error } = await db.rpc("finalize_backtest_stats");
      if (error) throw error;
      return { rowsProcessed: 0, result: { statRows: statRowCount } };
    });
    return new Response(JSON.stringify(finalizeResult), { headers: { "Content-Type": "application/json" } });
  }

  const result = await withJobRun(db, "backtest-triggers", async () => {
    if (body.reset) {
      const { error: resetErr } = await db.from("backtest_returns_raw").delete().gte("id", 0);
      if (resetErr) throw resetErr;
    }

    // Paginated — a plain select caps at PostgREST's ~1000-row limit, so
    // this was silently backtesting only the first ~1,000 of the ~5,000-
    // symbol universe (the S&P-seeded rows), skewing every stat toward
    // large caps. Same cap bug fixed in eod-scan / backfill-history.
    const symbols: { id: number; ticker: string }[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from("symbols")
        .select("id, ticker")
        .eq("active", true)
        .range(from, from + 999);
      if (error) throw error;
      if (!data?.length) break;
      symbols.push(...(data as { id: number; ticker: string }[]));
      if (data.length < 1000) break;
    }
    if (!symbols.length) return { rowsProcessed: 0, result: null };

    const spySymbol = symbols.find((s) => s.ticker === "SPY");
    if (!spySymbol) throw new Error("SPY not found in symbols — needed as the regime/calendar reference.");

    // --- Load bars_daily history per symbol ---
    // Paginated explicitly rather than trusting a single large .limit() —
    // Supabase's default PostgREST row cap (commonly 1000) would silently
    // truncate a 1,255-row 5-year history otherwise, which would corrupt
    // every downstream calculation without ever raising an error.
    //
    // Scoped by a calendar-date margin around the requested chunk when one
    // is given (500 days back covers the ~300-bar lookback window even
    // through weekends/holidays; 30 days forward covers the 20-bar max
    // horizon) — cuts fetch volume for narrow chunks instead of always
    // pulling all ~1,255 days/symbol regardless of what this call needs.
    // Fetched with bounded concurrency (not one symbol at a time): at
    // S&P-500 scale, 504 sequential per-symbol round trips was the
    // dominant fixed cost that made every chunk time out uniformly,
    // regardless of date-range size — the actual bottleneck this
    // chunking work was meant to fix.
    const fetchFrom = body.startDate ? addDays(body.startDate, -500) : undefined;
    const fetchTo = body.endDate ? addDays(body.endDate, 30) : undefined;

    async function fetchSymbolBars(symbolId: number): Promise<Bar[]> {
      const rows: { date: string; close: number; volume: number }[] = [];
      const PAGE_SIZE = 1000;
      let from = 0;
      for (;;) {
        const page = () => {
          let q = db
            .from("bars_daily")
            .select("date, close, volume")
            .eq("symbol_id", symbolId)
            .order("date", { ascending: true })
            .range(from, from + PAGE_SIZE - 1);
          if (fetchFrom) q = q.gte("date", fetchFrom);
          if (fetchTo) q = q.lte("date", fetchTo);
          return q;
        };
        let data: { date: string; close: number; volume: number }[] | null = null;
        for (let attempt = 0; ; attempt++) {
          const res = await page();
          if (!res.error) {
            data = res.data as { date: string; close: number; volume: number }[] | null;
            break;
          }
          if (attempt >= 5) throw res.error; // GOAWAY / transient session drop on a long run
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        }
        if (!data?.length) break;
        rows.push(...data.map((b) => ({ date: b.date, close: Number(b.close), volume: Number(b.volume) })));
        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }
      return rows;
    }

    const barsBySymbolId = new Map<number, Bar[]>();
    const FETCH_CONCURRENCY = 25;
    for (let i = 0; i < symbols.length; i += FETCH_CONCURRENCY) {
      const batch = symbols.slice(i, i + FETCH_CONCURRENCY);
      const results = await Promise.all(batch.map((s) => fetchSymbolBars(s.id)));
      batch.forEach((s, j) => barsBySymbolId.set(s.id, results[j]));
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
    let skippedGapMisaligned = 0;
    let skippedSplitArtifact = 0;
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
            if (!horizonIsAligned(bars[idx].date, bars[exitIdx].date, horizon)) {
              skippedGapMisaligned++;
              continue;
            }
            if (hasSplitArtifact(bars, idx, exitIdx)) {
              skippedSplitArtifact++;
              continue;
            }
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

    // Finalizing re-aggregates the whole accumulated backtest_returns_raw
    // table, which gets slower every chunk as it grows — skip it here
    // (pass {"skipFinalize": true}) and call once at the end instead
    // (via {"finalizeOnly": true}) when chunking across many calls.
    let statRowCount: number | null = null;
    if (!body.skipFinalize) {
      const { data, error: finalizeErr } = await db.rpc("finalize_backtest_stats");
      if (finalizeErr) throw finalizeErr;
      statRowCount = data;
    }

    return {
      rowsProcessed: evaluatedDays,
      result: { firesThisChunk: rawRows.length, statRows: statRowCount, skippedGapMisaligned, skippedSplitArtifact },
    };
  });

  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
};

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
