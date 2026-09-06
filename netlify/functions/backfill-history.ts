import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { backfillSymbolBars } from "./lib/backfillSymbol";

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
    let symbolsQuery = db.from("symbols").select("id, ticker").eq("active", true);
    if (body.tickers?.length) {
      symbolsQuery = symbolsQuery.in("ticker", body.tickers);
    }
    const { data: symbols, error: symErr } = await symbolsQuery;
    if (symErr) throw symErr;
    if (!symbols?.length) return { rowsProcessed: 0, result: { perSymbol: {} } };

    const byTicker = new Map(symbols.map((s) => [s.ticker, s.id] as const));
    const tickers = symbols.map((s) => s.ticker);

    let totalRows = 0;
    const perSymbol: Record<string, number> = {};

    for (const ticker of tickers) {
      const symbolId = byTicker.get(ticker);
      if (!symbolId) continue;

      const rowsForSymbol = await backfillSymbolBars(db, symbolId, ticker, start, end);
      perSymbol[ticker] = rowsForSymbol;
      totalRows += rowsForSymbol;
    }

    return { rowsProcessed: totalRows, result: { perSymbol } };
  });

  return new Response(JSON.stringify({ start, end, ...result }), {
    headers: { "Content-Type": "application/json" },
  });
};
