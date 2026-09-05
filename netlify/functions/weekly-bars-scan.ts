import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";

/**
 * Populates bars_weekly (one row per symbol per ISO week: open = week's
 * first daily open, high/low = week max/min, close = week's last daily
 * close, volume = week sum) from bars_daily. This is what the backlogged
 * "Multi-Timeframe Trend Agreement" trigger needs (weekly-timeframe
 * bars/EMAs, not just daily) — building it here as pure storage, no new
 * trigger wired up yet.
 *
 * Aggregation runs via public.refresh_bars_weekly() (a Postgres function,
 * not query-builder SQL — same pattern as the existing deep_dive_webhook
 * DB-side logic) so the GROUP BY / "first open, last close within the
 * week" logic lives in one place. It recomputes every week's row from
 * scratch each run, which is cheap at bars_daily's actual size and avoids
 * partial-week edge cases from an incremental approach — this is also
 * how the one-time backfill for existing history gets done, by just
 * running it once after the migration lands.
 *
 * Scheduled via netlify.toml: once weekly, Monday mornings.
 */
export default async () => {
  const db = getSupabaseAdmin();

  await withJobRun(db, "weekly-bars-scan", async () => {
    const { data, error } = await db.rpc("refresh_bars_weekly");
    if (error) throw error;

    return { rowsProcessed: (data as number) ?? 0, result: null };
  });

  return new Response("ok");
};
