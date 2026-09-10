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

    // Full OHLCV — factor computation only needs close/volume (Bar), but
    // bars_daily also feeds MFE/MAE in record-fire-outcomes.ts and other
    // OHLC readers, so persist open/high/low too (backfill-history already
    // does; the recent-catch-up pull here used to drop them, leaving
    // close-only rows for every recent session).
    type OhlcBar = { date: string; open: number; high: number; low: number; close: number; volume: number };
    async function fetchChunk(chunk: string[]): Promise<[string, OhlcBar[]][]> {
      const chunkBars = new Map<string, OhlcBar[]>();
      let pageToken: string | undefined;
      do {
        const { bars, nextPageToken } = await fetchDailyBars(chunk, start, end, pageToken);
        for (const [ticker, tickerBars] of Object.entries(bars)) {
          const existing = chunkBars.get(ticker) ?? [];
          existing.push(
            ...tickerBars.map((b) => ({
              date: b.t.slice(0, 10),
              open: b.o,
              high: b.h,
              low: b.l,
              close: b.c,
              volume: b.v,
            })),
          );
          chunkBars.set(ticker, existing);
        }
        pageToken = nextPageToken ?? undefined;
      } while (pageToken);
      return [...chunkBars.entries()];
    }

    const chunkResults = await mapWithConcurrency(chunks, 3, fetchChunk);
    const recentBarsBySymbol = new Map<string, OhlcBar[]>(chunkResults.flat());

    // --- 2. Upsert the fresh recent bars ---
    const barRows = [];
    for (const [ticker, bars] of recentBarsBySymbol.entries()) {
      const symbolId = byTicker.get(ticker);
      if (!symbolId) continue;
      for (const b of bars) {
        barRows.push({
          symbol_id: symbolId,
          date: b.date,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
          volume: b.volume,
        });
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
    // 400-day history computeFactors needs lives in the DB now.)
    // Per-symbol reads with bounded concurrency, NOT one big ordered scan
    // with .range() — offset pagination over a 1M+ row ordered set makes
    // every later page re-sort the whole thing and grinds to a halt (hit
    // this the hard way: eod-scan hung >15 min at ~5,000 symbols). Same
    // per-symbol approach backtest-triggers.ts uses.
    const today = end;
    const barsBySymbolId = new Map<number, Bar[]>();
    await mapWithConcurrency(symbols, 24, async (s) => {
      const rows: Bar[] = [];
      const PAGE = 1000;
      let fromRow = 0;
      for (;;) {
        const { data, error } = await db
          .from("bars_daily")
          .select("date, close, volume")
          .eq("symbol_id", s.id)
          .gte("date", factorWindowStart)
          .order("date", { ascending: true })
          .range(fromRow, fromRow + PAGE - 1);
        if (error) throw error;
        if (!data?.length) break;
        for (const r of data as { date: string; close: number; volume: number }[]) {
          rows.push({ date: r.date, close: Number(r.close), volume: Number(r.volume) });
        }
        if (data.length < PAGE) break;
        fromRow += PAGE;
      }
      if (rows.length) barsBySymbolId.set(s.id, rows);
    });

    // --- 3. Compute factor_state via the shared dailySnapshot module ---
    // (also used by backtest-triggers.ts, so live behavior and backtested
    // "expectancy" numbers can't silently drift apart — see its own comment.)
    // Latest close per symbol — stored on factor_state (last_close) and
    // used by steps 6/7 for shadow_positions entry/exit prices.
    const priceBySymbolId = new Map<number, number>();
    for (const [symbolId, bars] of barsBySymbolId.entries()) {
      if (bars.length) priceBySymbolId.set(symbolId, bars[bars.length - 1].close);
    }

    const factorsBySymbolId = computeFactors(barsBySymbolId);

    // Post-earnings-drift inputs from the FMP-synced `earnings` table:
    // the most recent report per symbol within the drift window, so
    // earnings_surprise_drift has real `surprise_pct` / `days_since_earnings`.
    // Free-tier FMP has no per-symbol earnings history, so full SUE can't
    // be computed — the trigger keys off the raw calendar surprise
    // (epsActual vs epsEstimated) instead.
    const DRIFT_WINDOW_DAYS = 90;
    const driftCutoff = new Date(Date.now() - DRIFT_WINDOW_DAYS * 86400_000).toISOString().slice(0, 10);
    const earningsBySymbol = new Map<number, { days_since_earnings: number; surprise_pct: number | null }>();
    {
      const { data: er } = await db
        .from("earnings")
        .select("symbol_id, report_date, surprise_pct")
        .lte("report_date", today)
        .gte("report_date", driftCutoff)
        .order("report_date", { ascending: false })
        .limit(8000);
      for (const r of (er as { symbol_id: number; report_date: string; surprise_pct: number | null }[] | null) ?? []) {
        if (earningsBySymbol.has(r.symbol_id)) continue; // first = most recent
        const days = Math.floor((Date.parse(today) - Date.parse(r.report_date)) / 86400_000);
        earningsBySymbol.set(r.symbol_id, { days_since_earnings: days, surprise_pct: r.surprise_pct });
      }
    }

    const factorRows: Record<string, unknown>[] = [];
    for (const [symbolId, fields] of factorsBySymbolId.entries()) {
      const earn = earningsBySymbol.get(symbolId);
      factorRows.push({
        symbol_id: symbolId,
        as_of: today,
        last_close: priceBySymbolId.get(symbolId) ?? null,
        days_since_earnings: earn?.days_since_earnings ?? null,
        surprise_pct: earn?.surprise_pct ?? null,
        ...fields,
      });
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
            // include the latest close so the confluence gate can apply
            // scan_config's price band without its own price lookup.
            snapshot: { ...row, close: priceBySymbolId.get(row.symbol_id as number) ?? null },
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

    // --- 6. Open shadow positions for new long entries ---
    // Every promoted long cluster opens a hypothetical position, classed
    // by the speed of its contributing triggers (triggers.speed):
    //  - 'flip'  — any contributing trigger is 'fast' (the Phase 3
    //    intraday triggers). Managed by manage-positions.ts against
    //    profit-target / trailing / hard / time stops.
    //  - 'swing' — all contributing triggers are 'slow' (everything
    //    enabled today). Held ~weeks; exited by step 7 (rank drop /
    //    weekly reversal / 180d). The sim-flip-exits backtest showed the
    //    currently-enabled longs behave this way — fast-flip stops
    //    destroy their edge.
    const longEvents = promotedEvents.filter((ev) => ev.confluence.direction === "long");

    if (longEvents.length) {
      const { data: speedRows } = await db.from("triggers").select("id, speed");
      const speedById = new Map(
        ((speedRows as { id: number; speed: string }[] | null) ?? []).map((t) => [t.id, t.speed]),
      );
      // Don't open a second position for a symbol that already has one open.
      const { data: alreadyOpen } = await db
        .from("shadow_positions")
        .select("symbol_id")
        .eq("status", "open")
        .in(
          "symbol_id",
          longEvents.map((ev) => ev.symbol_id),
        );
      const openSymbolIds = new Set((alreadyOpen ?? []).map((p) => p.symbol_id));

      // Flip stop/target params, snapshotted onto each row so a later
      // scan_config edit doesn't retroactively move a live position's rules.
      const { data: cfgRow } = await db
        .from("scan_config")
        .select("default_stop_pct, flip_profit_target_pct, flip_trail_pct, flip_time_stop_days")
        .eq("id", 1)
        .maybeSingle();
      const hardStopPct = Number(cfgRow?.default_stop_pct ?? 0.12);
      const flipRules = {
        profit_target_pct: Number(cfgRow?.flip_profit_target_pct ?? 0.15),
        trail_pct: Number(cfgRow?.flip_trail_pct ?? 0.1),
        hard_stop_pct: hardStopPct,
        time_stop_days: Number(cfgRow?.flip_time_stop_days ?? 4),
      };
      const round2 = (n: number) => Math.round(n * 100) / 100;
      const nowIso = new Date().toISOString();

      const newPositions = [];
      for (const ev of longEvents) {
        if (openSymbolIds.has(ev.symbol_id)) continue;
        const names = ev.confluence.triggers.map((t) => t.name).filter((n): n is string => !!n);
        const anyFast = ev.confluence.triggers.some((t) => speedById.get(t.id) === "fast");
        const strategy = anyFast ? "flip" : "swing";
        const momentumName = names.find((n) => ENTRY_TRIGGER_NAMES.has(n));
        const primaryName =
          ev.confluence.triggers.find((t) => t.id === ev.trigger_id)?.name ?? names[0] ?? "unknown";
        const entryPrice = priceBySymbolId.get(ev.symbol_id) ?? null;
        newPositions.push({
          symbol_id: ev.symbol_id,
          entry_trigger_event_id: ev.id,
          entry_trigger_name: momentumName ?? primaryName,
          entry_date: today,
          entry_ts: nowIso,
          entry_price: entryPrice,
          status: "open" as const,
          strategy,
          stop_price: entryPrice != null ? round2(entryPrice * (1 - hardStopPct)) : null,
          high_water: entryPrice,
          rules: strategy === "flip" ? flipRules : null,
        });
        openSymbolIds.add(ev.symbol_id);
      }

      if (newPositions.length) {
        const { error } = await db.from("shadow_positions").insert(newPositions);
        if (error) throw error;
      }
    }

    // --- 7. Check open SWING positions for an exit condition ---
    // Flip positions are managed by manage-positions.ts, not here.
    //  - momentum entries: the 12-1 research exit rules (rank drop /
    //    weekly reversal / 180d).
    //  - other swing entries (bb_rsi / macd / squeeze): a plain
    //    swing_time_stop_days hold + a wide disaster stop. The
    //    momentum-rank exit would fire instantly on these (an oversold
    //    entry is by definition low-rank), killing the ~10-day hold the
    //    sim showed is where their edge sits.
    const { data: openPositions, error: posErr } = await db
      .from("shadow_positions")
      .select("id, symbol_id, entry_date, entry_price, entry_trigger_name")
      .eq("status", "open")
      .eq("strategy", "swing");
    if (posErr) throw posErr;

    if (openPositions?.length) {
      const factorBySymbolId = new Map(factorRows.map((r) => [r.symbol_id as number, r]));
      const momentumExitTriggerId = (
        await db.from("triggers").select("id").eq("name", "momentum_exit").maybeSingle()
      ).data?.id;
      const { data: swingCfg } = await db
        .from("scan_config")
        .select("swing_time_stop_days, swing_disaster_stop_pct")
        .eq("id", 1)
        .maybeSingle();
      const swingTimeStopDays = Number(swingCfg?.swing_time_stop_days ?? 10);
      const swingDisasterPct = Number(swingCfg?.swing_disaster_stop_pct ?? 0.25);

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
        const isMomentumEntry = ENTRY_TRIGGER_NAMES.has(pos.entry_trigger_name as string);

        let exitReason: string | null = null;
        if (isMomentumEntry) {
          if (momentumRankPct !== null && momentumRankPct < 0.67) exitReason = "rank_dropped";
          else if (ret1wRankPct !== null && ret1wRankPct <= 0.1) exitReason = "weekly_reversal";
          else if (daysHeld > 180) exitReason = "max_hold_period";
        } else {
          const entryPx = pos.entry_price != null ? Number(pos.entry_price) : null;
          const lastPx = priceBySymbolId.get(pos.symbol_id) ?? null;
          if (entryPx && lastPx && lastPx <= entryPx * (1 - swingDisasterPct)) exitReason = "disaster_stop";
          else if (daysHeld >= swingTimeStopDays) exitReason = "time_stop";
        }

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
