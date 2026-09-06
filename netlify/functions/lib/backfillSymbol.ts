import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchDailyBars, fetchIntradayBars } from "./alpaca";

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

/**
 * Backfills bars_intraday for a single symbol's most recent trading day
 * (found from bars_daily, which backfillSymbolBars should already have
 * populated) — without this, a symbol added via search has zero
 * intraday history until the next scheduled intraday-bars-scan run
 * during market hours, so its "Day" chart falls back to an empty state
 * even though SymbolDetail.tsx's "last open session" logic works fine
 * for every already-tracked symbol. Same row shape and upsert target as
 * intraday-bars-scan.ts, using fetchIntradayBars — built earlier in this
 * project's history but, until now, only ever called by that one
 * scheduled job.
 */
export async function backfillLatestIntradaySession(
  db: SupabaseClient,
  symbolId: number,
  ticker: string,
): Promise<number> {
  const { data: latestDaily, error: latestErr } = await db
    .from("bars_daily")
    .select("date")
    .eq("symbol_id", symbolId)
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestErr) throw latestErr;
  if (!latestDaily) return 0;

  const date = (latestDaily as { date: string }).date;
  const rows: { symbol_id: number; ts: string; price: number; volume: number }[] = [];
  let pageToken: string | undefined;
  do {
    const { bars, nextPageToken } = await fetchIntradayBars([ticker], date, pageToken);
    const tickerBars = bars[ticker] ?? [];
    for (const b of tickerBars) {
      rows.push({ symbol_id: symbolId, ts: b.t, price: b.c, volume: b.v });
    }
    pageToken = nextPageToken ?? undefined;
  } while (pageToken);

  if (rows.length) {
    const { error: upsertErr } = await db.from("bars_intraday").upsert(rows, { onConflict: "symbol_id,ts" });
    if (upsertErr) throw upsertErr;
  }
  return rows.length;
}
