import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Promotion gate — the single point where a raw fire becomes an alert.
 *
 * Every fire from every source (eod-scan, intraday-scan, the realtime
 * worker) lands in `pending_fires` first. A fire is promoted into
 * `trigger_events` — which fires the deep_dive_webhook -> dossier ->
 * Discord chain — when the symbol is inside `scan_config`'s targeting band
 * (price, 20-day dollar volume, RSI ceiling for longs) and is not
 * `alert_excluded`. One promoted event per pending fire.
 *
 * Until 2026-09-17 this was a *confluence* gate: a fire only promoted as
 * part of a cluster of >= scan_config.min_confluence distinct triggers on
 * the same symbol and direction within a 30-hour window, and the cluster
 * produced one merged event carrying `snapshot.confluence`. It was removed:
 * `min_confluence` had been 1 for as long as the setting existed, so every
 * lone fire promoted anyway while the UI still showed "N signals" cluster
 * badges — a concept the data never produced. At this price band, genuine
 * multi-trigger confluence is near-zero (see "Phase 5" in the plan doc if
 * this is ever revisited). What actually filters is the band below.
 *
 * Idempotent: promotion is gated on `pending_fires.promoted_at`, so this
 * can run in-process from eod-scan/intraday-scan AND over HTTP from the
 * worker (via confluence-gate.ts) without ever double-promoting.
 */

export type Direction = "long" | "short";

export interface CandidateFire {
  symbol_id: number;
  trigger_id: number;
  direction: Direction;
  snapshot: unknown;
}

export interface PromotedEvent {
  id: number;
  trigger_id: number;
  trigger_name: string | null;
  symbol_id: number;
  direction: Direction;
  priority: "normal" | "high";
}

const WINDOW_HOURS = 30; // how far back an unpromoted fire is still eligible
const GC_HOURS = 48; // pending_fires older than this are dropped

export interface ScanConfig {
  price_min: number;
  price_max: number;
  min_dollar_vol_20d: number;
  max_rsi14: number;
}

// Only used if the scan_config row can't be read. Kept equal to the live
// scan_config values (SIP scale since 2026-09-17).
const FALLBACK_CONFIG: ScanConfig = {
  price_min: 0.1,
  price_max: 5,
  min_dollar_vol_20d: 2_500_000,
  max_rsi14: 85,
};

async function loadScanConfig(db: SupabaseClient): Promise<ScanConfig> {
  const { data } = await db
    .from("scan_config")
    .select("price_min, price_max, min_dollar_vol_20d, max_rsi14")
    .eq("id", 1)
    .maybeSingle();
  return data
    ? {
        price_min: Number(data.price_min),
        price_max: Number(data.price_max),
        min_dollar_vol_20d: Number(data.min_dollar_vol_20d),
        max_rsi14: Number(data.max_rsi14),
      }
    : FALLBACK_CONFIG;
}

/**
 * Does this symbol fall inside scan_config's targeting band? Price/RSI
 * come from the pending fire's own snapshot where possible (eod-scan puts
 * `close`, intraday `latest_price`, the worker `price`); dollar volume and
 * a fallback RSI come from `factorBySymbol`. A symbol we can't price or
 * whose liquidity is unknown does NOT qualify — better to miss a signal
 * than alert on something untradeable.
 */
function inBand(
  cfg: ScanConfig,
  direction: Direction,
  snapshot: Record<string, unknown> | undefined,
  factor: { dollar_vol_20d: number | null; rsi14: number | null; close?: number } | undefined,
): boolean {
  const s = snapshot ?? {};
  const price = Number(s.close ?? s.latest_price ?? s.price ?? factor?.close ?? NaN);
  if (!Number.isFinite(price) || price < cfg.price_min || price > cfg.price_max) return false;

  const dv = factor?.dollar_vol_20d ?? Number(s.dollar_vol_20d ?? NaN);
  if (!Number.isFinite(dv) || dv < cfg.min_dollar_vol_20d) return false;

  if (direction === "long") {
    const rsi = Number(s.rsi14 ?? factor?.rsi14 ?? NaN);
    if (Number.isFinite(rsi) && rsi > cfg.max_rsi14) return false;
  }
  return true;
}

// Kept in sync with eod-scan.ts's ENTRY_TRIGGER_NAMES — the momentum
// triggers that carry a holding-period exit rule and open a shadow
// position.
export const ENTRY_TRIGGER_NAMES = new Set(["momentum_rank_entry", "momentum_breakout"]);

export interface PendingRow {
  id: number;
  symbol_id: number;
  trigger_id: number;
  direction: Direction;
  snapshot: unknown;
  promoted_at: string | null;
  trigger_event_id: number | null;
  created_at: string;
  triggers: { name: string; cooldown_minutes: number } | null;
  symbols: { alert_excluded: boolean } | null;
}

