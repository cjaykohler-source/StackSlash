import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Confluence gate — the real "trigger point" for the whole alert pipeline.
 *
 * Every fire from every source (eod-scan, intraday-scan, the realtime
 * worker) lands in `pending_fires` first. A fire is promoted into
 * `trigger_events` — which is what actually fires the deep_dive_webhook ->
 * dossier -> Discord alert chain — ONLY when it is part of a cluster of
 * >= MIN_CONFLUENCE distinct triggers of the SAME direction, for the same
 * symbol, within a rolling WINDOW_HOURS window. A lone fire stays in
 * `pending_fires` (still queryable as a raw signal) and never becomes a
 * trigger_event, dossier, or alert.
 *
 * A cluster of >= HIGH_PRIORITY_AT distinct triggers is promoted at
 * priority 'high'; deep-dive.ts tags those alerts.
 *
 * One promoted `trigger_event` per cluster (not one per contributing
 * trigger) so a confluence produces a single dossier and a single alert.
 * Its `trigger_id` is the cluster's highest-ranked trigger (PRIMARY_RANK);
 * `snapshot.confluence` carries the full list.
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

export interface ConfluenceMeta {
  count: number;
  direction: Direction;
  tier: "normal" | "high";
  triggers: { id: number; name: string | null }[];
}

export interface PromotedEvent {
  id: number;
  trigger_id: number;
  symbol_id: number;
  priority: "normal" | "high";
  confluence: ConfluenceMeta;
}

const WINDOW_HOURS = 30; // how far back a fire still counts toward a cluster
const GC_HOURS = 48; // pending_fires older than this are dropped
const DEFAULT_MIN_CONFLUENCE = 2; // fallback if scan_config is unreadable
const HIGH_PRIORITY_AT = 3; // distinct triggers -> priority 'high'

export interface ScanConfig {
  price_min: number;
  price_max: number;
  min_dollar_vol_20d: number;
  max_rsi14: number;
  min_confluence: number;
}

const FALLBACK_CONFIG: ScanConfig = {
  price_min: 0.1,
  price_max: 3,
  min_dollar_vol_20d: 150000,
  max_rsi14: 85,
  min_confluence: DEFAULT_MIN_CONFLUENCE,
};

