import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { etTimeLabel } from "../lib/marketTime";

interface Mover {
  ticker: string;
  price: number;
  change_pct: number;
  bucket: "gainer" | "loser";
}

const REFRESH_MS = 5 * 60_000; // matches intraday-bars-scan's 5-min cadence
const TOP_N = 35;

/**
 * Live dashboard sidebar: the day's 35 biggest gainers and 35 biggest
 * losers across the tracked universe, % measured from today's open (same
 * basis as the per-symbol quote tags). Data comes straight from the
 * `top_movers()` Postgres function over `bars_intraday` — no Alpaca call —
 * so it's only as complete as that day's intraday coverage, and refreshes
 * every 5 minutes (the rate the underlying bars_intraday data updates).
 *
 * The "as of" stamp is the timestamp of the freshest `bars_intraday` bar,
 * i.e. when these numbers were actually pulled — not the page-load time,
 * so a stale stamp (market closed, coverage gap) is visible as stale.
 */
export function TopMovers() {
  const [movers, setMovers] = useState<Mover[] | null>(null);
  const [asOf, setAsOf] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const [moversRes, tsRes] = await Promise.all([
        supabase.rpc("top_movers", { n: TOP_N }),
        supabase
          .from("bars_intraday")
          .select("ts")
          .order("ts", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (cancelled) return;
      if (moversRes.error) {
        setFailed(true);
        return;
      }
      setFailed(false);
      setMovers((moversRes.data as Mover[]) ?? []);
      setAsOf(tsRes.data?.ts ? new Date(tsRes.data.ts as string).getTime() : null);
    }

    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (failed && !movers) return null;

  const gainers = (movers ?? []).filter((m) => m.bucket === "gainer");
  const losers = (movers ?? []).filter((m) => m.bucket === "loser");

  return (
    <aside className="top-movers">
      {asOf !== null && (
        <p className="top-movers-asof">as of {etTimeLabel(asOf)}</p>
      )}
      <MoverList title="Top gainers" rows={gainers} loading={movers === null} />
      <MoverList title="Top losers" rows={losers} loading={movers === null} />
    </aside>
  );
}

function MoverList({ title, rows, loading }: { title: string; rows: Mover[]; loading: boolean }) {
  return (
    <div className="top-movers-section">
      <h3 className="top-movers-title">{title}</h3>
      {loading ? (
        <p className="top-movers-empty">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="top-movers-empty">No intraday data yet.</p>
      ) : (
        <ol className="top-movers-list">
          {rows.map((m) => {
            const pct = Number((m.change_pct * 100).toFixed(1));
            const dir = pct > 0 ? "up" : pct < 0 ? "down" : "";
            return (
              <li key={m.ticker} className="top-movers-row">
                <Link to={`/symbol/${m.ticker}`} className="top-movers-ticker">
                  {m.ticker}
                </Link>
                <span className="top-movers-price">${m.price.toFixed(2)}</span>
                <span className={`top-movers-pct ${dir}`}>
                  {pct > 0 ? "+" : ""}
                  {pct.toFixed(1)}%
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
