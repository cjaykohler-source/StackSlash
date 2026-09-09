/**
 * Financial Modeling Prep client — the `/stable/` API (the legacy `/v3/`
 * endpoints stopped serving accounts created after Aug 2025).
 *
 * FMP is the one fundamentals source in this project; everything else is
 * Alpaca. Needs FMP_API_KEY in the environment (repo-root .env for local
 * runs, Netlify env for deployed functions).
 *
 * Free-tier reality (see README "Fundamentals"):
 *  - /stable/profile?symbol=X   — works for any symbol, ONE per call
 *                                 (the comma-separated batch form returns []).
 *  - /stable/earnings-calendar  — works with NO params: a trailing ~3-month
 *                                 window of REPORTED quarters. `from`/`to`
 *                                 are a premium parameter; there is no
 *                                 forward calendar on this tier.
 *  - /stable/earnings?symbol=X  — restricted (demo symbols only).
 *  - bulk / historical earnings — restricted.
 *
 * So: real sector/industry/market-cap/ETF tags (profile), plus awareness
 * of quarters a symbol *already* reported (calendar). No "earnings in N
 * days" lookahead.
 */

const BASE = "https://financialmodelingprep.com/stable";

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
  lastUpdated?: string;
}

/**
 * The trailing earnings calendar — one call covers the whole market for
 * FMP's default window (~3 months back). Free tier does not accept
 * `from`/`to`, so this is REPORTED quarters only, no upcoming dates.
 */
export function fetchEarningsCalendarRecent(): Promise<FmpEarning[]> {
  return get<FmpEarning[]>("/earnings-calendar");
}

export interface FmpProfile {
  symbol: string;
  companyName: string | null;
  sector: string | null;
  industry: string | null;
  marketCap: number | null;
  price: number | null;
  averageVolume: number | null;
  isEtf: boolean;
  isFund: boolean;
  isAdr: boolean;
  isActivelyTrading: boolean;
  description: string | null;
}

/**
 * One company profile. The free tier serves this for every symbol but
 * only one per request — `symbol=A,B` returns `[]`, so callers must loop
 * and stay inside their own rate budget.
 */
export async function fetchProfile(ticker: string): Promise<FmpProfile | null> {
  const rows = await get<FmpProfile[]>("/profile", { symbol: ticker });
  return rows[0] ?? null;
}
