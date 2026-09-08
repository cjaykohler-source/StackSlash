import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { fetchDailyBars } from "./lib/alpaca";
import { type Bar } from "./lib/indicators";
import { computeFactors, computeRegime } from "./lib/dailySnapshot";
import { evaluateTrigger, type TriggerDefinition, type TriggerInputs } from "./lib/triggers";
import { filterByCooldown } from "./lib/cooldown";
import { stageAndPromote, ENTRY_TRIGGER_NAMES } from "./lib/confluenceGate";

/**
 * Runs `fn` over `items` with at most `limit` in flight at once — plain
 * worker-pool pattern, no new dependency. Added when the NYSE ingestion
 * took the active universe from ~512 to ~1,900 symbols: at chunkSize=100
 * that's 20 chunks, and firing all 20 chunk-fetches at once via a bare
 * `Promise.all` (fine at 512 symbols / ~6 chunks) tripped Alpaca's rate
 * limit (429) the first time this ran against the bigger universe.
 */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

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
    // PostgREST enforces a hard server-side row cap (commonly 1000) that
    // an explicit .limit() can't raise — same issue already found and
    // fixed once this session in MarketBreadth.tsx. With the active
    // universe at ~1,900 symbols (NYSE ingestion, previously ~500) a
    // plain unbounded select here silently truncated to ~1,000 symbols
    // with NO error — every downstream chunk-size/concurrency change
    // had zero effect because the ticker list itself was already capped
    // before any of that ran. Real .range() pagination fixes it.
    const symbols: { id: number; ticker: string }[] = [];
    {
      const PAGE_SIZE = 1000;
      let from = 0;
      for (;;) {
        const { data, error } = await db
          .from("symbols")
          .select("id, ticker")
          .eq("active", true)
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        if (!data?.length) break;
        symbols.push(...data);
        if (data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
      }
    }
    if (!symbols.length) {
      return { rowsProcessed: 0, result: null };
    }

    const tickers = symbols.map((s) => s.ticker);
    const byTicker = new Map(symbols.map((s) => [s.ticker, s.id] as const));

    // --- 1. Fetch only RECENT bars from Alpaca, then load the rest of the
    // factor window from bars_daily. At ~5,000 symbols a 400-day pull is
    // ~1,600 Alpaca requests every run — it reliably 429s. The historical
    // window is already in bars_daily (backfill-history + prior runs), so
    // this only needs to catch up the last few sessions. FACTOR_WINDOW is
    // what computeFactors reads (from the DB in step 2b).
    const RECENT_FETCH_DAYS = 12;
    const FACTOR_WINDOW_DAYS = 400;
    const end = new Date().toISOString().slice(0, 10);
    const start = new Date(Date.now() - RECENT_FETCH_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const factorWindowStart = new Date(Date.now() - FACTOR_WINDOW_DAYS * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

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
    // Was 100 — at the ~1,900-symbol scale each 100-ticker chunk needs
    // ~28 pages (400-day window ÷ 1000-bar page limit), and empirically
    // confirmed (direct Alpaca calls, same window) that large multi-
    // symbol/many-page requests silently return incomplete symbol
    // coverage well before the last page, with no error and a real
    // next_page_token still present — e.g. a 100-ticker chunk left ~48%
    // of its symbols with zero bars, while the exact same tickers in a
    // 10-symbol/3-page request all came back with full data. Dropped to
    // 25 (a handful of pages per chunk) to stay inside whatever limit
    // that is; chunk count goes up but concurrency-capped fetching
    // handles that fine.
    const chunkSize = 25;
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

    const chunkResults = await mapWithConcurrency(chunks, 3, fetchChunk);
    const recentBarsBySymbol = new Map<string, Bar[]>(chunkResults.flat());

    // --- 2. Upsert the fresh recent bars ---
    const barRows = [];
    for (const [ticker, bars] of recentBarsBySymbol.entries()) {
      const symbolId = byTicker.get(ticker);
      if (!symbolId) continue;
      for (const b of bars) {
        barRows.push({ symbol_id: symbolId, date: b.date, close: b.close, volume: b.volume });
      }
    }
    // Chunked rather than one giant upsert: at ~505 symbols x up to 400
    // days, barRows can run past 100,000 rows in a single request — a
    // real, previously-untested-at-this-scale bottleneck distinct from
    // the fetch-side one already fixed above (confirmed via job_runs:
    // even after parallelizing the fetch, eod-scan still hung with
    // factor_state never getting a single write, meaning it never even
    // got past this step). Sequential chunks of 5,000, same batch-write
    // pattern already proven in backtest-triggers.ts's raw-returns
    // insert loop.
    const UPSERT_BATCH = 5000;
    for (let i = 0; i < barRows.length; i += UPSERT_BATCH) {
      const { error } = await db
        .from("bars_daily")
        .upsert(barRows.slice(i, i + UPSERT_BATCH), { onConflict: "symbol_id,date" });
      if (error) throw error;
    }

    // --- 2b. Load the full factor window from bars_daily ---
    // (the recent Alpaca pull above is just the last few sessions; the
    // 400-day history computeFactors needs lives in the DB now).
    const today = end;
    const barsBySymbolId = new Map<number, Bar[]>();
    {
      const PAGE = 1000;
      let from = 0;
      for (;;) {
        const { data, error } = await db
          .from("bars_daily")
          .select("symbol_id, date, close, volume")
          .gte("date", factorWindowStart)
          .order("symbol_id", { ascending: true })
          .order("date", { ascending: true })
          .range(from, from + PAGE - 1);
        if (error) throw error;
        if (!data?.length) break;
        for (const r of data as { symbol_id: number; date: string; close: number; volume: number }[]) {
          const list = barsBySymbolId.get(r.symbol_id);
          const bar = { date: r.date, close: Number(r.close), volume: Number(r.volume) };
          if (list) list.push(bar);
          else barsBySymbolId.set(r.symbol_id, [bar]);
        }
        if (data.length < PAGE) break;
        from += PAGE;
      }
    }

    // --- 3. Compute factor_state via the shared dailySnapshot module ---
    // (also used by backtest-triggers.ts, so live behavior and backtested
    // "expectancy" numbers can't silently drift apart — see its own comment.)
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

    // Batched — ~5,000 rows at the full universe scale.
    for (let i = 0; i < factorRows.length; i += UPSERT_BATCH) {
      const { error } = await db
        .from("factor_state")
        .upsert(factorRows.slice(i, i + UPSERT_BATCH), { onConflict: "symbol_id,as_of" });
      if (error) throw error;
    }

    // --- 4. Regime state, off the first configured index-like symbol if present, else skip ---
    const spyId = byTicker.get("SPY");
    const spyBars = spyId ? barsBySymbolId.get(spyId) : undefined;
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
      .select("id, name, definition, cooldown_minutes, direction")
      .eq("enabled", true)
      .neq("category", "technical")
      .neq("category", "exit");
    if (trigErr) throw trigErr;
    const cooldownByTriggerId = new Map((triggers ?? []).map((t) => [t.id, t.cooldown_minutes] as const));
    const directionByTriggerId = new Map(
      (triggers ?? []).map((t) => [t.id, (t.direction as "long" | "short" | null) ?? "long"] as const),
    );

    const { data: regime } = await db
      .from("regime_state")
      .select("risk_on")
      .eq("as_of", today)
      .maybeSingle();

    const evaluations: Record<string, unknown>[] = [];
    const fires: { trigger_id: number; symbol_id: number; snapshot: unknown }[] = [];

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
            symbol_id: row.symbol_id as number,
            snapshot: row,
          });
        }
      }
    }

    // Chunked for the same reason as bars_daily above: at the ~1,900-
    // symbol scale this is ~8,000-9,500 rows, each carrying a full
    // factor_state JSON snapshot in `inputs` — a single unbatched insert
    // of that size hit Postgres's statement timeout (57014) once the
    // NYSE ingestion made this table's per-run write big enough to matter.
    for (let i = 0; i < evaluations.length; i += UPSERT_BATCH) {
      const { error } = await db.from("trigger_evaluations").insert(evaluations.slice(i, i + UPSERT_BATCH));
      if (error) throw error;
    }

    // Real cooldown check against the most recent trigger_event for the
    // same trigger+symbol (lib/cooldown.ts) — a fire still within its
    // trigger's cooldown_minutes doesn't even reach the confluence gate.
    const coolableFires = await filterByCooldown(db, fires, cooldownByTriggerId);

    // Confluence gate: a fire only becomes a trigger_event (and therefore a
    // dossier + alert) when >= 2 distinct same-direction triggers have
    // fired for the same symbol within a rolling window — across sources,
    // so an earlier intraday or realtime fire counts toward today's
    // cluster. Lone fires stay in pending_fires and go no further. See
    // lib/confluenceGate.ts.
    const promotedEvents = await stageAndPromote(
      db,
      coolableFires.map((f) => ({
        symbol_id: f.symbol_id,
        trigger_id: f.trigger_id,
        direction: directionByTriggerId.get(f.trigger_id) ?? "long",
        snapshot: f.snapshot,
      })),
      { source: "eod-scan", tradeDate: today },
    );

    // --- 6. Open shadow positions for new momentum-style entries ---
    // Only momentum_rank_entry and momentum_breakout carry a holding-
    // period exit rule in the research (12-1 month momentum, ~3-12 month
    // hold; the faster 20-day breakout variant). The mean-reversion/
    // short-horizon triggers (BB/RSI confluence, squeeze breakout, MACD
    // cross, outlier) have different exit logic entirely and aren't
    // tracked here — see the Trigger Backlog in README.md.
    //
    // Post-confluence-gate: a position opens off a promoted cluster event
    // whose contributing triggers include an entry trigger — i.e. a
    // momentum entry that was confirmed by at least one other signal, not
    // a standalone fire.
    const entryEvents = promotedEvents
      .map((ev) => ({
        ev,
        entryName: ev.confluence.triggers
          .map((t) => t.name)
          .find((n): n is string => !!n && ENTRY_TRIGGER_NAMES.has(n)),
      }))
      .filter((x): x is { ev: (typeof promotedEvents)[number]; entryName: string } => !!x.entryName);

    if (entryEvents.length) {
      // Don't open a second shadow position for a symbol that already
      // has one open — a fresh entry-trigger fire on something you're
      // (hypothetically) already holding isn't a new position.
      const { data: alreadyOpen } = await db
        .from("shadow_positions")
        .select("symbol_id")
        .eq("status", "open")
        .in(
          "symbol_id",
          entryEvents.map((x) => x.ev.symbol_id),
        );
      const openSymbolIds = new Set((alreadyOpen ?? []).map((p) => p.symbol_id));

      const newPositions = [];
      for (const { ev, entryName } of entryEvents) {
        if (openSymbolIds.has(ev.symbol_id)) continue;
        newPositions.push({
          symbol_id: ev.symbol_id,
          entry_trigger_event_id: ev.id,
          entry_trigger_name: entryName,
          entry_date: today,
          entry_price: priceBySymbolId.get(ev.symbol_id) ?? null,
          status: "open" as const,
        });
        openSymbolIds.add(ev.symbol_id);
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
