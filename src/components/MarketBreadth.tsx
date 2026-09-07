import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

interface Breadth {
  pctAbove200dma: number | null;
  advancers: number;
  decliners: number;
  unchanged: number;
  avgRet1w: number | null;
}

function pct(v: number, decimals = 1): string {
  return `${(v * 100).toFixed(decimals)}%`;
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
export function MarketBreadth() {
  const [breadth, setBreadth] = useState<Breadth | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);

      const { data: spy } = await supabase.from("symbols").select("id").eq("ticker", "SPY").maybeSingle();
      if (!spy || cancelled) {
        setLoading(false);
        return;
      }

      const { data: spyDates } = await supabase
        .from("bars_daily")
        .select("date")
        .eq("symbol_id", spy.id)
        .order("date", { ascending: false })
        .limit(2);
      const dates = (spyDates as { date: string }[] | null)?.map((d) => d.date) ?? [];
      if (dates.length < 2 || cancelled) {
        setLoading(false);
        return;
      }
      const [latest, prior] = dates;

      const [factorRes, barsRes] = await Promise.all([
        supabase.from("factor_state").select("symbol_id, dist_sma200, ret_1w"),
        supabase.from("bars_daily").select("symbol_id, date, close").in("date", [latest, prior]),
      ]);
      if (cancelled) return;

      const factorRows =
        (factorRes.data as { symbol_id: number; dist_sma200: number | null; ret_1w: number | null }[] | null) ?? [];
      const above200 = factorRows.filter((r) => r.dist_sma200 !== null && r.dist_sma200 > 0).length;
      const withDist = factorRows.filter((r) => r.dist_sma200 !== null).length;
      const ret1wValues = factorRows.map((r) => r.ret_1w).filter((v): v is number => v !== null);
      const avgRet1w = ret1wValues.length ? ret1wValues.reduce((a, b) => a + b, 0) / ret1wValues.length : null;

      const barsRows = (barsRes.data as { symbol_id: number; date: string; close: number }[] | null) ?? [];
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

      setBreadth({
        pctAbove200dma: withDist > 0 ? above200 / withDist : null,
        advancers,
        decliners,
        unchanged,
        avgRet1w,
      });
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) return <div className="market-breadth empty-state">Loading market breadth…</div>;
  if (!breadth) return null;

  const netAdvancers = breadth.advancers - breadth.decliners;

  return (
    <div className="market-breadth">
      <div className="market-breadth-metric">
        <span className="market-breadth-label">Above 200DMA</span>
        <span className="market-breadth-value">
          {breadth.pctAbove200dma !== null ? pct(breadth.pctAbove200dma) : "—"}
        </span>
      </div>
      <div className="market-breadth-metric">
        <span className="market-breadth-label">Advancers / Decliners</span>
        <span className={`market-breadth-value ${netAdvancers > 0 ? "up" : netAdvancers < 0 ? "down" : ""}`}>
          {breadth.advancers} / {breadth.decliners}
        </span>
      </div>
      <div className="market-breadth-metric">
        <span className="market-breadth-label">Avg 1-Week Return</span>
        <span className={`market-breadth-value ${(breadth.avgRet1w ?? 0) > 0 ? "up" : (breadth.avgRet1w ?? 0) < 0 ? "down" : ""}`}>
          {breadth.avgRet1w !== null ? pct(breadth.avgRet1w) : "—"}
        </span>
      </div>
    </div>
  );
}
