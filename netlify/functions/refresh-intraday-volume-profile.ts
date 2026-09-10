import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";

/**
 * Nightly rebuild of `intraday_volume_profile` — trailing-average volume
 * in each regular-session minute per symbol, the denominator for the
 * time-of-day RVOL in lib/intradayFactors.ts.
 *
 * All the work is in the refresh_intraday_volume_profile() Postgres
 * function (one pass over the retained bars_intraday, EWMA-blended into
 * the stored profile so it accumulates a real multi-week average despite
 * the 7-day bars_intraday retention). This is just the scheduled wrapper.
 *
 * Scheduled via netlify.toml, ~23:30 UTC weekdays — after intraday-bars-scan
 * has stopped for the day and prune-bars-intraday has run.
 */
export default async () => {
  const db = getSupabaseAdmin();

  const result = await withJobRun(db, "refresh-intraday-volume-profile", async () => {
    const { data, error } = await db.rpc("refresh_intraday_volume_profile");
    if (error) throw error;
    return { rowsProcessed: Number(data ?? 0), result: { rows: Number(data ?? 0) } };
  });

  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
};
