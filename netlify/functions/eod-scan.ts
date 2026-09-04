import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { fetchDailyBars } from "./lib/alpaca";
import {
  avgDollarVolume,
  bollinger,
  pctReturn,
  percentileRank,
  realizedVol,
  rsi,
  sma,
  type Bar,
} from "./lib/indicators";
import { evaluateTrigger, type TriggerDefinition, type TriggerInputs } from "./lib/triggers";

/**
 * Job A — EOD cross-sectional scan.
 *
 * 1. Pull daily bars for the active universe from Alpaca, upsert bars_daily.
 * 2. Recompute factor_state per symbol (momentum, vol, liquidity, technical).
 * 3. Rank momentum cross-sectionally.
 * 4. Update regime_state (the risk-on/off kill-switch, keyed off the index symbol).
 * 5. Evaluate all enabled triggers; log every evaluation, insert trigger_events on fires.
 *
 * Scheduled via netlify.toml: 21:30 UTC, Mon-Fri (~30 min after US close).
 * NOTE: earnings/estimates fields (sue, est_revision_30d, book_to_market, etc.)
 * are left null here — Alpaca's market-data API doesn't cover fundamentals/
 * estimates. Wire a fundamentals vendor (Polygon, Finnhub, etc.) into a
 * separate step that updates those factor_state columns before relying on
 * the earnings-drift trigger category.
 */
