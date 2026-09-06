import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchDailyBars } from "./alpaca";

/**
 * Paginated daily-bar backfill for a single symbol, upserted into
 * bars_daily. Extracted from backfill-history.ts so both the manual
 * bulk-backfill job and on-demand single-symbol onboarding (searching for
 * a symbol not yet tracked) share the exact same tested fetch/upsert
 * logic instead of two copies drifting apart.
 *
 * One symbol at a time rather than eod-scan's 100-per-request chunking:
 * a 5+ year daily-bar history per symbol can span many pages, and doing
 * that for many symbols concurrently in one request makes failures
 * harder to isolate and retry. Fine here since this isn't a daily job.
 */
export async function backfillSymbolBars(
  db: SupabaseClient,
  symbolId: number,
  ticker: string,
  start: string, // YYYY-MM-DD
  end: string, // YYYY-MM-DD
): Promise<number> {
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

  return rowsForSymbol;
}
