import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { DossierCard } from "../components/DossierCard";
import { SymbolProfile } from "../components/SymbolProfile";
import { CompanyDescription } from "../components/CompanyDescription";
import { useQuotes, type Quote } from "../components/QuoteTag";
import { PriceChart, type PricePoint } from "../components/PriceChart";
import { SymbolNews } from "../components/SymbolNews";
import { sessionAxis, type SessionAxis } from "../lib/marketTime";
import { SessionCandleChart, type Candle } from "../components/SessionCandleChart";
import { BrandHomeLink } from "../components/BrandHomeLink";

type Range = "day" | "session" | "week" | "month" | "year" | "max";

const RANGE_OPTIONS: { key: Range; label: string }[] = [
  { key: "day", label: "Day" },
  { key: "session", label: "Session (candles)" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "year", label: "Year" },
  { key: "max", label: "Max (18mo)" },
];

interface DossierRow {
  id: number;
  ts: string;
  score: number | null;
  analysis: Record<string, unknown>;
}

function rangeStartDate(range: Range): Date {
  const d = new Date();
  switch (range) {
    case "week":
      d.setDate(d.getDate() - 7);
      break;
    case "month":
      d.setDate(d.getDate() - 30);
      break;
    case "year":
      d.setFullYear(d.getFullYear() - 1);
      break;
    case "max":
      d.setFullYear(d.getFullYear() - 3);
      break;
    case "day":
      // handled separately via bars_intraday, not used here
      break;
  }
  return d;
}

// Per design: only Max shows a year label on the x-axis. Year's own
// 12-month window can technically straddle a Dec/Jan boundary, so this
// is a deliberate trade-off (repeating the year on every tick elsewhere
// is noisier than the rare cross-year ambiguity this introduces there).
function formatDateLabel(dateStr: string, range: Range): string {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString(
    [],
    range === "max" ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" },
  );
}

