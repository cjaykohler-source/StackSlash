import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";

/**
 * Keeps bars_daily / bars_weekly to a rolling ~5-year window.
 *
 * Was 18 months on the free 500 MB plan (a full 5-year history for the
 * ~5,000-symbol universe didn't fit). On Pro (8 GB) the full window is
 * back — backtest-triggers now runs on ~4 evaluable years instead of ~8
 * months, and the "5-Year" chart range is real again.
 *
 * Scheduled via netlify.toml. Only DELETEs — space isn't returned to the
 * OS without a VACUUM FULL, but Postgres reuses it, so the table stays
 * roughly flat instead of growing without bound.
 */
const RETAIN_DAYS = 5 * 365 + 30;

export default async () => {
  const db = getSupabaseAdmin();

  await withJobRun(db, "prune-bars-daily", async () => {
    const cutoff = new Date(Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Through an RPC with its own statement timeout: the plain PostgREST
    // DELETE ran under the API role's 8 s limit and timed out on its first
    // attempt most nights (57014), succeeding only on Netlify's retry.
    const { data, error } = await db.rpc("prune_bars_history", { cutoff });
    if (error) throw error;
    const { bars_daily = 0, bars_weekly = 0 } = (data ?? {}) as { bars_daily?: number; bars_weekly?: number };

    return {
      rowsProcessed: bars_daily + bars_weekly,
      result: { cutoff, bars_daily, bars_weekly },
    };
  });

  return new Response("ok");
};
