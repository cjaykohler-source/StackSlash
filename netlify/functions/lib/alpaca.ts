/**
 * Minimal Alpaca Market Data client. Paper and live API keys both work
 * against this — data access is identical on the free/IEX tier regardless
 * of account type. See: https://docs.alpaca.markets/reference/stockbars
 */

function dataBaseUrl(): string {
  const url = process.env.ALPACA_BASE_URL;
  if (!url) {
    throw new Error("Missing ALPACA_BASE_URL env var.");
  }
  return url;
}

function authHeaders(): HeadersInit {
  const keyId = process.env.ALPACA_API_KEY_ID;
  const secret = process.env.ALPACA_API_SECRET_KEY;
  if (!keyId || !secret) {
    throw new Error("Missing ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY env vars.");
  }
  return {
    "APCA-API-KEY-ID": keyId,
    "APCA-API-SECRET-KEY": secret,
  };
}

export interface DailyBar {
  t: string; // RFC-3339 timestamp
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

async function fetchBars(
  symbols: string[],
  timeframe: string,
  start: string,
  end: string,
  pageToken?: string,
): Promise<{ bars: Record<string, DailyBar[]>; nextPageToken: string | null }> {
  const params = new URLSearchParams({
    symbols: symbols.join(","),
    timeframe,
    start,
    end,
    adjustment: "split",
    feed: "iex",
    limit: "1000",
  });
  if (pageToken) params.set("page_token", pageToken);

  const res = await fetch(`${dataBaseUrl()}/v2/stocks/bars?${params.toString()}`, {
    headers: authHeaders(),
  });

  if (!res.ok) {
    throw new Error(`Alpaca bars request failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as {
    bars: Record<string, DailyBar[]>;
    next_page_token: string | null;
  };

  return { bars: json.bars ?? {}, nextPageToken: json.next_page_token ?? null };
}

/**
 * Fetch daily bars for a batch of symbols over a date range.
 * Alpaca's v2 bars endpoint accepts a comma-separated symbol list and
 * paginates via next_page_token — this handles one page fetch; callers
 * should loop on next_page_token for large universes/date ranges.
 */
// Alpaca's trading/broker API — a different host than dataBaseUrl()'s
// market-data host. Hardcoded to the paper host rather than a new env
// var: this project is paper-only by design throughout (see every other
// function's own comments), and the assets endpoint is paper/live-
// specific in a way the market-data API isn't.
const TRADING_BASE_URL = "https://paper-api.alpaca.markets";

/**
 * Checks whether a ticker is a real, currently-tradable US equity —
 * used when a user searches for a symbol not yet in our `symbols` table,
 * before adding it and pulling history. Deliberately conservative: only
 * true for an exact-symbol match that Alpaca marks tradable AND
 * class="us_equity" (excludes crypto/OTC/etc. this project isn't built
 * for), same check used (via manual curl) to validate the S&P 500 seed
 * list earlier in this project's history.
 */
export async function validateSymbol(ticker: string): Promise<boolean> {
  const res = await fetch(`${TRADING_BASE_URL}/v2/assets/${encodeURIComponent(ticker)}`, {
    headers: authHeaders(),
  });
  if (res.status === 404) return false;
  if (!res.ok) {
    throw new Error(`Alpaca asset lookup failed: ${res.status} ${await res.text()}`);
  }
  const asset = (await res.json()) as { tradable?: boolean; class?: string };
  return asset.tradable === true && asset.class === "us_equity";
}

export async function fetchDailyBars(
  symbols: string[],
  start: string, // YYYY-MM-DD
  end: string, // YYYY-MM-DD
  pageToken?: string,
): Promise<{ bars: Record<string, DailyBar[]>; nextPageToken: string | null }> {
  return fetchBars(symbols, "1Day", start, end, pageToken);
}

/**
 * Fetch 1-minute bars for a single calendar date (YYYY-MM-DD). Not
 * currently called anywhere — kept ready for whenever the "Day" chart
 * range gets built (needs a scheduled job to populate bars_intraday,
 * deferred for now; see the range-toggle UI's empty-state handling in
 * SymbolDetail.tsx). Requesting the full 00:00-24:00 UTC span and letting
 * Alpaca return only what actually traded is simpler than computing the
 * exact market-open/close times (and their DST shifts) ourselves.
 */
export async function fetchIntradayBars(
  symbols: string[],
  date: string, // YYYY-MM-DD
  pageToken?: string,
): Promise<{ bars: Record<string, DailyBar[]>; nextPageToken: string | null }> {
  return fetchBars(symbols, "1Min", date, date, pageToken);
}

/** Latest trade/quote snapshot for a batch of symbols — used by intraday-scan. */
export async function fetchSnapshots(
  symbols: string[],
): Promise<Record<string, { latestTrade: { p: number; t: string } | null; dailyBar: DailyBar | null }>> {
  const params = new URLSearchParams({ symbols: symbols.join(","), feed: "iex" });
  const res = await fetch(`${dataBaseUrl()}/v2/stocks/snapshots?${params.toString()}`, {
    headers: authHeaders(),
  });

  if (!res.ok) {
    throw new Error(`Alpaca snapshots request failed: ${res.status} ${await res.text()}`);
  }

  const json = (await res.json()) as Record<
    string,
    { latestTrade?: { p: number; t: string }; dailyBar?: DailyBar }
  >;

  const out: Record<string, { latestTrade: { p: number; t: string } | null; dailyBar: DailyBar | null }> = {};
  for (const [sym, snap] of Object.entries(json)) {
    out[sym] = { latestTrade: snap.latestTrade ?? null, dailyBar: snap.dailyBar ?? null };
  }
  return out;
}
