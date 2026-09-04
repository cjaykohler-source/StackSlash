import { useEffect, useState } from "react";
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

interface Bar {
  date: string;
  close: number;
}

interface DossierRow {
  id: number;
  ts: string;
  score: number | null;
  analysis: Record<string, unknown>;
}

/**
 * Symbol drill-down: price history + dossiers (the "why it fired"
 * explanations from the deep-dive worker) for that symbol.
 * Placeholder for now — fills in once bars_daily/dossiers have real rows.
 */
export function SymbolDetail() {
  const { ticker } = useParams<{ ticker: string }>();
  const [bars, setBars] = useState<Bar[]>([]);
  const [dossiers, setDossiers] = useState<DossierRow[]>([]);

  useEffect(() => {
    if (!ticker) return;
    let cancelled = false;

    async function load() {
      const { data: symbol } = await supabase
        .from("symbols")
        .select("id")
        .eq("ticker", ticker)
        .maybeSingle();
      if (!symbol || cancelled) return;

      const [{ data: barRows }, { data: dossierRows }] = await Promise.all([
        supabase
          .from("bars_daily")
          .select("date, close")
          .eq("symbol_id", symbol.id)
          .order("date", { ascending: true })
          .limit(252),
        supabase
          .from("dossiers")
          .select("id, ts, score, analysis")
          .eq("symbol_id", symbol.id)
          .order("ts", { ascending: false })
          .limit(20),
      ]);

      if (!cancelled) {
        setBars((barRows as Bar[]) ?? []);
        setDossiers((dossierRows as DossierRow[]) ?? []);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  return (
    <div className="page">
      <header className="page-header">
        <h1>{ticker}</h1>
        <Link to="/">← back to feed</Link>
      </header>

      <section>
        <h2>Price (close, last {bars.length} bars)</h2>
        {bars.length === 0 ? (
          <p className="empty-state">No bars yet for this symbol.</p>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={bars}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" minTickGap={40} />
              <YAxis domain={["auto", "auto"]} />
              <Tooltip />
              <Line type="monotone" dataKey="close" dot={false} strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </section>

      <section>
        <h2>Dossiers</h2>
        {dossiers.length === 0 ? (
          <p className="empty-state">No deep-dive dossiers yet for this symbol.</p>
        ) : (
          <ul className="dossier-list">
            {dossiers.map((d) => (
              <li key={d.id}>
                <div className="dossier-header">
                  <span>{new Date(d.ts).toLocaleString()}</span>
                  <span>score: {d.score ?? "—"}</span>
                </div>
                <pre>{JSON.stringify(d.analysis, null, 2)}</pre>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
