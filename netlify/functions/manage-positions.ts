import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { fetchSnapshots } from "./lib/alpaca";
import { etDateString, etWallClock } from "./lib/etTime";

/**
 * Job — flip-position manager. The exit half of the quick-flip pipeline.
 *
 * Every promoted long entry opens a `shadow_positions` row (see eod-scan
 * step 6). Momentum entries are 'swing' and exited by eod-scan; every
 * other entry is a 'flip' and managed here, every 5 min during market
 * hours, against four rules (checked in this order):
 *
 *   1. hard stop      price <= stop_price (entry * (1 - hard_stop_pct))
 *   2. profit target  price >= entry * (1 + profit_target_pct)
 *   3. trailing stop  price <= high_water * (1 - trail_pct), but only once
 *                     high_water has reached entry * (1 + trail_pct) — a
 *                     trail below entry is just the hard stop's job
 *   4. time stop      held longer than time_stop_days calendar days
 *
 * Each rule set is snapshotted onto the position at entry (`rules`), so a
 * later scan_config edit never moves a live position's exit. A close
 * fires a `momentum_exit` trigger_event carrying the reason + realized
 * P/L, which flows through the existing dossier/alert pipeline.
 *
 * Non-exiting positions still get their `high_water` advanced so the
 * trailing stop tightens as price runs.
 *
 * Scheduled via netlify.toml, every 5 min 13:00-20:59 UTC weekdays.
 */

interface Rules {
  profit_target_pct: number;
  trail_pct: number;
  hard_stop_pct: number;
  time_stop_days: number;
}

interface OpenPos {
  id: number;
  symbol_id: number;
  entry_ts: string | null;
  entry_trigger_name: string | null;
  entry_date: string;
  entry_price: number | null;
  stop_price: number | null;
  high_water: number | null;
  rules: Rules | null;
  symbols: { ticker: string } | null;
}

type ExitReason = "hard_stop" | "take_profit" | "trail_stop" | "time_stop";

export default async () => {
  const db = getSupabaseAdmin();

  await withJobRun(db, "manage-positions", async () => {
    if (!isLikelyMarketHours()) return { rowsProcessed: 0, result: { open: 0, exited: 0, trailed: 0 } };

    const { data, error } = await db
      .from("shadow_positions")
      .select("id, symbol_id, entry_ts, entry_trigger_name, entry_date, entry_price, stop_price, high_water, rules, symbols(ticker)")
      .eq("status", "open")
      .eq("strategy", "flip");
    if (error) throw error;
    const positions = (data as unknown as OpenPos[] | null) ?? [];
    if (!positions.length) return { rowsProcessed: 0, result: { open: 0, exited: 0, trailed: 0 } };

    const tickers = [...new Set(positions.map((p) => p.symbols?.ticker).filter((t): t is string => !!t))];
    const snapshots = await fetchSnapshots(tickers);

    // Exits post as exit_warning (the feed's Sell column); momentum_exit is
    // only a fallback if that trigger row is ever missing.
    const { data: exitRows } = await db
      .from("triggers")
      .select("id, name")
      .in("name", ["exit_warning", "momentum_exit"]);
    const exitIdByName = new Map(
      ((exitRows as { id: number; name: string }[] | null) ?? []).map((r) => [r.name, r.id]),
    );
    const momentumExitTriggerId = exitIdByName.get("exit_warning") ?? exitIdByName.get("momentum_exit");

    const now = Date.now();
    let exited = 0;
    let trailed = 0;

    for (const pos of positions) {
      const ticker = pos.symbols?.ticker;
      const snap = ticker ? snapshots[ticker] : undefined;
      const price = snap?.latestTrade?.p ?? snap?.dailyBar?.c ?? null;
      const entry = pos.entry_price;
      if (price == null || !(price > 0) || entry == null || !(entry > 0)) continue;

      const rules: Rules = pos.rules ?? {
        profit_target_pct: 0.15,
        trail_pct: 0.1,
        hard_stop_pct: 0.12,
        time_stop_days: 4,
      };
      const hw = Math.max(pos.high_water ?? entry, price);
      const stop = pos.stop_price ?? entry * (1 - rules.hard_stop_pct);
      const heldDays = (now - Date.parse(pos.entry_ts ?? `${pos.entry_date}T00:00:00Z`)) / 86400_000;
      const trailArmed = hw >= entry * (1 + rules.trail_pct);

      let reason: ExitReason | null = null;
      if (price <= stop) reason = "hard_stop";
      else if (price >= entry * (1 + rules.profit_target_pct)) reason = "take_profit";
      else if (trailArmed && price <= hw * (1 - rules.trail_pct)) reason = "trail_stop";
      else if (heldDays > rules.time_stop_days) reason = "time_stop";

      if (!reason) {
        if (hw > (pos.high_water ?? 0)) {
          await db.from("shadow_positions").update({ high_water: round2(hw) }).eq("id", pos.id);
          trailed++;
        }
        continue;
      }

      const pnlPct = price / entry - 1;
      let exitEventId: number | null = null;
      if (momentumExitTriggerId) {
        const { data: ev } = await db
          .from("trigger_events")
          .insert({
            trigger_id: momentumExitTriggerId,
            symbol_id: pos.symbol_id,
            snapshot: {
              shadow_position_id: pos.id,
              entry_trigger_name: pos.entry_trigger_name,
              strategy: "flip",
              entry_date: pos.entry_date,
              entry_price: entry,
              exit_price: price,
              exit_reason: reason,
              pnl_pct: pnlPct,
              days_held: Math.round(heldDays * 10) / 10,
              high_water: round2(hw),
            },
          })
          .select("id")
          .single();
        exitEventId = (ev as { id: number } | null)?.id ?? null;
      }

      await db
        .from("shadow_positions")
        .update({
          status: "closed",
          exit_date: new Date().toISOString().slice(0, 10),
          exit_price: round2(price),
          exit_reason: reason,
          exit_trigger_event_id: exitEventId,
          high_water: round2(hw),
        })
        .eq("id", pos.id);
      exited++;
    }

    return { rowsProcessed: positions.length, result: { open: positions.length, exited, trailed } };
  });

  return new Response("ok");
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ET wall clock (the old UTC 13-21 check was an hour off all winter).
function isLikelyMarketHours(): boolean {
  const now = Date.now();
  const today = etDateString(now);
  const day = new Date(`${today}T12:00:00Z`).getUTCDay();
  if (day < 1 || day > 5) return false;
  const open = etWallClock(today, 9, 30);
  return now >= open && now < open + 390 * 60_000;
}
