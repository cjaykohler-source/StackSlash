import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { fetchAllPaginated } from "./lib/fetchAllPaginated";
import { roundTripCostPct } from "./lib/tradingCosts";

/**
 * Fills `fire_outcomes` — the realized forward return of every promoted
 * entry `trigger_event`. This is the live counterpart to
 * backtest-triggers.ts: the backtest can only replay stateless daily-factor
 * triggers against history, so realtime_outlier_zscore, the intraday flip
 * triggers, and confluence clusters have no backtested expectancy. This
 * job accumulates one from what actually happened after real fires.
 *
 * Two passes:
 *  1. Backfill — every non-exit trigger_event from the last BACKFILL_DAYS
 *     with no fire_outcomes row gets a stub (entry = the event's ET date).
 *  2. Fill — every incomplete row: pull the symbol's bars_daily from the
 *     entry date forward, compute ret_1/2/3/5/10d and MFE/MAE, mark
 *     complete once 10 forward bars exist (or the entry is old enough that
 *     more bars aren't coming — halt / delist).
 *
 * Entry price is the entry-day bars_daily *close* — not the fire's
 * snapshot tick price. That keeps it (a) un-gameable by an aberrant
 * realtime print and (b) computed exactly like backtest-triggers.ts
 * (`bars[exitIdx].close / entryClose - 1`), so fire_outcomes and
 * trigger_stats are directly comparable.
 *
 * Returns are stored in the trigger's OWN direction sense (short fires:
 * favorable = price down), so a reader can avg(ret_2d) across any mix of
 * triggers and compare straight to trigger_stats.
 *
 * Scheduled ~18:20 ET (after the launchd eod-scan writes the day's
 * bars_daily) via netlify.toml; also accepts a manual POST for a one-off
 * backfill.
 */

const BACKFILL_DAYS = 20; // how far back to create missing stubs
const STALE_DAYS = 32; // stop waiting for forward bars past this — must exceed the 20-bar horizon in calendar terms
const HORIZONS = [1, 2, 3, 5, 10, 20];
const MAX_H = 20;
const FETCH_CONCURRENCY = 25;

type OutcomeRow = {
  id: number;
  trigger_event_id: number;
  symbol_id: number;
  trigger_id: number;
  direction: string;
  entry_date: string;
  entry_ts: string | null;
  entry_price: number | null;
  complete: boolean;
  intraday_bars_2h: number | null;
};

