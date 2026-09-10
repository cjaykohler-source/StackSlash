import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";

/**
 * Deletes bars_intraday rows older than RETAIN_DAYS. This table is the
 * "Day" chart's 1-min bars AND — since the logic revamp — the history the
 * intraday flip triggers backtest against, so it needs a real window now,
 * not just the trailing week it kept on the free plan (~400 MB at 90 days
 * for the band-symbol coverage, comfortable in Pro's 8 GB).
 *
 * Scheduled via netlify.toml: once daily.
 */
const RETAIN_DAYS = 90;

export default async () => {
  const db = getSupabaseAdmin();

  await withJobRun(db, "prune-bars-intraday", async () => {
    const cutoff = new Date(Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const { error, count } = await db
      .from("bars_intraday")
      .delete({ count: "exact" })
      .lt("ts", cutoff);
    if (error) throw error;

    return { rowsProcessed: count ?? 0, result: { cutoff } };
  });

  return new Response("ok");
};
