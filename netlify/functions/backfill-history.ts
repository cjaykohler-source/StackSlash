import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { backfillSymbolBars } from "./lib/backfillSymbol";
import { mapWithConcurrency } from "./lib/concurrency";

/**
 * One-time (or as-needed) deep historical backfill for the 5-Year chart
 * range. eod-scan only ever fetches ~400 days — enough for the Year range
 * and for computing 12-1 momentum — so this exists separately rather than
 * just widening eod-scan's window, since refetching 5 years of bars on
 * every daily run would be wasteful; this only needs to run once per
 * symbol (or again if a new symbol is added).
 *
 * HTTP-triggered, not scheduled — call manually:
 *   curl -X POST https://<site>/.netlify/functions/backfill-history
 *   curl -X POST .../backfill-history -d '{"tickers":["AAPL"]}'  (subset)
 *
 * Defaults to exactly 5 years back. Confirmed empirically that the
 * free-tier IEX feed's actual history only goes back to ~2020-09 anyway
 * (requests before that return empty, not an error) — a "Lifetime" range
 * was considered and dropped for now since it wouldn't mean much more
 * than 5-Year already does on this feed; revisit if the data plan changes.
 */
export default async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const db = getSupabaseAdmin();
  let body: { tickers?: string[]; start?: string } = {};
  try {
    body = await req.json();
  } catch {
    // no body is fine — defaults to all active symbols
  }

  const fiveYearsAgo = new Date();
  fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
  const start = body.start ?? fiveYearsAgo.toISOString().slice(0, 10);
  const end = new Date().toISOString().slice(0, 10);

  const result = await withJobRun(db, "backfill-history", async () => {
    // Paginated — a plain select caps at PostgREST's ~1000-row limit,
    // which silently left ~4,000 of the ~5,000-symbol universe with only
    // the recent (post-prune) window and no deep history. Same cap bug
    // already hit twice elsewhere in this project.
    const symbols: { id: number; ticker: string }[] = [];
    for (let from = 0; ; from += 1000) {
      let q = db.from("symbols").select("id, ticker").eq("active", true).range(from, from + 999);
      if (body.tickers?.length) q = q.in("ticker", body.tickers);
      const { data, error } = await q;
      if (error) throw error;
      if (!data?.length) break;
      symbols.push(...(data as { id: number; ticker: string }[]));
      if (data.length < 1000) break;
    }
    if (!symbols.length)
      return { rowsProcessed: 0, result: { symbols: 0, withDeepHistory: 0, failureCount: 0, failures: [] as string[] } };

    let totalRows = 0;
    let withDeepHistory = 0;
    let done = 0;
    const failures: string[] = [];

    // Bounded concurrency — 5,000 sequential per-symbol pulls is ~40 min
    // and 429s; the fetchBars retry rides out the rest.
    await mapWithConcurrency(symbols, 4, async (s) => {
      try {
        const n = await backfillSymbolBars(db, s.id, s.ticker, start, end);
        totalRows += n;
        if (n > 400) withDeepHistory++; // more than the ~400-day recent window => real 5yr pull
      } catch (err) {
        failures.push(`${s.ticker}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (++done % 250 === 0) console.log(`backfill-history: ${done}/${symbols.length}, ${totalRows} rows`);
    });

    return {
      rowsProcessed: totalRows,
      result: {
        symbols: symbols.length,
        withDeepHistory,
        failureCount: failures.length,
        failures: failures.slice(0, 20),
      },
    };
  });

  return new Response(JSON.stringify({ start, end, ...result }), {
    headers: { "Content-Type": "application/json" },
  });
};
