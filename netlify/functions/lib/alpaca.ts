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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  const url = `${dataBaseUrl()}/v2/stocks/bars?${params.toString()}`;

  // A single 429 used to abort the whole scan outright, throwing away
  // every chunk already fetched in that run — confirmed happening for
  // real once the active universe grew past ~500 symbols (more
  // concurrent chunks means more requests in the same window against
  // Alpaca's per-account rate limit). Retries with backoff on 429 only;
  // any other non-OK status still fails fast since that's a real error,
  // not a transient limit.
  let lastError: string | undefined;
  // 8 attempts, backoff capped at 20s → ~90s of total patience. Alpaca's
  // free tier is 200 req/min and the scheduled jobs alone can sit near
  // that during market hours; a burst from eod-scan / backfill needs to
  // ride out more than a few seconds of 429s at the ~5,000-symbol scale.
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(url, { headers: authHeaders() });
    if (res.ok) {
      const json = (await res.json()) as {
        bars: Record<string, DailyBar[]>;
        next_page_token: string | null;
      };
      return { bars: json.bars ?? {}, nextPageToken: json.next_page_token ?? null };
    }
    if (res.status !== 429) {
      throw new Error(`Alpaca bars request failed: ${res.status} ${await res.text()}`);
    }
    lastError = await res.text();
    await sleep(Math.min(2 ** attempt * 1000, 20_000));
  }
  throw new Error(`Alpaca bars request failed: 429 ${lastError} (exhausted retries)`);
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
export interface AssetLookup {
  valid: boolean;
  /** Company name from Alpaca's own asset record — same lookup this
   *  already had to make to validate the ticker, so onboarding a new
   *  symbol can populate symbols.name for free. */
  name: string | null;
}

export async function validateSymbol(ticker: string): Promise<AssetLookup> {
  const res = await fetch(`${TRADING_BASE_URL}/v2/assets/${encodeURIComponent(ticker)}`, {
    headers: authHeaders(),
  });
  if (res.status === 404) return { valid: false, name: null };
  if (!res.ok) {
    throw new Error(`Alpaca asset lookup failed: ${res.status} ${await res.text()}`);
  }
  const asset = (await res.json()) as { tradable?: boolean; class?: string; name?: string };
  return {
    valid: asset.tradable === true && asset.class === "us_equity",
    name: asset.name ?? null,
  };
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

/** 1-minute bars over a date range — used by session-bars.ts to grab the
 *  most recent trading session for a symbol on demand. */
export async function fetchIntradayBarsRange(
  symbols: string[],
  start: string, // YYYY-MM-DD
  end: string, // YYYY-MM-DD
  pageToken?: string,
): Promise<{ bars: Record<string, DailyBar[]>; nextPageToken: string | null }> {
  return fetchBars(symbols, "1Min", start, end, pageToken);
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
