import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { validateSymbol } from "./lib/alpaca";
import { backfillSymbolBars, backfillLatestIntradaySession } from "./lib/backfillSymbol";
import { fetchAllPaginated } from "./lib/fetchAllPaginated";
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

  // Validate BEFORE opening a job_run. A ticker that doesn't exist is a
  // typo, not a job failure: logging it as one filled job_runs with error
  // rows that look identical to a real breakage (628 stale/failed rows were
  // swept on 2026-09-18, and this was part of the noise).
  const asset = await validateSymbol(ticker);
  if (!asset.valid) {
    const suggestion = await nearestKnownTicker(db, ticker);
    return new Response(
      JSON.stringify({
        error: `${ticker} isn't a valid, currently-tradable US equity symbol.`,
        ...(suggestion ? { suggestion } : {}),
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    const result = await withJobRun(db, "onboard-symbol", async () => {
      const { data: inserted, error: insertErr } = await db
        .from("symbols")
        .upsert({ ticker, name: asset.name, active: true }, { onConflict: "ticker" })
        .select("id")
        .single();
      if (insertErr) throw insertErr;

      const fiveYearsAgo = new Date();
      fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
      const start = fiveYearsAgo.toISOString().slice(0, 10);
      const end = new Date().toISOString().slice(0, 10);
      const rowsBackfilled = await backfillSymbolBars(db, inserted.id, ticker, start, end);

      // Without this, the new symbol's "Day" chart shows an empty state
      // until the next scheduled intraday-bars-scan run during market
      // hours — see the function's own comment.
      await backfillLatestIntradaySession(db, inserted.id, ticker);

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
    // withJobRun already logged this to job_runs — surface a clean 400 to
    // the caller. By here the ticker is known-good, so anything that fails
    // is a real backfill/scan problem worth having in job_runs.
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
};


/**
 * The closest ticker we already carry, for a typo like APPL -> AAPL.
 * One edit away (a swapped, wrong, missing or extra character) and the
 * same first letter, which is what makes a suggestion feel right rather
 * than random. Null when nothing is close enough.
 */
async function nearestKnownTicker(
  db: ReturnType<typeof getSupabaseAdmin>,
  ticker: string,
): Promise<string | null> {
  const n = ticker.length;
  if (n < 2) return null;
  // Same first letter and a length within one keeps this to a few hundred
  // rows; paginated because an unranged select silently caps at 1,000.
  const rows = await fetchAllPaginated<{ ticker: string }>((from, to) =>
    db
      .from("symbols")
      .select("ticker")
      .eq("active", true)
      .like("ticker", `${ticker[0]}%`)
      .order("ticker", { ascending: true })
      .range(from, to),
  );
  let best: string | null = null;
  for (const row of rows) {
    const cand = row.ticker;
    if (cand === ticker) return null; // it exists after all; no suggestion needed
    if (Math.abs(cand.length - n) > 1) continue;
    if (editDistanceWithin1(ticker, cand)) {
      // Prefer the shortest match, then alphabetical, so the answer is stable.
      if (best === null || cand.length < best.length || (cand.length === best.length && cand < best)) best = cand;
    }
  }
  return best;
}

/** True when a and b are at most one edit apart (Damerau: swap counts as one). */
function editDistanceWithin1(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diffs: number[] = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diffs.push(i);
    if (diffs.length === 1) return true; // one substitution
    // one transposition of adjacent characters (APPL vs AAPL)
    if (diffs.length === 2 && diffs[1] === diffs[0] + 1) {
      return a[diffs[0]] === b[diffs[1]] && a[diffs[1]] === b[diffs[0]];
    }
    return false;
  }
  // one insertion or deletion
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i++;
      j++;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    j++;
  }
  return true;
}
