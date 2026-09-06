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

type Range = "day" | "week" | "month" | "year" | "5y";

const RANGE_OPTIONS: { key: Range; label: string }[] = [
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "year", label: "Year" },
  { key: "5y", label: "5-Year" },
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
    case "5y":
      d.setFullYear(d.getFullYear() - 5);
      break;
    case "day":
      // handled separately via bars_intraday, not used here
      break;
  }
  return d;
}

// Per design: only 5-Year shows a year label on the x-axis. Year's own
// 12-month window can technically straddle a Dec/Jan boundary, so this
// is a deliberate trade-off (repeating the year on every tick elsewhere
// is noisier than the rare cross-year ambiguity this introduces there).
function formatDateLabel(dateStr: string, range: Range): string {
  const d = new Date(`${dateStr}T00:00:00`);
  return d.toLocaleDateString(
    [],
    range === "5y" ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" },
  );
}

/**
 * Symbol drill-down: price chart (range-toggleable) + dossiers (the
 * "why it fired" explanations from the deep-dive worker) for that symbol.
 *
 * Day pulls from bars_intraday, populated by intraday-bars-scan.ts (1-min
 * bars for today, whole universe, every 5 min during market hours). Empty
 * until that job has run at least once today — see the empty-state
 * handling below for outside-market-hours / not-yet-run cases.
 * Week/Month/Year/5-Year all pull from bars_daily —
 * Week/Month/Year are already covered by eod-scan's normal ~400-day
 * fetch; 5-Year needs backfill-history.ts to have been run at least once
 * for this symbol, or the chart will just show whatever bars_daily
 * happens to already have.
 */
export function SymbolDetail() {
  const { ticker } = useParams<{ ticker: string }>();
  const [range, setRange] = useState<Range>("day");
  const [points, setPoints] = useState<ChartPoint[]>([]);
  const [dossiers, setDossiers] = useState<DossierRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [symbolId, setSymbolId] = useState<number | null>(null);

  const loadDossiers = useCallback(async (symbolId: number) => {
    const { data } = await supabase
      .from("dossiers")
      .select("id, ts, score, analysis")
      .eq("symbol_id", symbolId)
      .order("ts", { ascending: false })
      .limit(20);
    setDossiers((data as DossierRow[]) ?? []);
  }, []);

  const loadChart = useCallback(async (symbolId: number, r: Range) => {
    setLoading(true);
    if (r === "day") {
      // "Day" means the most recent session with data, not literally
      // today — when the market's closed (evenings, weekends, holidays,
      // or just before today's first intraday-bars-scan run), today has
      // no rows yet and showing an empty chart isn't a useful default.
      // Find the latest bar first, then pull that whole calendar day.
      const { data: latestRow } = await supabase
        .from("bars_intraday")
        .select("ts")
        .eq("symbol_id", symbolId)
        .order("ts", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!latestRow) {
        setPoints([]);
        setLoading(false);
        return;
      }
      const dayStart = `${(latestRow as { ts: string }).ts.slice(0, 10)}T00:00:00Z`;
      const dayEnd = new Date(new Date(dayStart).getTime() + 24 * 60 * 60 * 1000).toISOString();
      const { data } = await supabase
        .from("bars_intraday")
        .select("ts, price")
        .eq("symbol_id", symbolId)
        .gte("ts", dayStart)
        .lt("ts", dayEnd)
        .order("ts", { ascending: true })
        .limit(1000);
      const rows = (data as { ts: string; price: number }[] | null) ?? [];
      setPoints(
        rows.map((b) => ({
          x: new Date(b.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          y: b.price,
        })),
      );
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
        .select("id")
        .eq("ticker", ticker)
        .maybeSingle();
      if (!symbol || cancelled) return;
      setSymbolId(symbol.id);
      await Promise.all([loadChart(symbol.id, range), loadDossiers(symbol.id)]);
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
      await loadChart(symbol.id, range);
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
        <h1>{ticker}</h1>
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
            {range === "5y" ? " — try running backfill-history for it first." : "."}
          </p>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={points}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="x" minTickGap={40} />
              <YAxis domain={["auto", "auto"]} />
              <Tooltip />
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
