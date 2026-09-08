import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { InfoTooltip } from "./InfoTooltip";

const METRIC_INFO = {
  above200dma: "The share of the whole tracked universe currently trading above its own 200-day moving average — broader participation in an uptrend than any single index's own 200DMA status.",
  advDec: "How many of the tracked symbols closed higher versus lower than the prior session — the day's actual tape action across the universe, not just one index.",
  avgRet1w: "The average 1-week return across every tracked symbol — near-term momentum breadth.",
};

interface Breadth {
  pctAbove200dma: number | null;
  advancers: number;
  decliners: number;
  unchanged: number;
  avgRet1w: number | null;
}

// Cached client-side so the dashboard doesn't re-run the whole
// universe-wide breadth computation (a paginated bars_daily sweep plus a
// 5000-row factor_state read) on every single mount. The numbers only
// move once a day when eod-scan runs, so a stale cached read with a
// visible "updated" timestamp and an explicit Refresh button is the
// right default — see the Refresh handler below for the recompute path.
const CACHE_KEY = "stackslash.marketBreadth.v1";

interface CachedBreadth {
  data: Breadth;
  at: string; // ISO timestamp of when it was computed
}

function readCache(): CachedBreadth | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedBreadth;
    if (!parsed || typeof parsed.at !== "string" || !parsed.data) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(entry: CachedBreadth): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // localStorage unavailable (private mode, quota) — non-fatal, the
    // dashboard just falls back to recomputing next mount.
  }
}

function pct(v: number, decimals = 1): string {
  return `${(v * 100).toFixed(decimals)}%`;
}

