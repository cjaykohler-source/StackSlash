import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { syncFundamentalsFromDolt } from "./lib/fundamentalsDolt";

/**
 * Weekly financial-statement pull from DoltHub. A Netlify *background*
 * function (15-min ceiling, returns 202 immediately) because a full sync
 * paginates ~100 DoltHub requests and runs ~30-60s — well past the 10s
 * sync-function limit.
 *
 * Triggered two ways, both plain POSTs (background functions, unlike
 * scheduled ones, accept direct HTTP):
 *   - the "Refresh financials" button on /settings
 *   - a weekly launchd job on the worker host (Mondays, after DoltHub's
 *     weekend refresh)
 *
 * The caller polls `job_runs` (job_name = 'refresh-fundamentals') for
 * completion.
 */
export default async () => {
  const db = getSupabaseAdmin();
  await withJobRun(db, "refresh-fundamentals", () => syncFundamentalsFromDolt(db));
};
