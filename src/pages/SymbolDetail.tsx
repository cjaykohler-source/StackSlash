import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { DossierCard } from "../components/DossierCard";
import { SymbolProfile } from "../components/SymbolProfile";
import { CompanyDescription } from "../components/CompanyDescription";
import { useQuotes, type Quote } from "../components/QuoteTag";
import { SymbolNews } from "../components/SymbolNews";
import { SessionCandleChart, type Candle } from "../components/SessionCandleChart";
import { RangeCandleChart, TIMEFRAME_LABEL, type RangeBar, type RangeTimeframe } from "../components/RangeCandleChart";
import { BrandHomeLink } from "../components/BrandHomeLink";

type Range = "session" | "week" | "month" | "year" | "18mo" | "5y" | "since2016";

const RANGE_OPTIONS: { key: Range; label: string }[] = [
  { key: "session", label: "Session" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "year", label: "Year" },
  { key: "18mo", label: "18 Months" },
  { key: "5y", label: "5 Years" },
  { key: "since2016", label: "Since 2016" },
];

interface DossierRow {
  id: number;
  ts: string;
  score: number | null;
  analysis: Record<string, unknown>;
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

interface RangeCandles {
  timeframe: RangeTimeframe;
  bars: RangeBar[];
  error?: string;
}

/**
 * Symbol drill-down: candlestick chart (range-toggleable) + dossiers (the
 * "why it fired" explanations from the deep-dive worker) for that symbol.
 *
 * Every range is candles from the consolidated tape (SIP), fetched on
 * demand and not stored: Session is one day's 1-minute bars
 * (session-candles, raw prices); Week through Since 2016 are 30-min,
 * daily, weekly or monthly split-adjusted bars (range-candles). Nothing
 * here reads production bars_daily/bars_intraday, which are IEX-only.
 */
export function SymbolDetail() {
  const { ticker } = useParams<{ ticker: string }>();
  const [range, setRange] = useState<Range>("session");
  // Session view: null = most recent session.
  const [sessionDate, setSessionDate] = useState<string | null>(null);
  const [candles, setCandles] = useState<SessionCandles | null>(null);
  const [rangeCandles, setRangeCandles] = useState<RangeCandles | null>(null);
  const [dossiers, setDossiers] = useState<DossierRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [symbolId, setSymbolId] = useState<number | null>(null);
  const [symbolName, setSymbolName] = useState<string | null>(null);
  // Only the latest chart request may set state (fast range clicks).
  const chartReq = useRef(0);
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

  // `quiet` = background refresh: keep the current chart on screen meanwhile.
  const loadChart = useCallback(async (tkr: string, r: Range, date: string | null, quiet = false) => {
    const req = ++chartReq.current;
    if (!quiet) setLoading(true);
    if (r === "session") {
      let body: SessionCandles;
      try {
        const q = `symbol=${encodeURIComponent(tkr)}${date ? `&date=${date}` : ""}`;
        body = (await (await fetch(`/.netlify/functions/session-candles?${q}`)).json()) as SessionCandles;
      } catch {
        body = { session_date: date, prev_close: null, bars: [], error: "Couldn't load session candles." };
      }
      if (req !== chartReq.current) return;
      setCandles(body);
    } else {
      let body: RangeCandles;
      try {
        const res = await fetch(`/.netlify/functions/range-candles?symbol=${encodeURIComponent(tkr)}&range=${r}`);
        body = (await res.json()) as RangeCandles;
      } catch {
        body = { timeframe: "1Day", bars: [], error: "Couldn't load candles." };
      }
      if (req !== chartReq.current) return;
      setRangeCandles(body);
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
      await loadDossiers(symbol.id);
    }
    init();
    return () => {
      cancelled = true;
    };
  }, [ticker, loadDossiers]);

  // The chart needs only the ticker (the functions fetch from Alpaca), so it
  // loads in parallel with the symbol lookup above.
  useEffect(() => {
    if (ticker) loadChart(ticker, range, sessionDate);
  }, [ticker, range, sessionDate, loadChart]);

  // The live session (Latest, still in progress; SIP is 15-min delayed on
  // the free plan) refreshes itself every minute while it's on screen.
  const liveSession = range === "session" && sessionDate === null && !!candles?.delayed;
  useEffect(() => {
    if (!ticker || !liveSession) return;
    const id = setInterval(() => loadChart(ticker, "session", null, true), 60_000);
    return () => clearInterval(id);
  }, [ticker, liveSession, loadChart]);

  return (
    <div className="page">
      <header className="page-header">
        <div className="symbol-header-title">
          <BrandHomeLink />
          {/* Price trails the ticker + name on the same line, wherever it ends. */}
          <div className="symbol-title-line">
            <h1>
              {ticker}
              {symbolName && <span className="symbol-company-name"> ({symbolName})</span>}
            </h1>
            {ticker && <SymbolQuote quote={quotes.get(ticker)} />}
          </div>
          <CompanyDescription name={symbolName} />
        </div>
      </header>

      <section>
        {/* Chart controls: one row riding the top of the chart. */}
        <div className="chart-controls">
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
          <span className="session-picker-note">
            {range === "session"
              ? `SIP consolidated tape, 1-min bars${candles?.delayed ? " · in progress, 15-min delayed" : ""}`
              : `SIP consolidated tape, ${rangeCandles ? TIMEFRAME_LABEL[rangeCandles.timeframe] : ""} bars, split-adjusted`}
          </span>
        </div>
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
            <SessionCandleChart bars={candles.bars} prevClose={candles.prev_close} live={!!candles.delayed} />
          )
        ) : rangeCandles?.error ? (
          <p className="empty-state chart-empty-state">{rangeCandles.error}</p>
        ) : !rangeCandles || rangeCandles.bars.length === 0 ? (
          <p className="empty-state chart-empty-state">No trading in this range.</p>
        ) : (
          <RangeCandleChart bars={rangeCandles.bars} timeframe={rangeCandles.timeframe} />
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
