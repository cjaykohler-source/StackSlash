import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";

/**
 * Keeps bars_daily / bars_weekly to a rolling ~18-month window.
 *
 * The universe is ~5,000 symbols (NYSE + NASDAQ + AMEX common stock) on
 * Supabase's free 500 MB plan — a full 5-year daily history for all of
 * them doesn't fit. 18 months still covers the 252-trading-day lookbacks
 * (12-1 momentum, 200/252-day MAs, vol percentile) with room for a real
 * backtest window; the 5-Year chart range is capped accordingly.
 *
 * Scheduled via netlify.toml: once daily, alongside eod-scan. Only DELETEs
 * — the space isn't returned to the OS without a VACUUM FULL (which can't
 * run on a schedule), but Postgres reuses it, so the table stays roughly
 * flat instead of growing without bound.
 */
const RETAIN_DAYS = 550;

export default async () => {
  const db = getSupabaseAdmin();

  await withJobRun(db, "prune-bars-daily", async () => {
    const cutoff = new Date(Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const daily = await db.from("bars_daily").delete({ count: "exact" }).lt("date", cutoff);
    if (daily.error) throw daily.error;

    const weekly = await db.from("bars_weekly").delete({ count: "exact" }).lt("week_start", cutoff);
    if (weekly.error) throw weekly.error;

    return {
      rowsProcessed: (daily.count ?? 0) + (weekly.count ?? 0),
      result: { cutoff, bars_daily: daily.count ?? 0, bars_weekly: weekly.count ?? 0 },
    };
  });

  return new Response("ok");
};