export default async () => {
  const db = getSupabaseAdmin();

  await withJobRun(db, "eod-scan", async () => {
    const { data: symbols, error: symErr } = await db
      .from("symbols")
      .select("id, ticker")
      .eq("active", true);
    if (symErr) throw symErr;
    if (!symbols?.length) {
      return { rowsProcessed: 0, result: null };
    }

    const tickers = symbols.map((s) => s.ticker);
    const byTicker = new Map(symbols.map((s) => [s.ticker, s.id] as const));

    // --- 1. Fetch bars (last ~260 trading days is enough for 12-1 momentum + 200dma) ---
    const end = new Date().toISOString().slice(0, 10);
    const start = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const barsBySymbol = new Map<string, Bar[]>();
    // Alpaca allows up to a few hundred symbols per request; chunk to be safe.
    const chunkSize = 100;
    for (let i = 0; i < tickers.length; i += chunkSize) {
      const chunk = tickers.slice(i, i + chunkSize);
      let pageToken: string | undefined;
      do {
        const { bars, nextPageToken } = await fetchDailyBars(chunk, start, end, pageToken);
        for (const [ticker, tickerBars] of Object.entries(bars)) {
          const existing = barsBySymbol.get(ticker) ?? [];
          existing.push(
            ...tickerBars.map((b) => ({ date: b.t.slice(0, 10), close: b.c, volume: b.v })),
          );
          barsBySymbol.set(ticker, existing);
        }
        pageToken = nextPageToken ?? undefined;
      } while (pageToken);
    }

    // --- 2. Upsert bars_daily ---
    const barRows = [];
    for (const [ticker, bars] of barsBySymbol.entries()) {
      const symbolId = byTicker.get(ticker);
      if (!symbolId) continue;
      for (const b of bars) {
        barRows.push({ symbol_id: symbolId, date: b.date, close: b.close, volume: b.volume });
      }
    }
    if (barRows.length) {
      const { error } = await db.from("bars_daily").upsert(barRows, { onConflict: "symbol_id,date" });
      if (error) throw error;
    }

    // --- 3. Compute factor_state, collect momentum for cross-sectional ranking ---
    const today = end;
    const momentumBySymbol = new Map<number, number>();
    const factorRows: Record<string, unknown>[] = [];

    for (const [ticker, bars] of barsBySymbol.entries()) {
      const symbolId = byTicker.get(ticker);
      if (!symbolId || bars.length < 30) continue;

      const ret1w = pctReturn(bars, 5);
      const ret1m = pctReturn(bars, 21);
      const ret6m = pctReturn(bars, 126);
      const ret12mEx1m = pctReturn(bars, 252 - 21, 21);
      const bb = bollinger(bars, 20);
      const sma200 = sma(bars, 200);
      const last = bars[bars.length - 1].close;

      if (ret12mEx1m !== null) momentumBySymbol.set(symbolId, ret12mEx1m);

      factorRows.push({
        symbol_id: symbolId,
        as_of: today,
        ret_1w: ret1w,
        ret_1m: ret1m,
        ret_6m: ret6m,
        ret_12m_ex1m: ret12mEx1m,
        realized_vol_20d: realizedVol(bars, 20),
        dollar_vol_20d: avgDollarVolume(bars, 20),
        bb_pctb: bb?.pctB ?? null,
        bb_width: bb?.width ?? null,
        rsi14: rsi(bars, 14),
        rsi2: rsi(bars, 2),
        dist_sma200: sma200 ? last / sma200 - 1 : null,
      });
    }

    const momentumValues = [...momentumBySymbol.values()];
    for (const row of factorRows) {
      const symbolId = row.symbol_id as number;
      const m = momentumBySymbol.get(symbolId);
      row.momentum_rank_pct = m !== undefined ? percentileRank(momentumValues, m) : null;
    }

    if (factorRows.length) {
      const { error } = await db.from("factor_state").upsert(factorRows, { onConflict: "symbol_id,as_of" });
      if (error) throw error;
    }

    // --- 4. Regime state, off the first configured index-like symbol if present, else skip ---
    const spyBars = barsBySymbol.get("SPY");
    if (spyBars && spyBars.length >= 200) {
      const sma200 = sma(spyBars, 200);
      const last = spyBars[spyBars.length - 1].close;
      const vol = realizedVol(spyBars, 20);
      const aboveSma = sma200 !== null ? last > sma200 : null;
      // Simple starter rule for vol regime; tune against history once you have it.
      const volRegime = vol === null ? null : vol > 0.25 ? "high" : vol > 0.15 ? "normal" : "low";
      const riskOn = aboveSma === true && volRegime !== "high";

      await db.from("regime_state").upsert(
        {
          as_of: today,
          index_symbol: "SPY",
          above_200dma: aboveSma,
          vol_regime: volRegime,
          risk_on: riskOn,
        },
        { onConflict: "as_of" },
      );
    }

    // --- 5. Evaluate triggers ---
    // Deliberately excludes category='technical': those are entry-timing
    // triggers meant to fire only in intraday-scan, only on symbols that
    // already passed the momentum-rank candidate filter there. Evaluating
    // them here would run them unrestricted against the whole universe,
    // defeating that gate entirely (confirmed happening in practice —
    // NVDA fired bb_rsi_confluence_short here at momentum_rank_pct=0.625,
    // below intraday-scan's 0.67 candidate threshold).
    const { data: triggers, error: trigErr } = await db
      .from("triggers")
      .select("id, definition, cooldown_minutes")
      .eq("enabled", true)
      .neq("category", "technical");
    if (trigErr) throw trigErr;

    const { data: regime } = await db
      .from("regime_state")
      .select("risk_on")
      .eq("as_of", today)
      .maybeSingle();

    const evaluations: Record<string, unknown>[] = [];
    const fires: Record<string, unknown>[] = [];

    for (const row of factorRows) {
      const inputs: TriggerInputs = { ...row, risk_on: regime?.risk_on ?? null };
      for (const trigger of triggers ?? []) {
        const fired = evaluateTrigger(trigger.definition as unknown as TriggerDefinition, inputs);
        evaluations.push({
          trigger_id: trigger.id,
          symbol_id: row.symbol_id,
          inputs: row,
          fired,
        });
        if (fired) {
          fires.push({
            trigger_id: trigger.id,
            symbol_id: row.symbol_id,
            snapshot: row,
          });
        }
      }
    }

    if (evaluations.length) {
      const { error } = await db.from("trigger_evaluations").insert(evaluations);
      if (error) throw error;
    }
    if (fires.length) {
      // Cooldown check happens per-fire against the most recent event for
      // that trigger+symbol; kept simple here (deep-dive/send-alert do the
      // authoritative dedup against `alerts`). Insert all fires; downstream
      // dedup prevents duplicate alerts within the cooldown window.
      const { error } = await db.from("trigger_events").insert(fires);
      if (error) throw error;
    }

    return { rowsProcessed: factorRows.length, result: null };
  });

  return new Response("ok");
};

// Schedule is configured in netlify.toml under [functions."eod-scan"].
