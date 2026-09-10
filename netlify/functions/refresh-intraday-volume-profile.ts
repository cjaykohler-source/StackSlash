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
export default async (req?: Request) => {
  const db = getSupabaseAdmin();

  let rebuild = false;
  try {
    if (req && req.method === "POST") rebuild = !!(await req.json())?.rebuild;
  } catch {
    /* no body */
  }

  const result = await withJobRun(db, "refresh-intraday-volume-profile", async () => {
    // {"rebuild": true} does a full recompute from the whole retained
    // window (after a deep backfill); otherwise the nightly incremental
    // EWMA blend of the latest session.
    const { data, error } = await db.rpc(
      rebuild ? "rebuild_intraday_volume_profile" : "refresh_intraday_volume_profile",
    );
    if (error) throw error;
    return { rowsProcessed: Number(data ?? 0), result: { rows: Number(data ?? 0), rebuild } };
  });

  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
};
