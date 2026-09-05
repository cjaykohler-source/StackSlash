import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";

/**
 * Deletes trigger_evaluations rows older than 7 days, unconditionally —
 * this is the per-run pass/fail log (every trigger x every symbol,
 * whether or not it fired), not the history of actual fires. Nothing
 * downstream reads old rows here: trigger_stats is recomputed fresh from
 * bars_daily via dailySnapshot.ts (backtest-triggers.ts), and real fires
 * live separately in trigger_events, untouched by this. Without pruning,
 * this table grows unbounded on every eod-scan/intraday-scan run — the
 * single biggest storage cost after bars_intraday at S&P-500 scale.
 *
 * Scheduled via netlify.toml: once daily, alongside eod-scan.
 */
export default async () => {
  const db = getSupabaseAdmin();

  await withJobRun(db, "prune-trigger-evaluations", async () => {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { error, count } = await db
      .from("trigger_evaluations")
      .delete({ count: "exact" })
      .lt("ts", cutoff);
    if (error) throw error;

    return { rowsProcessed: count ?? 0, result: { cutoff } };
  });

  return new Response("ok");
};
