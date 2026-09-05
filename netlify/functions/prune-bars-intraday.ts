import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";

/**
 * Deletes bars_intraday rows older than 7 days. This table is the "Day"
 * chart range's 1-min bars for the whole active universe — it only ever
 * needs the trailing week, and with no retention it would grow ~84 KB per
 * symbol per trading day forever (measured, not estimated). Longer-term
 * trend context comes from bars_daily/bars_weekly instead, so pruning
 * this doesn't lose anything those need.
 *
 * Scheduled via netlify.toml: once daily, alongside eod-scan.
 */
export default async () => {
  const db = getSupabaseAdmin();

  await withJobRun(db, "prune-bars-intraday", async () => {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { error, count } = await db
      .from("bars_intraday")
      .delete({ count: "exact" })
      .lt("ts", cutoff);
    if (error) throw error;

    return { rowsProcessed: count ?? 0, result: { cutoff } };
  });

  return new Response("ok");
};