function formatUpdated(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Cross-sectional breadth across the whole active universe — not just
 * whether SPY alone is above its 200DMA, but how many of the 500+
 * tracked symbols actually are. Complements RegimeBanner's single-index
 * risk-on/off read rather than replacing it; kept as a separate
 * component so RegimeBanner's one job (the kill-switch state) stays
 * undiluted.
 *
 * No new data ingestion — everything here already exists in
 * factor_state/bars_daily. Advance/decline needs two dates' closes
 * compared per symbol, which the frontend does in JS after a plain
 * filtered read (no raw SQL/JOINs available client-side): SPY's own
 * last two bars_daily rows give the two real trading dates to compare
 * (stable calendar reference, same "find the real latest session, don't
 * assume today" principle SymbolDetail's Day chart fallback already
 * uses), then every active symbol's close on each of those two dates is
 * fetched and compared in JS.
 */
async function computeBreadth(): Promise<Breadth | null> {
  const { data: spy } = await supabase.from("symbols").select("id").eq("ticker", "SPY").maybeSingle();
  if (!spy) return null;

  const { data: spyDates } = await supabase
    .from("bars_daily")
    .select("date")
    .eq("symbol_id", spy.id)
    .order("date", { ascending: false })
    .limit(2);
  const dates = (spyDates as { date: string }[] | null)?.map((d) => d.date) ?? [];
  if (dates.length < 2) return null;
  const [latest, prior] = dates;

  // factor_state keeps one row per (symbol, as_of) — a new day's
  // eod-scan run inserts a fresh row rather than overwriting the
  // last one, so fetching without a date filter mixes multiple
  // days together per symbol (confirmed happening: with_dist grew
  // to 1026 across three different as_of dates, not ~510 for one
  // current snapshot — same "find the real latest, don't assume
  // it's the only row" principle SymbolProfile.tsx already applies
  // to its own factor_state read).
  const { data: latestFactorAsOf } = await supabase
    .from("factor_state")
    .select("as_of")
    .order("as_of", { ascending: false })
    .limit(1)
    .maybeSingle();
  const factorAsOf = (latestFactorAsOf as { as_of: string } | null)?.as_of;

  // PostgREST enforces a hard server-side row cap (commonly 1000,
  // a `db-max-rows` config, not a client-overridable default) —
  // confirmed the hard way: even an explicit `.limit(5000)` still
  // came back capped at exactly 1000 rows, silently undercounting
  // advancers/decliners (real data: 180/329; the single-request
  // fetch rendered 178/320). `.limit()` bounds the request from
  // below the cap; it can't raise the cap. Real pagination via
  // `.range()` is required — same pattern already used correctly
  // elsewhere in this codebase (backfill-history.ts,
  // backtest-triggers.ts) for exactly this reason.
  async function fetchAllBarsForDates(): Promise<{ symbol_id: number; date: string; close: number }[]> {
    const PAGE_SIZE = 1000;
    const rows: { symbol_id: number; date: string; close: number }[] = [];
    let from = 0;
    for (;;) {
      const { data, error } = await supabase
        .from("bars_daily")
        .select("symbol_id, date, close")
        .in("date", [latest, prior])
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      if (!data?.length) break;
      rows.push(...(data as { symbol_id: number; date: string; close: number }[]));
      if (data.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }
    return rows;
  }

  const factorQuery = supabase.from("factor_state").select("symbol_id, dist_sma200, ret_1w").limit(5000);
  const [factorRes, barsRows] = await Promise.all([
    factorAsOf ? factorQuery.eq("as_of", factorAsOf) : factorQuery,
    fetchAllBarsForDates(),
  ]);

  const factorRows =
    (factorRes.data as { symbol_id: number; dist_sma200: number | null; ret_1w: number | null }[] | null) ?? [];
  const above200 = factorRows.filter((r) => r.dist_sma200 !== null && r.dist_sma200 > 0).length;
  const withDist = factorRows.filter((r) => r.dist_sma200 !== null).length;
  const ret1wValues = factorRows.map((r) => r.ret_1w).filter((v): v is number => v !== null);
  const avgRet1w = ret1wValues.length ? ret1wValues.reduce((a, b) => a + b, 0) / ret1wValues.length : null;

  const closesBySymbol = new Map<number, { latest?: number; prior?: number }>();
  for (const row of barsRows) {
    const entry = closesBySymbol.get(row.symbol_id) ?? {};
    if (row.date === latest) entry.latest = row.close;
    if (row.date === prior) entry.prior = row.close;
    closesBySymbol.set(row.symbol_id, entry);
  }
  let advancers = 0;
  let decliners = 0;
  let unchanged = 0;
  for (const { latest: l, prior: p } of closesBySymbol.values()) {
    if (l === undefined || p === undefined) continue;
    if (l > p) advancers++;
    else if (l < p) decliners++;
    else unchanged++;
  }

  return {
    pctAbove200dma: withDist > 0 ? above200 / withDist : null,
    advancers,
    decliners,
    unchanged,
    avgRet1w,
  };
}

export function MarketBreadth() {
  const [breadth, setBreadth] = useState<Breadth | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(false);
    try {
      const result = await computeBreadth();
      if (!result) {
        setError(true);
        return;
      }
      const at = new Date().toISOString();
      setBreadth(result);
      setUpdatedAt(at);
      writeCache({ data: result, at });
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const cached = readCache();
    if (cached) {
      // Auto-load the last cached snapshot — no query on mount. A fresh
      // read only happens when the user hits Refresh.
      setBreadth(cached.data);
      setUpdatedAt(cached.at);
      return;
    }
    // Nothing cached yet (first ever visit / cleared storage) — do the
    // one initial compute so the panel isn't empty.
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const netAdvancers = breadth ? breadth.advancers - breadth.decliners : 0;

  return (
    <div className="market-breadth">
      <div className="market-breadth-header">
        <span className="market-breadth-title">Market breadth</span>
        <div className="market-breadth-meta">
          {loading ? (
            <span className="market-breadth-updated">Refreshing…</span>
          ) : updatedAt ? (
            <span className="market-breadth-updated">Updated {formatUpdated(updatedAt)}</span>
          ) : null}
          <button
            type="button"
            className="link-button market-breadth-refresh"
            onClick={refresh}
            disabled={loading}
          >
            Refresh
          </button>
        </div>
      </div>

      {error && !breadth ? (
        <div className="market-breadth-body empty-state">Couldn't load market breadth.</div>
      ) : !breadth ? (
        <div className="market-breadth-body empty-state">Loading market breadth…</div>
      ) : (
        <div className="market-breadth-body">
          {error && <div className="market-breadth-stale">Refresh failed — showing last cached data.</div>}
          <div className="market-breadth-metrics">
            <div className="market-breadth-metric">
              <span className="market-breadth-label">
                <InfoTooltip text={METRIC_INFO.above200dma}>Above 200DMA</InfoTooltip>
              </span>
              <span className="market-breadth-value">
                {breadth.pctAbove200dma !== null ? pct(breadth.pctAbove200dma) : "—"}
              </span>
            </div>
            <div className="market-breadth-metric">
              <span className="market-breadth-label">
                <InfoTooltip text={METRIC_INFO.advDec}>Advancers / Decliners</InfoTooltip>
              </span>
              <span className={`market-breadth-value ${netAdvancers > 0 ? "up" : netAdvancers < 0 ? "down" : ""}`}>
                {breadth.advancers} / {breadth.decliners}
              </span>
            </div>
            <div className="market-breadth-metric">
              <span className="market-breadth-label">
                <InfoTooltip text={METRIC_INFO.avgRet1w}>Avg 1-Week Return</InfoTooltip>
              </span>
              <span className={`market-breadth-value ${(breadth.avgRet1w ?? 0) > 0 ? "up" : (breadth.avgRet1w ?? 0) < 0 ? "down" : ""}`}>
                {breadth.avgRet1w !== null ? pct(breadth.avgRet1w) : "—"}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