type DayBar = {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
};

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export default async (_req?: Request) => {
  const db = getSupabaseAdmin();

  const result = await withJobRun(db, "record-fire-outcomes", async () => {
    // --- Pass 1: backfill missing stubs ---
    const since = new Date(Date.now() - BACKFILL_DAYS * 86400_000).toISOString();
    const { data: events, error: evErr } = await db
      .from("trigger_events")
      .select("id, ts, symbol_id, trigger_id, status, symbols(alert_excluded), triggers(direction, category)")
      .gte("ts", since)
      .order("ts", { ascending: true });
    if (evErr) throw evErr;

    type RawEvent = {
      id: number;
      ts: string;
      symbol_id: number;
      trigger_id: number;
      status: string | null;
      symbols: { alert_excluded: boolean | null } | null;
      triggers: { direction: string | null; category: string | null } | null;
    };
    const evs = ((events as unknown as RawEvent[]) ?? []).filter(
      (e) =>
        e.triggers?.category !== "exit" &&
        !e.symbols?.alert_excluded &&
        e.status !== "dismissed",
    );

    const { data: existing } = await db
      .from("fire_outcomes")
      .select("trigger_event_id")
      .in(
        "trigger_event_id",
        evs.map((e) => e.id),
      );
    const known = new Set(
      ((existing as { trigger_event_id: number }[] | null) ?? []).map((r) => r.trigger_event_id),
    );

    const stubs = evs
      .filter((e) => !known.has(e.id))
      .map((e) => ({
        trigger_event_id: e.id,
        symbol_id: e.symbol_id,
        trigger_id: e.trigger_id,
        direction: e.triggers?.direction ?? "long",
        entry_date: etDate(e.ts),
        entry_ts: e.ts,
        entry_price: null as number | null, // resolved from the entry-day close on the fill pass
      }));

    let stubsCreated = 0;
    if (stubs.length) {
      // entry_price may be null here — resolved from bars_daily on the fill pass.
      const { error, count } = await db
        .from("fire_outcomes")
        .upsert(stubs, { onConflict: "trigger_event_id", ignoreDuplicates: true, count: "exact" });
      if (error) throw error;
      stubsCreated = count ?? stubs.length;
    }

    // --- Pass 2: fill incomplete rows ---
    const { data: incomplete, error: incErr } = await db
      .from("fire_outcomes")
      .select("id, trigger_event_id, symbol_id, trigger_id, direction, entry_date, entry_ts, entry_price, complete, intraday_bars_2h")
      .eq("complete", false)
      .order("entry_date", { ascending: true })
      .limit(5000);
    if (incErr) throw incErr;
    const rows = (incomplete as OutcomeRow[] | null) ?? [];
    if (!rows.length) {
      return { rowsProcessed: 0, result: { stubsCreated, filled: 0 } };
    }

    // one bars_daily fetch per distinct symbol, from the earliest entry we
    // still need forward of
    const earliestBySymbol = new Map<number, string>();
    for (const r of rows) {
      const cur = earliestBySymbol.get(r.symbol_id);
      if (!cur || r.entry_date < cur) earliestBySymbol.set(r.symbol_id, r.entry_date);
    }

    const barsBySymbol = new Map<number, DayBar[]>();
    const symIds = [...earliestBySymbol.keys()];
    for (let i = 0; i < symIds.length; i += FETCH_CONCURRENCY) {
      const batch = symIds.slice(i, i + FETCH_CONCURRENCY);
      const fetched = await Promise.all(
        batch.map(async (sid) => {
          const { data, error } = await db
            .from("bars_daily")
            .select("date, open, high, low, close")
            .eq("symbol_id", sid)
            .gte("date", earliestBySymbol.get(sid)!)
            .order("date", { ascending: true })
            .limit(MAX_H + 5);
          if (error) throw error;
          return (data as DayBar[] | null) ?? [];
        }),
      );
      batch.forEach((sid, j) => barsBySymbol.set(sid, fetched[j]));
    }

    const spreadBySymbol = new Map<number, number>();
    {
      const spreadRows = await fetchAllPaginated<{ symbol_id: number; spread_pct: number | null }>((from, to) =>
        db.from("symbol_spread_estimates").select("symbol_id, spread_pct").range(from, to),
      );
      for (const s of spreadRows) if (s.spread_pct != null) spreadBySymbol.set(s.symbol_id, Number(s.spread_pct));
    }

    // --- Intraday excursions for fast triggers ---
    // The daily columns above measure from the entry day's CLOSE over up to
    // 20 sessions. For a fast trigger that is the wrong question: the
    // avoid_chase_extended study measured 2 intraday hours from a
    // mid-session tick, and on 2026-09-21 the five fires of that trigger
    // showed mean MFE +2.91% against mean MAE -4.53% -- an unfavourable
    // asymmetry invisible in a daily-close measurement. Computed here so it
    // accrues automatically instead of needing a hand-written query.
    const intradayById = await computeIntradayExcursions(db, rows);

    const nowMs = Date.now();
    const patches: { id: number; patch: Record<string, unknown> }[] = [];

    for (const r of rows) {
      const bars = barsBySymbol.get(r.symbol_id) ?? [];
      // entry bar = first bar on/after entry_date
      const eIdx = bars.findIndex((b) => b.date >= r.entry_date);
      const ageDays = (nowMs - Date.parse(`${r.entry_date}T00:00:00Z`)) / 86400_000;
      if (eIdx === -1) {
        // no bars at all yet — leave it, unless it's gone stale (delisted)
        if (ageDays > STALE_DAYS) patches.push({ id: r.id, patch: { complete: true, updated_at: nowIso() } });
        continue;
      }

      const entryClose = num(bars[eIdx].close);
      const entryPrice = r.entry_price && r.entry_price > 0 ? r.entry_price : entryClose;
      if (!(entryPrice != null && entryPrice > 0)) continue;

      const dir = r.direction === "short" ? -1 : 1;
      const forward = bars.slice(eIdx + 1, eIdx + 1 + MAX_H);
      const barsObserved = forward.length;

      const patch: Record<string, unknown> = {
        entry_price: entryPrice,
        bars_observed: barsObserved,
        updated_at: nowIso(),
        complete: barsObserved >= MAX_H || ageDays > STALE_DAYS,
        // Recorded, not subtracted: ret_* stays the gross realized move so
        // it remains directly comparable to backtest_returns_raw. Storing
        // the cost alongside lets a reader net them consistently instead of
        // guessing whether a given column already had costs taken out.
        cost_pct: roundTripCostPct(entryPrice, spreadBySymbol.get(r.symbol_id) ?? null),
      };
      for (const h of HORIZONS) {
        const c = forward[h - 1] ? num(forward[h - 1].close) : null;
        if (c != null && c > 0) patch[`ret_${h}d`] = dir * (c / entryPrice - 1);
      }
      // MFE/MAE only over forward bars with real OHLC (bars_daily
      // occasionally carries a close-only row — null high/low would coerce
      // to 0 and produce a garbage -100% excursion).
      let mfe = -Infinity;
      let mae = Infinity;
      for (const b of forward) {
        const hi = num(b.high);
        const lo = num(b.low);
        if (hi == null || lo == null || hi <= 0 || lo <= 0) continue;
        const favBar = dir > 0 ? hi : lo;
        const advBar = dir > 0 ? lo : hi;
        mfe = Math.max(mfe, dir * (favBar / entryPrice - 1));
        mae = Math.min(mae, dir * (advBar / entryPrice - 1));
      }
      if (mfe !== -Infinity) patch.mfe_pct = mfe;
      if (mae !== Infinity) patch.mae_pct = mae;

      Object.assign(patch, intradayById.get(r.id) ?? {});
      patches.push({ id: r.id, patch });
    }

    // A fast trigger that fired today has no bars_daily row yet -- eod-scan
    // writes it at 17:45 -- so the daily loop above `continue`s past it
    // before reaching the intraday merge. That is precisely the case the
    // intraday columns exist for, so apply them independently here.
    const patched = new Set(patches.map((p) => p.id));
    for (const [id, intraday] of intradayById) {
      if (patched.has(id)) continue;
      patches.push({ id, patch: { ...intraday, updated_at: nowIso() } });
    }

    // Per-row UPDATEs (upsert can't be used — the table's NOT NULL entry
    // columns would fail the INSERT arm before ON CONFLICT). Bounded
    // concurrency; this job runs once a day over a bounded backlog.
    let filled = 0;
    const UPDATE_CONCURRENCY = 20;
    for (let i = 0; i < patches.length; i += UPDATE_CONCURRENCY) {
      const slice = patches.slice(i, i + UPDATE_CONCURRENCY);
      await Promise.all(
        slice.map(async ({ id, patch }) => {
          const { error } = await db.from("fire_outcomes").update(patch).eq("id", id);
          if (error) throw error;
          filled++;
        }),
      );
    }

    return { rowsProcessed: patches.length, result: { stubsCreated, filled } };
  });

  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
};