async function loadScanConfig(db: SupabaseClient): Promise<ScanConfig> {
  const { data } = await db
    .from("scan_config")
    .select("price_min, price_max, min_dollar_vol_20d, max_rsi14, min_confluence")
    .eq("id", 1)
    .maybeSingle();
  return data
    ? {
        price_min: Number(data.price_min),
        price_max: Number(data.price_max),
        min_dollar_vol_20d: Number(data.min_dollar_vol_20d),
        max_rsi14: Number(data.max_rsi14),
        min_confluence: Number(data.min_confluence),
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

// Which trigger represents a cluster when it produces its single
// trigger_event. Earlier in the list wins; ties break toward the most
// recent fire. Order roughly follows evidence strength / specificity.
const PRIMARY_RANK = [
  "momentum_rank_entry",
  "momentum_breakout",
  "earnings_surprise_drift",
  "volatility_squeeze_breakout_long",
  "volatility_squeeze_breakout_short",
  "macd_bullish_cross",
  "macd_bearish_cross",
  "bb_rsi_confluence_long",
  "bb_rsi_confluence_short",
  "realtime_outlier_zscore",
];

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
 * Stage a batch of candidate fires, then promote every cluster that has
 * reached confluence. Returns the trigger_events that were created this
 * call (for eod-scan's shadow-position step).
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

export type ClusterPlan =
  | {
      action: "create";
      symbolId: number;
      primaryTriggerId: number;
      primarySnapshot: Record<string, unknown>;
      meta: ConfluenceMeta;
      promoteRowIds: number[];
    }
  | {
      action: "fold";
      eventId: number;
      meta: ConfluenceMeta;
      escalate: boolean; // existing event/dossier need bumping to 'high'
      promoteRowIds: number[]; // brand-new rows to attach to the existing event
      existingSnapshot: unknown;
    };

/**
 * Pure decision layer: given the pending fires currently inside the
 * confluence window, work out which clusters have reached the threshold
 * and what should happen to each. No I/O — unit-tested directly.
 */
export function planClusters(pending: PendingRow[], minConfluence = DEFAULT_MIN_CONFLUENCE): ClusterPlan[] {
  const clusters = new Map<string, PendingRow[]>();
  for (const row of pending) {
    const key = `${row.symbol_id}|${row.direction}`;
    const list = clusters.get(key);
    if (list) list.push(row);
    else clusters.set(key, [row]);
  }

  const plans: ClusterPlan[] = [];

  for (const rows of clusters.values()) {
    const distinctTriggerIds = new Set(rows.map((r) => r.trigger_id));
    if (distinctTriggerIds.size < minConfluence) continue;

    const tier: "normal" | "high" = distinctTriggerIds.size >= HIGH_PRIORITY_AT ? "high" : "normal";
    const meta: ConfluenceMeta = {
      count: distinctTriggerIds.size,
      direction: rows[0].direction,
      tier,
      triggers: [...new Map(rows.map((r) => [r.trigger_id, r.triggers?.name ?? null])).entries()].map(
        ([id, name]) => ({ id, name }),
      ),
    };

    const alreadyPromoted = rows.filter((r) => r.promoted_at && r.trigger_event_id);
    const unpromoted = rows.filter((r) => !r.promoted_at);

    if (alreadyPromoted.length > 0) {
      // Cluster already produced an event on an earlier pass. Fold in any
      // brand-new members and, if a new trigger pushed it over the
      // high-priority line, flag the existing event/dossier for escalation.
      if (unpromoted.length === 0 && !(tier === "high")) continue;
      plans.push({
        action: "fold",
        eventId: alreadyPromoted[0].trigger_event_id!,
        meta,
        escalate: tier === "high",
        promoteRowIds: unpromoted.map((r) => r.id),
        existingSnapshot: alreadyPromoted[0].snapshot,
      });
      continue;
    }

    const primary = pickPrimary(rows);
    plans.push({
      action: "create",
      symbolId: rows[0].symbol_id,
      primaryTriggerId: primary.trigger_id,
      primarySnapshot:
        (rows.find((r) => r.trigger_id === primary.trigger_id)?.snapshot as Record<string, unknown>) ?? {},
      meta,
      promoteRowIds: rows.map((r) => r.id),
    });
  }

  return plans;
}

/**
 * Scan unpromoted pending fires and promote every cluster at/over the
 * confluence threshold. Safe to call with no new candidates — the worker's
 * HTTP path does exactly that after inserting its own pending row.
 */
export async function promotePending(db: SupabaseClient): Promise<PromotedEvent[]> {
  const windowStart = new Date(Date.now() - WINDOW_HOURS * 3_600_000).toISOString();

  const { data, error } = await db
    .from("pending_fires")
    .select(
      "id, symbol_id, trigger_id, direction, snapshot, promoted_at, trigger_event_id, created_at, triggers(name, cooldown_minutes), symbols(alert_excluded)",
    )
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
    .select("symbol_id, as_of, dollar_vol_20d, rsi14")
    .in("symbol_id", symIds)
    .order("as_of", { ascending: false })
    .limit(4000);
  const factorBySymbol = new Map<number, { dollar_vol_20d: number | null; rsi14: number | null; close?: number }>();
  for (const r of (fsRows as { symbol_id: number; dollar_vol_20d: number | null; rsi14: number | null }[] | null) ??
    []) {
    if (!factorBySymbol.has(r.symbol_id)) factorBySymbol.set(r.symbol_id, r); // first = latest as_of
  }

  // Latest close per symbol as a price fallback for fires whose snapshot
  // doesn't carry one (older stages, some sources).
  const closeCutoff = new Date(Date.now() - 8 * 24 * 3_600_000).toISOString().slice(0, 10);
  const { data: closeRows } = await db
    .from("bars_daily")
    .select("symbol_id, date, close")
    .in("symbol_id", symIds)
    .gte("date", closeCutoff)
    .order("date", { ascending: false })
    .limit(4000);
  for (const r of (closeRows as { symbol_id: number; close: number }[] | null) ?? []) {
    const f = factorBySymbol.get(r.symbol_id) ?? { dollar_vol_20d: null, rsi14: null };
    if (f.close === undefined) f.close = Number(r.close);
    factorBySymbol.set(r.symbol_id, f);
  }

  pending = pending.filter((r) =>
    inBand(cfg, r.direction, r.snapshot as Record<string, unknown> | undefined, factorBySymbol.get(r.symbol_id)),
  );
  if (!pending.length) return [];

  const promoted: PromotedEvent[] = [];
  const now = new Date().toISOString();

  for (const plan of planClusters(pending, cfg.min_confluence)) {
    if (plan.action === "fold") {
      if (plan.escalate) {
        await db
          .from("trigger_events")
          .update({ priority: "high" })
          .eq("id", plan.eventId)
          .eq("priority", "normal");
        await db
          .from("dossiers")
          .update({ priority: "high" })
          .eq("trigger_event_id", plan.eventId)
          .eq("priority", "normal");
      }
      if (plan.promoteRowIds.length) {
        await db
          .from("pending_fires")
          .update({ promoted_at: now, trigger_event_id: plan.eventId })
          .in("id", plan.promoteRowIds);
        await db
          .from("trigger_events")
          .update({ snapshot: mergeConfluence(plan.existingSnapshot, plan.meta), priority: plan.meta.tier })
          .eq("id", plan.eventId);
      }
      continue;
    }

    const { data: eventRow, error: evErr } = await db
      .from("trigger_events")
      .insert({
        trigger_id: plan.primaryTriggerId,
        symbol_id: plan.symbolId,
        snapshot: { ...plan.primarySnapshot, confluence: plan.meta },
        priority: plan.meta.tier,
      })
      .select("id, trigger_id, symbol_id, priority")
      .single();
    if (evErr) throw evErr;

    const { error: upErr } = await db
      .from("pending_fires")
      .update({ promoted_at: now, trigger_event_id: eventRow.id })
      .in("id", plan.promoteRowIds);
    if (upErr) throw upErr;

    promoted.push({
      id: eventRow.id,
      trigger_id: eventRow.trigger_id,
      symbol_id: eventRow.symbol_id,
      priority: eventRow.priority as "normal" | "high",
      confluence: plan.meta,
    });
  }

  return promoted;
}

function pickPrimary(rows: PendingRow[]): PendingRow {
  const rank = (name: string | undefined) => {
    const i = name ? PRIMARY_RANK.indexOf(name) : -1;
    return i === -1 ? PRIMARY_RANK.length : i;
  };
  return [...rows].sort((a, b) => {
    const dr = rank(a.triggers?.name) - rank(b.triggers?.name);
    if (dr !== 0) return dr;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  })[0];
}

function mergeConfluence(existingSnapshot: unknown, meta: ConfluenceMeta): Record<string, unknown> {
  const base = (existingSnapshot ?? {}) as Record<string, unknown>;
  return { ...base, confluence: meta };
}
