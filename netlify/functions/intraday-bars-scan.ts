import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { fetchIntradayBars } from "./lib/alpaca";

/**
 * Populates bars_intraday for today, for the whole active universe — this
 * is what the "Day" chart range needs. Deliberately separate from
 * intraday-scan.ts: that function evaluates technical triggers only on
 * the momentum-filtered candidate set (by design, per the Tier-2 entry-
 * timing model), but a chart should work for any symbol on the symbol
 * detail page, not just current candidates. Two different jobs, two
 * different audiences, sharing nothing but roughly the same cadence.
 *
 * Re-fetches the whole trading day on every run rather than only new
 * bars since the last poll — simpler, and the upsert makes it idempotent.
 * A useful side effect: running this once manually also backfills
 * "today" in one shot, since it always asks for the full day up to now.
 *
 * Scheduled via netlify.toml, every 5 minutes during market hours.
 */
export default async () => {
  const db = getSupabaseAdmin();

  await withJobRun(db, "intraday-bars-scan", async () => {
    const { data: symbols, error: symErr } = await db
      .from("symbols")
      .select("id, ticker")
      .eq("active", true);
    if (symErr) throw symErr;
    if (!symbols?.length) return { rowsProcessed: 0, result: null };

    const byTicker = new Map(symbols.map((s) => [s.ticker, s.id] as const));
    const tickers = symbols.map((s) => s.ticker);

    const today = new Date().toISOString().slice(0, 10);
    const rows: Record<string, unknown>[] = [];

    const chunkSize = 100;
    for (let i = 0; i < tickers.length; i += chunkSize) {
      const chunk = tickers.slice(i, i + chunkSize);
      let pageToken: string | undefined;
      do {
        const { bars, nextPageToken } = await fetchIntradayBars(chunk, today, pageToken);
        for (const [ticker, tickerBars] of Object.entries(bars)) {
          const symbolId = byTicker.get(ticker);
          if (!symbolId) continue;
          for (const b of tickerBars) {
            rows.push({ symbol_id: symbolId, ts: b.t, price: b.c, volume: b.v });
          }
        }
        pageToken = nextPageToken ?? undefined;
      } while (pageToken);
    }

    if (rows.length) {
      const { error } = await db.from("bars_intraday").upsert(rows, { onConflict: "symbol_id,ts" });
      if (error) throw error;
    }

    return { rowsProcessed: rows.length, result: null };
  });

  return new Response("ok");
};

// Schedule is configured in netlify.toml under [functions."intraday-bars-scan"].