/**
 * Stage a batch of candidate fires, then promote everything eligible.
 * Returns the trigger_events created this call (for the shadow-position
 * steps in eod-scan / intraday-flip-scan).
 */
export async function stageAndPromote(
  db: SupabaseClient,
  candidates: CandidateFire[],
  opts: { source: string; tradeDate: string },
): Promise<PromotedEvent[]> {
  await gcPending(db);

  if (candidates.length) {
    const rows = candidates.map((c) => ({
      symbol_id: c.symbol_id,
      trigger_id: c.trigger_id,
      direction: c.direction,
      source: opts.source,
      snapshot: (c.snapshot ?? {}) as Record<string, unknown>,
      trade_date: opts.tradeDate,
    }));
    // One pending row per (symbol, trigger, day): a same-day re-fire is not
    // a new independent signal (and all non-realtime triggers already sit
    // behind a 1440-min cooldown anyway).
    const { error } = await db
      .from("pending_fires")
      .upsert(rows, { onConflict: "symbol_id,trigger_id,trade_date", ignoreDuplicates: true });
    if (error) throw error;
  }

  return promotePending(db);
}

/** GC old pending fires — cheap, keeps the table bounded. */
async function gcPending(db: SupabaseClient): Promise<void> {
  const cutoff = new Date(Date.now() - GC_HOURS * 3_600_000).toISOString();
  const { error } = await db.from("pending_fires").delete().lt("created_at", cutoff);
  if (error) throw error;
}

/**
 * Promote every unpromoted, in-band pending fire to its own
 * `trigger_event`. Safe to call with no new candidates — the worker's HTTP
 * path does exactly that after inserting its own pending row.
 */
export async function promotePending(db: SupabaseClient): Promise<PromotedEvent[]> {
  const windowStart = new Date(Date.now() - WINDOW_HOURS * 3_600_000).toISOString();

  const { data, error } = await db
    .from("pending_fires")
    .select(
      "id, symbol_id, trigger_id, direction, snapshot, promoted_at, trigger_event_id, created_at, triggers(name, cooldown_minutes), symbols(alert_excluded)",
    )
    .is("promoted_at", null)
    .gte("created_at", windowStart)
    .order("created_at", { ascending: true });
  if (error) throw error;
  // alert_excluded symbols (mega-cap blue chips) never promote — a fire on
  // one stays in pending_fires, produces no trigger_event / dossier / alert.
  let pending = ((data as unknown as PendingRow[] | null) ?? []).filter((r) => !r.symbols?.alert_excluded);
  if (!pending.length) return [];

  // --- scan_config targeting band ---
  const cfg = await loadScanConfig(db);
  const symIds = [...new Set(pending.map((r) => r.symbol_id))];

  const { data: fsRows } = await db
    .from("factor_state")
    .select("symbol_id, as_of, dollar_vol_20d, rsi14, last_close")
    .in("symbol_id", symIds)
    .order("as_of", { ascending: false })
    .limit(4000);
  const factorBySymbol = new Map<number, { dollar_vol_20d: number | null; rsi14: number | null; close?: number }>();
  for (const r of (fsRows as
    | { symbol_id: number; dollar_vol_20d: number | null; rsi14: number | null; last_close: number | null }[]
    | null) ?? []) {
    if (!factorBySymbol.has(r.symbol_id)) {
      factorBySymbol.set(r.symbol_id, {
        dollar_vol_20d: r.dollar_vol_20d,
        rsi14: r.rsi14,
        close: r.last_close ?? undefined,
      }); // first = latest as_of
    }
  }

  pending = pending.filter((r) =>
    inBand(cfg, r.direction, r.snapshot as Record<string, unknown> | undefined, factorBySymbol.get(r.symbol_id)),
  );
  if (!pending.length) return [];

  const promoted: PromotedEvent[] = [];
  const now = new Date().toISOString();

  for (const row of pending) {
    const { data: eventRow, error: evErr } = await db
      .from("trigger_events")
      .insert({
        trigger_id: row.trigger_id,
        symbol_id: row.symbol_id,
        snapshot: (row.snapshot ?? {}) as Record<string, unknown>,
        priority: "normal",
      })
      .select("id, trigger_id, symbol_id")
      .single();
    if (evErr) throw evErr;

    const { error: upErr } = await db
      .from("pending_fires")
      .update({ promoted_at: now, trigger_event_id: eventRow.id })
      .eq("id", row.id);
    if (upErr) throw upErr;

    promoted.push({
      id: eventRow.id,
      trigger_id: eventRow.trigger_id,
      trigger_name: row.triggers?.name ?? null,
      symbol_id: eventRow.symbol_id,
      direction: row.direction,
      priority: "normal",
    });
  }

  return promoted;
}
