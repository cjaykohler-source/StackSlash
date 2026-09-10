import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";

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
const STALE_DAYS = 20; // stop waiting for forward bars past this
const HORIZONS = [1, 2, 3, 5, 10];
const MAX_H = 10;
const FETCH_CONCURRENCY = 25;

type OutcomeRow = {
  id: number;
  trigger_event_id: number;
  symbol_id: number;
  trigger_id: number;
  direction: string;
  entry_date: string;
  entry_price: number | null;
  complete: boolean;
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
      .select("id, trigger_event_id, symbol_id, trigger_id, direction, entry_date, entry_price, complete")
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

      patches.push({ id: r.id, patch });
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
