import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { fetchDailyBars } from "./lib/alpaca";
import { type Bar } from "./lib/indicators";
import { computeFactors, computeRegime } from "./lib/dailySnapshot";
import { evaluateTrigger, type TriggerDefinition, type TriggerInputs } from "./lib/triggers";

/**
 * Job A — EOD cross-sectional scan.
 *
 * 1. Pull daily bars for the active universe from Alpaca, upsert bars_daily.
 * 2. Recompute factor_state per symbol (momentum, vol, liquidity, technical,
 *    breakout factors for the Volatility Squeeze/Momentum Breakout/MACD
 *    Cross triggers).
 * 3. Rank momentum, 20-day ROC, and 1-week return cross-sectionally.
 * 4. Update regime_state (the risk-on/off kill-switch, keyed off the index symbol).
 * 5. Evaluate all enabled triggers (excluding 'technical' and 'exit'
 *    categories — see their own comments below); log every evaluation,
 *    insert trigger_events on fires.
 * 6. Open a shadow_positions row for any new momentum_rank_entry /
 *    momentum_breakout fire — auto-tracked hypothetical positions, not
 *    real trades, that give exit logic something to check against.
 * 7. Check every open shadow position for an exit condition (momentum
 *    rank dropped, a bottom-decile weekly return, or held past 180 days);
 *    close it and fire a momentum_exit trigger_event through the same
 *    dossier/alert pipeline as everything else.
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

    // Alpaca allows up to a few hundred symbols per request; chunk to be
    // safe. Chunks run concurrently — pagination *within* a chunk has to
    // stay sequential (each page's token depends on the previous
    // response), but different chunks are fully independent. At 8
    // symbols this was 1 chunk either way and invisible; at ~500+
    // symbols (~5-6 chunks, each potentially several pages for a 400-day
    // window) running them one at a time serialized every page of every
    // chunk behind every other — confirmed via job_runs to never
    // complete at this scale (stuck at "running" for 200+ seconds,
    // factor_state never got a single write past the fetch step). Same
    // fetch-should-be-parallel-not-sequential fix already applied twice
    // elsewhere this session (backfill-history's batch driver,
    // backtest-triggers' per-symbol fetch).
    const chunkSize = 100;
    const chunks: string[][] = [];
    for (let i = 0; i < tickers.length; i += chunkSize) {
      chunks.push(tickers.slice(i, i + chunkSize));
    }

    async function fetchChunk(chunk: string[]): Promise<[string, Bar[]][]> {
      const chunkBars = new Map<string, Bar[]>();
      let pageToken: string | undefined;
      do {
        const { bars, nextPageToken } = await fetchDailyBars(chunk, start, end, pageToken);
        for (const [ticker, tickerBars] of Object.entries(bars)) {
          const existing = chunkBars.get(ticker) ?? [];
          existing.push(
            ...tickerBars.map((b) => ({ date: b.t.slice(0, 10), close: b.c, volume: b.v })),
          );
          chunkBars.set(ticker, existing);
        }
        pageToken = nextPageToken ?? undefined;
      } while (pageToken);
      return [...chunkBars.entries()];
    }

    const chunkResults = await Promise.all(chunks.map(fetchChunk));
    const barsBySymbol = new Map<string, Bar[]>(chunkResults.flat());

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

    // --- 3. Compute factor_state via the shared dailySnapshot module ---
    // (also used by backtest-triggers.ts, so live behavior and backtested
    // "expectancy" numbers can't silently drift apart — see its own comment.)
    const today = end;
    const barsBySymbolId = new Map<number, Bar[]>();
    for (const [ticker, bars] of barsBySymbol.entries()) {
      const symbolId = byTicker.get(ticker);
      if (symbolId) barsBySymbolId.set(symbolId, bars);
    }

    const factorsBySymbolId = computeFactors(barsBySymbolId);
    const factorRows: Record<string, unknown>[] = [];
    for (const [symbolId, fields] of factorsBySymbolId.entries()) {
      factorRows.push({ symbol_id: symbolId, as_of: today, ...fields });
    }

    // Latest close per symbol — used by steps 6/7 for shadow_positions
    // entry_price/exit_price (not stored on factor_state rows themselves).
    const priceBySymbolId = new Map<number, number>();
    for (const [symbolId, bars] of barsBySymbolId.entries()) {
      if (bars.length) priceBySymbolId.set(symbolId, bars[bars.length - 1].close);
    }

    if (factorRows.length) {
      const { error } = await db.from("factor_state").upsert(factorRows, { onConflict: "symbol_id,as_of" });
      if (error) throw error;
    }

    // --- 4. Regime state, off the first configured index-like symbol if present, else skip ---
    const spyBars = barsBySymbol.get("SPY");
    const regimeFields = computeRegime(spyBars);
    if (regimeFields) {
      await db.from("regime_state").upsert(
        {
          as_of: today,
          index_symbol: "SPY",
          above_200dma: regimeFields.above_200dma,
          vol_regime: regimeFields.vol_regime,
          risk_on: regimeFields.risk_on,
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
    // Also excludes category='exit': momentum_exit isn't a stateless
    // per-symbol factor check triggers.ts can evaluate — it depends on
    // shadow_positions (is there an open position, how long has it been
    // held), handled directly in step 7 below instead.
    const { data: triggers, error: trigErr } = await db
      .from("triggers")
      .select("id, name, definition, cooldown_minutes")
      .eq("enabled", true)
      .neq("category", "technical")
      .neq("category", "exit");
    if (trigErr) throw trigErr;
    const triggerNameById = new Map((triggers ?? []).map((t) => [t.id, t.name] as const));

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

    let insertedFires: { id: number; trigger_id: number; symbol_id: number }[] = [];
    if (fires.length) {
      // Cooldown check happens per-fire against the most recent event for
      // that trigger+symbol; kept simple here (deep-dive/send-alert do the
      // authoritative dedup against `alerts`). Insert all fires; downstream
      // dedup prevents duplicate alerts within the cooldown window.
      // .select() to get back real ids — step 6 needs them to open shadow
      // positions pointing at the actual entry_trigger_event_id.
      const { data, error } = await db
        .from("trigger_events")
        .insert(fires)
        .select("id, trigger_id, symbol_id");
      if (error) throw error;
      insertedFires = data ?? [];
    }

    // --- 6. Open shadow positions for new momentum-style entries ---
    // Only momentum_rank_entry and momentum_breakout carry a holding-
    // period exit rule in the research (12-1 month momentum, ~3-12 month
    // hold; the faster 20-day breakout variant). The mean-reversion/
    // short-horizon triggers (BB/RSI confluence, squeeze breakout, MACD
    // cross, outlier) have different exit logic entirely and aren't
    // tracked here — see the Trigger Backlog in README.md.
    const ENTRY_TRIGGER_NAMES = new Set(["momentum_rank_entry", "momentum_breakout"]);
    const entryFires = insertedFires.filter((f) => ENTRY_TRIGGER_NAMES.has(triggerNameById.get(f.trigger_id) ?? ""));

    if (entryFires.length) {
      // Don't open a second shadow position for a symbol that already
      // has one open — a fresh entry-trigger fire on something you're
      // (hypothetically) already holding isn't a new position.
      const { data: alreadyOpen } = await db
        .from("shadow_positions")
        .select("symbol_id")
        .eq("status", "open")
        .in(
          "symbol_id",
          entryFires.map((f) => f.symbol_id),
        );
      const openSymbolIds = new Set((alreadyOpen ?? []).map((p) => p.symbol_id));

      // Also guard against two entry triggers (momentum_rank_entry AND
      // momentum_breakout) firing for the same symbol within this same
      // run — openSymbolIds only reflects pre-existing DB state, not
      // duplicates within entryFires itself. Keep the first, skip the rest.
      const newPositions = [];
      for (const f of entryFires) {
        if (openSymbolIds.has(f.symbol_id)) continue;
        newPositions.push({
          symbol_id: f.symbol_id,
          entry_trigger_event_id: f.id,
          entry_trigger_name: triggerNameById.get(f.trigger_id) ?? "unknown",
          entry_date: today,
          entry_price: priceBySymbolId.get(f.symbol_id) ?? null,
          status: "open" as const,
        });
        openSymbolIds.add(f.symbol_id);
      }

      if (newPositions.length) {
        const { error } = await db.from("shadow_positions").insert(newPositions);
        if (error) throw error;
      }
    }

    // --- 7. Check open shadow positions for an exit condition ---
    const { data: openPositions, error: posErr } = await db
      .from("shadow_positions")
      .select("id, symbol_id, entry_date")
      .eq("status", "open");
    if (posErr) throw posErr;

    if (openPositions?.length) {
      const factorBySymbolId = new Map(factorRows.map((r) => [r.symbol_id as number, r]));
      const momentumExitTriggerId = (
        await db.from("triggers").select("id").eq("name", "momentum_exit").maybeSingle()
      ).data?.id;

      const exitEvents: Record<string, unknown>[] = [];
      const closedPositionUpdates: { id: number; exit_reason: string; exit_price: number | null }[] = [];

      for (const pos of openPositions) {
        const factors = factorBySymbolId.get(pos.symbol_id);
        if (!factors) continue; // symbol had no fresh bars today — leave position as-is

        const momentumRankPct = factors.momentum_rank_pct as number | null;
        const ret1wRankPct = factors.ret_1w_rank_pct as number | null;
        const daysHeld = Math.floor(
          (new Date(today).getTime() - new Date(pos.entry_date).getTime()) / (24 * 60 * 60 * 1000),
        );

        let exitReason: "rank_dropped" | "weekly_reversal" | "max_hold_period" | null = null;
        if (momentumRankPct !== null && momentumRankPct < 0.67) exitReason = "rank_dropped";
        else if (ret1wRankPct !== null && ret1wRankPct <= 0.1) exitReason = "weekly_reversal";
        else if (daysHeld > 180) exitReason = "max_hold_period";

        if (exitReason) {
          const exitPrice = priceBySymbolId.get(pos.symbol_id) ?? null;
          closedPositionUpdates.push({ id: pos.id, exit_reason: exitReason, exit_price: exitPrice });
          if (momentumExitTriggerId) {
            exitEvents.push({
              trigger_id: momentumExitTriggerId,
              symbol_id: pos.symbol_id,
              snapshot: {
                shadow_position_id: pos.id,
                entry_date: pos.entry_date,
                days_held: daysHeld,
                exit_reason: exitReason,
                exit_price: exitPrice,
                momentum_rank_pct: momentumRankPct,
                ret_1w_rank_pct: ret1wRankPct,
              },
            });
          }
        }
      }

      if (exitEvents.length) {
        const { data: insertedExits, error } = await db
          .from("trigger_events")
          .insert(exitEvents)
          .select("id, symbol_id");
        if (error) throw error;

        // Match each inserted exit trigger_event back to its position
        // update by symbol_id (1:1 within this batch — a symbol can only
        // have one open position, so only one exit event per symbol here).
        for (const update of closedPositionUpdates) {
          const posRow = openPositions.find((p) => p.id === update.id);
          const exitEvent = (insertedExits ?? []).find((e) => e.symbol_id === posRow?.symbol_id);
          await db
            .from("shadow_positions")
            .update({
              status: "closed",
              exit_date: today,
              exit_price: update.exit_price,
              exit_reason: update.exit_reason,
              exit_trigger_event_id: exitEvent?.id ?? null,
            })
            .eq("id", update.id);
        }
      } else if (closedPositionUpdates.length) {
        // momentum_exit trigger row missing — still close the positions,
        // just without a linked alert.
        for (const update of closedPositionUpdates) {
          await db
            .from("shadow_positions")
            .update({
              status: "closed",
              exit_date: today,
              exit_price: update.exit_price,
              exit_reason: update.exit_reason,
            })
            .eq("id", update.id);
        }
      }
    }

    return { rowsProcessed: factorRows.length, result: null };
  });

  return new Response("ok");
};

// Schedule is configured in netlify.toml under [functions."eod-scan"].
