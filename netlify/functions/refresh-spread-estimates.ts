import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";

/**
 * Weekly refresh of per-symbol effective spread estimates
 * (`symbol_spread_estimates`), the denominator of every cost-adjusted
 * backtest number. All the work is one Postgres function
 * (`estimate_symbol_spreads()`) running the Corwin-Schultz high-low
 * estimator over the trailing year of `bars_daily`.
 *
 * Weekly rather than nightly because a spread estimate is an average
 * over ~250 sessions — it does not meaningfully move day to day, and the
 * scan is a full pass over a year of bars for ~5,000 symbols.
 *
 * Also POST-triggerable for a one-off, and takes an optional
 * `{"lookbackDays": N}` to widen or narrow the estimation window.
 *
 * **Known limitation, read before trusting these numbers precisely:**
 * on this universe Corwin-Schultz returns ~1.0% almost uniformly across
 * every price bucket (sub-$1 through $20+), which is not credible as a
 * spread — % spread should widen sharply as price and liquidity fall.
 * The estimator is picking up intraday volatility alongside spread, and
 * these names are volatile and gap constantly. Treat the output as
 * order-of-magnitude ("costs here are ~1%, not ~0.05%"), which is enough
 * to sink an 0.5% edge and therefore enough to make the decision it is
 * being used for. Calibrating against real sampled quotes is the
 * outstanding work — see item 2 of docs/measurement-rebuild-plan.md.
 */
export default async (req?: Request) => {
  const db = getSupabaseAdmin();

  let lookbackDays = 380;
  if (req && req.method === "POST") {
    try {
      const body = (await req.json()) as { lookbackDays?: number };
      if (body.lookbackDays) lookbackDays = body.lookbackDays;
    } catch {
      // no body is fine — use the default window
    }
  }

  const result = await withJobRun(db, "refresh-spread-estimates", async () => {
    const { data, error } = await db.rpc("estimate_symbol_spreads", { lookback_days: lookbackDays });
    if (error) throw error;
    return { rowsProcessed: Number(data ?? 0), result: { symbolsEstimated: Number(data ?? 0), lookbackDays } };
  });

  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
};
