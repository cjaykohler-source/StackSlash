/**
 * Financial Modeling Prep client. Free/Starter tier — used for the
 * earnings calendar, company profiles, and per-symbol earnings-surprise
 * history. Everything else in this project is Alpaca; FMP is the one
 * fundamentals source.
 *
 * Needs FMP_API_KEY in the environment (repo-root .env for local runs,
 * Netlify env for deployed functions).
 */

const BASE = "https://financialmodelingprep.com/api/v3";

function key(): string {
  const k = process.env.FMP_API_KEY;
  if (!k) throw new Error("Missing FMP_API_KEY env var.");
  return k;
}

async function get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const qs = new URLSearchParams({ ...params, apikey: key() });
  const url = `${BASE}${path}?${qs.toString()}`;
  let lastErr: string | undefined;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url);
    if (res.ok) return (await res.json()) as T;
    if (res.status === 429) {
      lastErr = "rate limited";
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      continue;
    }
    throw new Error(`FMP ${path} failed: ${res.status} ${await res.text()}`);
  }
  throw new Error(`FMP ${path} failed: ${lastErr} (exhausted retries)`);
}

export interface FmpEarning {
  symbol: string;
  date: string; // YYYY-MM-DD
  epsActual: number | null;
  epsEstimated: number | null;
  revenueActual: number | null;
  revenueEstimated: number | null;
  time: string | null; // "bmo" | "amc" | ""
  updatedFromDate?: string;
  fiscalDateEnding?: string;
}

/** Every company reporting between `from` and `to` (YYYY-MM-DD). One call
 *  covers the whole market for the range. */
export function fetchEarningsCalendar(from: string, to: string): Promise<FmpEarning[]> {
  return get<FmpEarning[]>("/earning_calendar", { from, to });
}

export interface FmpProfile {
  symbol: string;
  companyName: string | null;
  sector: string | null;
  industry: string | null;
  mktCap: number | null;
  price: number | null;
  volAvg: number | null;
  isEtf: boolean;
  isActivelyTrading: boolean;
  description: string | null;
}

/** Company profiles for up to ~50 tickers per call (comma-separated). */
export function fetchProfiles(tickers: string[]): Promise<FmpProfile[]> {
  if (!tickers.length) return Promise.resolve([]);
  return get<FmpProfile[]>(`/profile/${tickers.join(",")}`);
}

export interface FmpSurprise {
  symbol: string;
  date: string;
  actualEarningResult: number | null;
  estimatedEarning: number | null;
}

/** Historical actual-vs-estimate EPS for one symbol — used to compute SUE
 *  (surprise normalized by the dispersion of the symbol's past surprises). */
export function fetchEarningsSurprises(ticker: string): Promise<FmpSurprise[]> {
  return get<FmpSurprise[]>(`/earnings-surprises/${ticker}`);
}
