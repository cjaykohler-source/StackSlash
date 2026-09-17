import type { SupabaseClient } from "@supabase/supabase-js";
import type { PromotedEvent } from "./confluenceGate";

/**
 * Tracks every promoted BUY alert as a shadow position so an exit-timing
 * warning follows it: stop, take profit, trailing stop or time limit,
 * posted to the feed's Sell column as `exit_warning`.
 *
 * Before this, only eod-scan's own events opened positions, so the morning
 * intraday-scan alerts (the bulk of all buy alerts) were never followed at
 * all, and the swing positions that did exist were checked once a day
 * against a 10-day / 25% rule — too blunt to be timing.
 *
 * Positions use strategy 'flip' because manage-positions.ts is the live
 * (every-5-min) exit engine and manages exactly that strategy. The rules
 * are snapshotted onto the row, so a later Settings edit never moves a
 * live position's exits:
 *   hard_stop_pct      ← scan_config.default_stop_pct       (0.12)
 *   profit_target_pct  ← scan_config.alert_profit_target_pct (0.10)
 *   trail_pct          ← scan_config.alert_trail_pct         (0.05; arms once up that much)
 *   time_stop_days     ← scan_config.swing_time_stop_days    (10)
 */
export async function openAlertPositions(
  db: SupabaseClient,
  promoted: PromotedEvent[],
  priceBySymbolId: Map<number, number>,
): Promise<number> {
  const longs = promoted.filter((ev) => ev.confluence.direction === "long");
  if (!longs.length) return 0;

  const { data: openRows, error: openErr } = await db
    .from("shadow_positions")
    .select("symbol_id")
    .eq("status", "open")
    .in(
      "symbol_id",
      longs.map((ev) => ev.symbol_id),
    );
  if (openErr) throw openErr;
  const alreadyOpen = new Set(((openRows as { symbol_id: number }[] | null) ?? []).map((r) => r.symbol_id));

  const { data: cfg } = await db
    .from("scan_config")
    .select("default_stop_pct, swing_time_stop_days, alert_profit_target_pct, alert_trail_pct")
    .eq("id", 1)
    .maybeSingle();
  const rules = {
    hard_stop_pct: Number(cfg?.default_stop_pct ?? 0.12),
    profit_target_pct: Number(cfg?.alert_profit_target_pct ?? 0.1),
    trail_pct: Number(cfg?.alert_trail_pct ?? 0.05),
    time_stop_days: Number(cfg?.swing_time_stop_days ?? 10),
  };

  const nowIso = new Date().toISOString();
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const rows: Record<string, unknown>[] = [];

  for (const ev of longs) {
    if (alreadyOpen.has(ev.symbol_id)) continue;
    const entryPrice = priceBySymbolId.get(ev.symbol_id);
    // No entry price, no exit to time — skip rather than open a position
    // manage-positions can never evaluate.
    if (entryPrice == null || !(entryPrice > 0)) continue;
    alreadyOpen.add(ev.symbol_id);
    const primaryName =
      ev.confluence.triggers.find((t) => t.id === ev.trigger_id)?.name ?? ev.confluence.triggers[0]?.name ?? "unknown";
    rows.push({
      symbol_id: ev.symbol_id,
      entry_trigger_event_id: ev.id,
      entry_trigger_name: primaryName,
      entry_date: nowIso.slice(0, 10),
      entry_ts: nowIso,
      entry_price: entryPrice,
      status: "open" as const,
      strategy: "flip" as const,
      stop_price: round2(entryPrice * (1 - rules.hard_stop_pct)),
      high_water: entryPrice,
      rules,
    });
  }
  if (!rows.length) return 0;
  const { error } = await db.from("shadow_positions").insert(rows);
  if (error) throw error;
  return rows.length;
}
