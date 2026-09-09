import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";

/**
 * Nightly refresh of `factor_window_stats` — the trailing-window metric
 * table the Isolator screener reads. All the heavy lifting is a single
 * Postgres function (`refresh_factor_window_stats()`), which recomputes
 * every metric from `bars_daily` OHLCV; this handler just invokes it with
 * the service-role key (the function is SECURITY DEFINER and granted only
 * to `service_role`).
 *
 * Scheduled after eod-scan has upserted the day's bars (netlify.toml).
 * Also POST-triggerable for a one-off run.
 */
export default async (_req?: Request) => {
  const db = getSupabaseAdmin();

  const result = await withJobRun(db, "refresh-window-stats", async () => {
    const { data, error } = await db.rpc("refresh_factor_window_stats");
    if (error) throw error;
    return { rowsProcessed: Number(data ?? 0), result: { rowsUpserted: Number(data ?? 0) } };
  });

  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
};
