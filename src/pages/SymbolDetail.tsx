import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { supabase } from "../lib/supabaseClient";
import { DossierCard } from "../components/DossierCard";
import { SymbolProfile } from "../components/SymbolProfile";
import { CompanyDescription } from "../components/CompanyDescription";
import { QuoteTag, useQuotes } from "../components/QuoteTag";

type Range = "day" | "week" | "month" | "year" | "max";

const RANGE_OPTIONS: { key: Range; label: string }[] = [
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "year", label: "Year" },
  { key: "max", label: "Max (18mo)" },
];

interface ChartPoint {
  x: string; // pre-formatted label (time for Day, date for everything else)
  y: number;
}

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
  const [points, setPoints] = useState<ChartPoint[]>([]);
  const [dossiers, setDossiers] = useState<DossierRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [symbolId, setSymbolId] = useState<number | null>(null);
  const [symbolName, setSymbolName] = useState<string | null>(null);
  const quotes = useQuotes(ticker ? [ticker] : []);

  const loadDossiers = useCallback(async (symbolId: number) => {
    const { data } = await supabase
      .from("dossiers")
      .select("id, ts, score, analysis")
      .eq("symbol_id", symbolId)
      .order("ts", { ascending: false })
      .limit(20);
    setDossiers((data as DossierRow[]) ?? []);
  }, []);

  const loadChart = useCallback(async (symbolId: number, tkr: string, r: Range) => {
    setLoading(true);
    if (r === "day") {
      // "Day" = the most recent session with data, not literally today.
      const toPoints = (rows: { ts: string; price: number }[]) =>
        rows.map((b) => ({
          x: new Date(b.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          y: b.price,
        }));

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
          setPoints(toPoints(body.bars ?? []));
        } catch {
          setPoints([]);
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
      setPoints(toPoints((data as { ts: string; price: number }[] | null) ?? []));
    } else {
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
      await loadChart(symbol.id, ticker!, range);
    }
    refetchChart();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  return (
    <div className="page">
      <header className="page-header">
        <div className="symbol-header-title">
          <h1>
            {ticker}
            {symbolName && <span className="symbol-company-name"> ({symbolName})</span>}
            {ticker && <QuoteTag quote={quotes.get(ticker)} />}
          </h1>
          <CompanyDescription name={symbolName} />
        </div>
        <Link to="/">← back to feed</Link>
      </header>

      <section>
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
        {loading ? (
          <p className="empty-state chart-empty-state">Loading…</p>
        ) : points.length === 0 ? (
          <p className="empty-state chart-empty-state">
            No {range === "day" ? "intraday" : "daily"} bars yet for this symbol
            {range === "max" ? " — history is backfilled from 2025-03." : "."}
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={points}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="x" minTickGap={40} />
              <YAxis domain={["auto", "auto"]} />
              <Tooltip labelStyle={{ color: "#000" }} />
              <Line type="monotone" dataKey="y" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </section>

      {symbolId !== null && (
        <section>
          <SymbolProfile symbolId={symbolId} />
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
