import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { validateSymbol } from "./lib/alpaca";
import { backfillSymbolBars } from "./lib/backfillSymbol";
import runEodScan from "./eod-scan";

/**
 * On-demand symbol onboarding — HTTP-triggered from the dashboard's
 * search box when a user looks up a ticker not yet in `symbols`.
 *
 * Deliberately does NOT evaluate the new symbol's triggers in isolation:
 * momentum_rank_entry, roc_20d_rank_pct, and ret_1w_rank_pct are
 * cross-sectional percentile ranks computed relative to the whole active
 * universe for that day — ranking one symbol alone would be meaningless
 * (1 of 1 is always the 100th percentile), the same class of bug this
 * project already found and fixed once for the old 8-symbol universe's
 * unreachable momentum thresholds. So after backfilling history, this
 * calls the real eod-scan directly (in-process, no HTTP hop — its
 * default export is a plain callable async function) so the new symbol
 * gets correctly-ranked factors and real trigger evaluation through the
 * exact same pipeline as every other symbol, not a parallel shortcut.
 */
export default async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const db = getSupabaseAdmin();
  let body: { ticker?: string } = {};
  try {
    body = await req.json();
  } catch {
    // handled by the ticker check below
  }

  const ticker = body.ticker?.trim().toUpperCase();
  if (!ticker) {
    return new Response(JSON.stringify({ error: "Missing ticker" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { data: existing, error: existingErr } = await db
    .from("symbols")
    .select("id")
    .eq("ticker", ticker)
    .eq("active", true)
    .maybeSingle();
  if (existingErr) throw existingErr;
  if (existing) {
    return new Response(JSON.stringify({ status: "existing", ticker }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // Guard against overlapping eod-scan runs — nothing else in this
  // codebase prevented two from executing concurrently, and a single
  // retried onboarding request produced exactly that (confirmed via
  // job_runs during this feature's own testing): two eod-scan calls
  // racing on the same bars_daily/factor_state upserts and, worse, both
  // potentially inserting duplicate trigger_events/dossiers/alerts for
  // the same real fires. Time-windowed (not just "any running row")
  // so a genuinely stuck/killed run from a past crash can't permanently
  // block onboarding forever — 3 minutes is comfortably above eod-scan's
  // real duration at full universe scale, even generously.
  const guardCutoff = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  const { data: inFlight, error: inFlightErr } = await db
    .from("job_runs")
    .select("job_name, started_at")
    .in("job_name", ["eod-scan", "onboard-symbol"])
    .eq("status", "running")
    .gte("started_at", guardCutoff)
    .limit(1)
    .maybeSingle();
  if (inFlightErr) throw inFlightErr;
  if (inFlight) {
    return new Response(
      JSON.stringify({ error: "A scan is already in progress — try again in a minute." }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    const result = await withJobRun(db, "onboard-symbol", async () => {
      const valid = await validateSymbol(ticker);
      if (!valid) {
        throw new Error(`${ticker} isn't a valid, currently-tradable US equity symbol.`);
      }

      const { data: inserted, error: insertErr } = await db
        .from("symbols")
        .upsert({ ticker, active: true }, { onConflict: "ticker" })
        .select("id")
        .single();
      if (insertErr) throw insertErr;

      const fiveYearsAgo = new Date();
      fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
      const start = fiveYearsAgo.toISOString().slice(0, 10);
      const end = new Date().toISOString().slice(0, 10);
      const rowsBackfilled = await backfillSymbolBars(db, inserted.id, ticker, start, end);

      // Real eod-scan run across the whole active universe (now including
      // this symbol) — see the module comment for why this isn't scoped to
      // just the new symbol.
      await runEodScan();

      return { rowsProcessed: rowsBackfilled, result: { ticker, rowsBackfilled } };
    });

    return new Response(JSON.stringify({ status: "onboarded", ...result }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    // withJobRun already logged this to job_runs — surface a clean 400
    // to the caller (a bad/untradable ticker is a client error, not a
    // server one) rather than letting it bubble into a generic 500.
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
};
