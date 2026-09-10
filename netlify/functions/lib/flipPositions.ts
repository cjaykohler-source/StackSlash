import type { SupabaseClient } from "@supabase/supabase-js";
import type { PromotedEvent } from "./confluenceGate";

/**
 * Opens a 'flip' shadow position for each newly-promoted long event whose
 * cluster is fast (any contributing trigger has speed='fast'). Shared by
 * intraday-flip-scan (where fast fires are promoted intraday) and eod-scan
 * (for any fast fire that only clustered at EOD).
 *
 * Exit rules are snapshotted onto the row (`rules`) from the primary
 * trigger's `exit_rules`, falling back to scan_config's flip_* defaults —
 * so a later config/trigger edit never moves a live position's exits.
 * manage-positions.ts reads `rules`.
 *
 * Swing positions (momentum entries, and anything else slow) are still
 * opened by eod-scan step 6 — this only handles the flip side.
 */
export async function openFlipPositions(
  db: SupabaseClient,
  promoted: PromotedEvent[],
  priceBySymbolId: Map<number, number>,
): Promise<number> {
  const longs = promoted.filter((ev) => ev.confluence.direction === "long");
  if (!longs.length) return 0;

  const triggerIds = [...new Set(longs.flatMap((ev) => ev.confluence.triggers.map((t) => t.id)))];
  const { data: trigRows } = await db
    .from("triggers")
    .select("id, name, speed, exit_rules")
    .in("id", triggerIds);
  const trigById = new Map(
    ((trigRows as { id: number; name: string; speed: string; exit_rules: Record<string, number> | null }[] | null) ??
      []).map((t) => [t.id, t]),
  );

  const flipEvents = longs.filter((ev) => ev.confluence.triggers.some((t) => trigById.get(t.id)?.speed === "fast"));
  if (!flipEvents.length) return 0;

  const symbolIds = flipEvents.map((ev) => ev.symbol_id);
  const { data: openRows } = await db
    .from("shadow_positions")
    .select("symbol_id")
    .eq("status", "open")
    .in("symbol_id", symbolIds);
  const alreadyOpen = new Set((openRows as { symbol_id: number }[] | null ?? []).map((r) => r.symbol_id));

  const { data: cfg } = await db
    .from("scan_config")
    .select("default_stop_pct, flip_profit_target_pct, flip_trail_pct, flip_time_stop_days")
    .eq("id", 1)
    .maybeSingle();
  const defaults = {
    hard_stop_pct: Number(cfg?.default_stop_pct ?? 0.12),
    profit_target_pct: Number(cfg?.flip_profit_target_pct ?? 0.06),
    trail_pct: Number(cfg?.flip_trail_pct ?? 0.03),
    time_stop_days: Number(cfg?.flip_time_stop_days ?? 2),
  };

  const nowIso = new Date().toISOString();
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const rows: Record<string, unknown>[] = [];

  for (const ev of flipEvents) {
    if (alreadyOpen.has(ev.symbol_id)) continue;
    alreadyOpen.add(ev.symbol_id);
    const primary = trigById.get(ev.trigger_id);
    const rules = { ...defaults, ...(primary?.exit_rules ?? {}) };
    const entryPrice = priceBySymbolId.get(ev.symbol_id) ?? null;
    rows.push({
      symbol_id: ev.symbol_id,
      entry_trigger_event_id: ev.id,
      entry_trigger_name: primary?.name ?? "unknown",
      entry_date: nowIso.slice(0, 10),
      entry_ts: nowIso,
      entry_price: entryPrice,
      status: "open" as const,
      strategy: "flip" as const,
      stop_price: entryPrice != null ? round2(entryPrice * (1 - rules.hard_stop_pct)) : null,
      high_water: entryPrice,
      rules,
    });
  }
  if (!rows.length) return 0;
  const { error } = await db.from("shadow_positions").insert(rows);
  if (error) throw error;
  return rows.length;
}