/** YYYY-MM-DD in US Eastern for an ISO instant. */
function etDate(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));
}

function nowIso(): string {
  return new Date().toISOString();
}

const INTRADAY_WINDOW_MS = 2 * 60 * 60 * 1000; // the horizon avoid_chase_extended was measured on

/**
 * Intraday excursions for fast-trigger fires, from the fire's own snapshot
 * tick over the following two hours of `bars_intraday`.
 *
 * Deliberately NOT direction-adjusted. The daily columns are stored in the
 * trigger's own direction sense, but `direction` is overloaded on avoid
 * triggers (three are marked `short` and none is a short signal), and the
 * question a fast avoid trigger answers is "would chasing this have hurt a
 * buyer?". So these are always buyer-sense: positive = price rose.
 *
 * bars_intraday is IEX and close-only, so MFE/MAE here are bounds from
 * 1-minute closes, not true highs and lows — `intraday_bars_2h` is stored
 * alongside so a thin series can be discounted.
 */
async function computeIntradayExcursions(
  db: ReturnType<typeof getSupabaseAdmin>,
  rows: OutcomeRow[],
): Promise<Map<number, Record<string, unknown>>> {
  const out = new Map<number, Record<string, unknown>>();

  const { data: trigRows } = await db.from("triggers").select("id, speed").eq("speed", "fast");
  const fastIds = new Set(((trigRows as { id: number }[] | null) ?? []).map((t) => t.id));
  if (!fastIds.size) return out;

  // Only rows that are fast-trigger fires and not already filled.
  const pending = rows.filter(
    (r) => r.intraday_bars_2h == null && r.entry_ts != null && fastIds.has(r.trigger_id),
  );
  if (!pending.length) return out;

  // The fire tick lives on the event's snapshot, not on fire_outcomes.
  const evById = new Map<number, number>();
  for (let i = 0; i < pending.length; i += 500) {
    const { data } = await db
      .from("trigger_events")
      .select("id, snapshot")
      .in("id", pending.slice(i, i + 500).map((r) => r.trigger_event_id));
    for (const e of (data as { id: number; snapshot: Record<string, unknown> | null }[] | null) ?? []) {
      const px = Number(e.snapshot?.last_price ?? e.snapshot?.latest_price ?? NaN);
      if (Number.isFinite(px) && px > 0) evById.set(e.id, px);
    }
  }

  for (const r of pending) {
    const entryPx = evById.get(r.trigger_event_id);
    if (entryPx == null) continue;
    const startMs = Date.parse(r.entry_ts!);
    if (!Number.isFinite(startMs)) continue;
    // The window may not have elapsed yet; leave the row for a later run.
    if (Date.now() < startMs + INTRADAY_WINDOW_MS) continue;

    const { data: bars } = await db
      .from("bars_intraday")
      .select("ts, price")
      .eq("symbol_id", r.symbol_id)
      .gt("ts", new Date(startMs).toISOString())
      .lte("ts", new Date(startMs + INTRADAY_WINDOW_MS).toISOString())
      .order("ts", { ascending: true });
    const series = ((bars as { ts: string; price: number }[] | null) ?? []).filter((b) => Number(b.price) > 0);
    if (!series.length) {
      out.set(r.id, { intraday_entry_price: entryPx, intraday_bars_2h: 0 });
      continue;
    }
    let hi = -Infinity;
    let lo = Infinity;
    for (const b of series) {
      const p = Number(b.price);
      if (p > hi) hi = p;
      if (p < lo) lo = p;
    }
    out.set(r.id, {
      intraday_entry_price: entryPx,
      intraday_ret_2h: Number(series[series.length - 1].price) / entryPx - 1,
      intraday_mfe_2h: hi / entryPx - 1,
      intraday_mae_2h: lo / entryPx - 1,
      intraday_bars_2h: series.length,
    });
  }
  return out;
}
