import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { fetchDailyBars } from "./lib/alpaca";

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

    // One symbol at a time rather than the 100-per-request chunking
    // eod-scan uses: a 5+ year daily-bar history per symbol can span many
    // pages, and doing that for 100 symbols concurrently in one request
    // makes failures harder to isolate and retry. This runs once, not
    // daily, so the extra requests are a non-issue against the 200/min
    // Alpaca budget.
    for (const ticker of tickers) {
      const symbolId = byTicker.get(ticker);
      if (!symbolId) continue;

      let pageToken: string | undefined;
      let rowsForSymbol = 0;
      do {
        const { bars, nextPageToken } = await fetchDailyBars([ticker], start, end, pageToken);
        const tickerBars = bars[ticker] ?? [];
        if (tickerBars.length) {
          const rows = tickerBars.map((b) => ({
            symbol_id: symbolId,
            date: b.t.slice(0, 10),
            open: b.o,
            high: b.h,
            low: b.l,
            close: b.c,
            volume: b.v,
          }));
          const { error } = await db.from("bars_daily").upsert(rows, { onConflict: "symbol_id,date" });
          if (error) throw error;
          rowsForSymbol += rows.length;
        }
        pageToken = nextPageToken ?? undefined;
      } while (pageToken);

      perSymbol[ticker] = rowsForSymbol;
      totalRows += rowsForSymbol;
    }

    return { rowsProcessed: totalRows, result: { perSymbol } };
  });

  return new Response(JSON.stringify({ start, end, ...result }), {
    headers: { "Content-Type": "application/json" },
  });
};