/** Step a YYYY-MM-DD date by `dir` weekdays (skips Sat/Sun; holidays just come back empty). */
function stepWeekday(dateStr: string, dir: 1 | -1): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  do {
    d.setUTCDate(d.getUTCDate() + dir);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

interface SessionCandles {
  session_date: string | null;
  prev_close: number | null;
  delayed?: boolean;
  bars: Candle[];
  error?: string;
}

/**
 * Symbol drill-down: price chart (range-toggleable) + dossiers (the
 * "why it fired" explanations from the deep-dive worker) for that symbol.
 *
 * Day pulls from bars_intraday. intraday-bars-scan.ts keeps a priority
 * set current every 5 min; for any other symbol (or a stale one) the Day
 * chart fetches the most recent session on demand via the session-bars
 * function, which also stores it.
 * Week/Month/Year/Max all pull from bars_daily. On the free Supabase
 * plan bars_daily is held to a rolling ~18-month window (see
 * prune-bars-daily.ts), so "Max" tops out there; eod-scan's normal
 * ~400-day fetch keeps the recent end current.
 */
export function SymbolDetail() {
  const { ticker } = useParams<{ ticker: string }>();
  const [range, setRange] = useState<Range>("day");
  const [points, setPoints] = useState<PricePoint[]>([]);
  const [session, setSession] = useState<SessionAxis | null>(null);
  // Session (candles) view: null = most recent session.
  const [sessionDate, setSessionDate] = useState<string | null>(null);
  const [candles, setCandles] = useState<SessionCandles | null>(null);
  const [dossiers, setDossiers] = useState<DossierRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [symbolId, setSymbolId] = useState<number | null>(null);
  const [symbolName, setSymbolName] = useState<string | null>(null);
  // Poll the live quote every 30s (matches the quotes function's edge cache).
  const quotes = useQuotes(ticker ? [ticker] : [], 30_000);

  const loadDossiers = useCallback(async (symbolId: number) => {
    const { data } = await supabase
      .from("dossiers")
      .select("id, ts, score, analysis")
      .eq("symbol_id", symbolId)
      .order("ts", { ascending: false })
      .limit(20);
    setDossiers((data as DossierRow[]) ?? []);
  }, []);

  const loadChart = useCallback(async (symbolId: number, tkr: string, r: Range, date: string | null = null) => {
    setLoading(true);
    if (r === "session") {
      // SIP 1-minute candles for one session, fetched on demand (nothing
      // stored — bars_intraday only keeps IEX close + volume).
      try {
        const q = `symbol=${encodeURIComponent(tkr)}${date ? `&date=${date}` : ""}`;
        const res = await fetch(`/.netlify/functions/session-candles?${q}`);
        setCandles((await res.json()) as SessionCandles);
      } catch {
        setCandles({ session_date: date, prev_close: null, bars: [], error: "Couldn't load session candles." });
      }
      setLoading(false);
      return;
    }
    if (r === "day") {
      // "Day" = the most recent session with data, not literally today.
      // The axis is the fixed 4:00a–8:00p ET window (extended hours
      // compressed to 1/3 width); each point's x is the layout coordinate
      // from session.toX, with the real timestamp kept in `t`.
      const buildDay = (rows: { ts: string; price: number }[]) => {
        if (!rows.length) {
          setPoints([]);
          setSession(null);
          return;
        }
        const s = sessionAxis(new Date(rows[rows.length - 1].ts).getTime());
        setSession(s);
        setPoints(
          rows.map((b) => {
            const t = new Date(b.ts).getTime();
            return { x: s.toX(t), y: b.price, t };
          }),
        );
      };

      const { data: latestRow } = await supabase
        .from("bars_intraday")
        .select("ts")
        .eq("symbol_id", symbolId)
        .order("ts", { ascending: false })
        .limit(1)
        .maybeSingle();

      const latestTs = (latestRow as { ts: string } | null)?.ts;
      const staleMs = 2.5 * 24 * 60 * 60 * 1000;
      const isStale = !latestTs || Date.now() - new Date(latestTs).getTime() > staleMs;

      if (isStale) {
        // Symbol isn't in intraday-bars-scan's priority set (or has fallen
        // behind) — pull its most recent session on demand.
        try {
          const res = await fetch(
            `/.netlify/functions/session-bars?symbol=${encodeURIComponent(tkr)}`,
          );
          const body = (await res.json()) as { bars?: { ts: string; price: number }[] };
          buildDay(body.bars ?? []);
        } catch {
          setPoints([]);
          setSession(null);
        }
        setLoading(false);
        return;
      }

      const dayStart = `${latestTs.slice(0, 10)}T00:00:00Z`;
      const dayEnd = new Date(new Date(dayStart).getTime() + 24 * 60 * 60 * 1000).toISOString();
      const { data } = await supabase
        .from("bars_intraday")
        .select("ts, price")
        .eq("symbol_id", symbolId)
        .gte("ts", dayStart)
        .lt("ts", dayEnd)
        .order("ts", { ascending: true })
        .limit(1000);
      buildDay((data as { ts: string; price: number }[] | null) ?? []);
    } else {
      setSession(null);
      const start = rangeStartDate(r).toISOString().slice(0, 10);
      const { data } = await supabase
        .from("bars_daily")
        .select("date, close")
        .eq("symbol_id", symbolId)
        .gte("date", start)
        .order("date", { ascending: true })
        .limit(2000);
      const rows = (data as { date: string; close: number }[] | null) ?? [];
      setPoints(rows.map((b) => ({ x: formatDateLabel(b.date, r), y: b.close })));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;

    async function init() {
      const { data: symbol } = await supabase
        .from("symbols")
        .select("id, name")
        .eq("ticker", ticker)
        .maybeSingle();
      if (!symbol || cancelled) return;
      setSymbolId(symbol.id);
      setSymbolName(symbol.name);
      await Promise.all([loadChart(symbol.id, ticker!, range), loadDossiers(symbol.id)]);
    }
    init();
    return () => {
      cancelled = true;
    };
    // Only re-run this effect on ticker change; range changes are handled
    // by the separate effect below so switching ranges doesn't re-fetch
    // dossiers unnecessarily.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticker]);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;

    async function refetchChart() {
      const { data: symbol } = await supabase
        .from("symbols")
        .select("id")
        .eq("ticker", ticker)
        .maybeSingle();
      if (!symbol || cancelled) return;
      await loadChart(symbol.id, ticker!, range, sessionDate);
    }
    refetchChart();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, sessionDate]);

  return (
    <div className="page">
      <header className="page-header">
        <div className="symbol-header-title">
          <BrandHomeLink />
          <h1>
            {ticker}
            {symbolName && <span className="symbol-company-name"> ({symbolName})</span>}
          </h1>
          {ticker && <SymbolQuote quote={quotes.get(ticker)} />}
          <CompanyDescription name={symbolName} />
        </div>
        {/* Chart controls live top-right, beside the name/price/description,
            so the chart itself starts right under the header. */}
        <div className="symbol-header-controls">
          <div className="range-toggle">
            {RANGE_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                className={opt.key === range ? "active" : ""}
                onClick={() => setRange(opt.key)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {range === "session" && (
            <div className="session-picker">
              <button
                onClick={() => candles?.session_date && setSessionDate(stepWeekday(candles.session_date, -1))}
                disabled={!candles?.session_date}
                aria-label="Previous session"
              >
                ◀
              </button>
              <input
                type="date"
                value={candles?.session_date ?? sessionDate ?? ""}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => e.target.value && setSessionDate(e.target.value)}
              />
              <button
                onClick={() => candles?.session_date && setSessionDate(stepWeekday(candles.session_date, 1))}
                disabled={!candles?.session_date}
                aria-label="Next session"
              >
                ▶
              </button>
              <button onClick={() => setSessionDate(null)} className={sessionDate === null ? "active" : ""}>
                Latest
              </button>
            </div>
          )}
          {range === "session" && (
            <span className="session-picker-note">
              SIP consolidated tape, 1-min bars{candles?.delayed ? " · in progress, 15-min delayed" : ""}
            </span>
          )}
        </div>
      </header>

      <section>
        {loading ? (
          <p className="empty-state chart-empty-state">Loading…</p>
        ) : range === "session" ? (
          candles?.error ? (
            <p className="empty-state chart-empty-state">{candles.error}</p>
          ) : !candles || candles.bars.length === 0 ? (
            <p className="empty-state chart-empty-state">
              No trading {candles?.session_date ? `on ${candles.session_date}` : "found in the last 10 days"}.
            </p>
          ) : (
            <SessionCandleChart bars={candles.bars} prevClose={candles.prev_close} />
          )
        ) : points.length === 0 ? (
          <p className="empty-state chart-empty-state">
            No {range === "day" ? "intraday" : "daily"} bars yet for this symbol
            {range === "max" ? " — history is backfilled from 2025-03." : "."}
          </p>
        ) : (
          <PriceChart
            data={points}
            variant={range === "day" ? "intraday" : "calendar"}
            session={range === "day" ? session ?? undefined : undefined}
          />
        )}
      </section>

      {symbolId !== null && (
        <section>
          <SymbolProfile
            symbolId={symbolId}
            news={ticker ? <SymbolNews ticker={ticker} /> : null}
          />
        </section>
      )}

      <section>
        <h2>Dossiers</h2>
        {dossiers.length === 0 ? (
          <p className="empty-state">No deep-dive dossiers yet for this symbol.</p>
        ) : (
          <ul className="dossier-list">
            {dossiers.map((d) => (
              <li key={d.id}>
                <DossierCard dossier={d} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** Prominent last-price + intraday change for the symbol header. */
function SymbolQuote({ quote }: { quote: Quote | undefined }) {
  if (!quote) return <div className="symbol-quote symbol-quote-empty">—</div>;
  const { price, changePct } = quote;
  const open = changePct > -1 ? price / (1 + changePct) : price;
  const abs = price - open;
  const pctRounded = Number((changePct * 100).toFixed(2));
  const dir = pctRounded > 0 ? "up" : pctRounded < 0 ? "down" : "flat";
  const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "";
  return (
    <div className={`symbol-quote ${dir}`}>
      <span className="symbol-quote-price">${price.toFixed(2)}</span>
      <span className="symbol-quote-change">
        {arrow} {abs >= 0 ? "+" : "−"}${Math.abs(abs).toFixed(2)} ({pctRounded > 0 ? "+" : ""}
        {pctRounded.toFixed(2)}%) <span className="symbol-quote-today">today</span>
      </span>
    </div>
  );
}
