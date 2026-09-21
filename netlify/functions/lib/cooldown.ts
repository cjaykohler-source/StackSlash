import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Filters a batch of candidate fires down to only those NOT within their
 * trigger's own cooldown_minutes of the most recent trigger_event for
 * the same (symbol_id, trigger_id) pair.
 *
 * Both eod-scan.ts and intraday-scan.ts previously inserted every fire
 * unconditionally — a comment in eod-scan.ts claimed "cooldown check
 * happens per-fire" but no such check existed in the code. Confirmed
 * the real-world impact directly: repeated manual eod-scan invocations
 * (each onboard-symbol call re-runs the full scan) produced 6 identical
 * redundant trigger_events/dossiers for the same signal on dozens of
 * symbols, 125 of which had already gone out as real Discord alerts —
 * cleaned up in a one-time migration, but the actual bug was here.
 */
export async function filterByCooldown<
  T extends { trigger_id: number; symbol_id: number },
>(db: SupabaseClient, fires: T[], cooldownMinutesByTriggerId: Map<number, number>): Promise<T[]> {
  if (!fires.length) return [];

  const triggerIds = [...new Set(fires.map((f) => f.trigger_id))];
  const maxCooldownMinutes = Math.max(0, ...triggerIds.map((id) => cooldownMinutesByTriggerId.get(id) ?? 0));
  if (maxCooldownMinutes === 0) return fires;

  const cutoff = new Date(Date.now() - maxCooldownMinutes * 60 * 1000).toISOString();
  // Paginated with an explicit order. PostgREST caps an unordered select at
  // 1,000 rows and silently drops the rest (HANDOFF section 3; six
  // documented instances of this family here). Truncation would lose
  // last-fire rows, and a missing last fire reads as "never fired" -- i.e.
  // duplicate Discord alerts, the exact bug this file exists to prevent.
  // The longest fast-trigger cooldown is 1,440 minutes, so this pulls a
  // full day of events; at ~25-40 alerts/day it is far under the cap today.
  const rows: { trigger_id: number; symbol_id: number; ts: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("trigger_events")
      .select("trigger_id, symbol_id, ts")
      .in("trigger_id", triggerIds)
      .gte("ts", cutoff)
      .order("ts", { ascending: false })
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...((data as { trigger_id: number; symbol_id: number; ts: string }[] | null) ?? []));
    if (!data || data.length < 1000) break;
  }

  const lastFireByKey = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.trigger_id}:${row.symbol_id}`;
    const ts = new Date(row.ts).getTime();
    const existing = lastFireByKey.get(key);
    if (existing === undefined || ts > existing) lastFireByKey.set(key, ts);
  }

  const now = Date.now();
  return fires.filter((f) => {
    const key = `${f.trigger_id}:${f.symbol_id}`;
    const lastFireMs = lastFireByKey.get(key);
    if (lastFireMs === undefined) return true;
    const cooldownMs = (cooldownMinutesByTriggerId.get(f.trigger_id) ?? 0) * 60 * 1000;
    return now - lastFireMs >= cooldownMs;
  });
}
