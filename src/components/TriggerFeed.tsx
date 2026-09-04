import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";

interface FeedRow {
  id: number;
  ts: string;
  status: string;
  symbol_id: number;
  trigger_id: number;
  symbols: { ticker: string } | null;
  triggers: { name: string; category: string | null } | null;
}

/**
 * Live feed of fired triggers, newest first, updated in real time via
 * Supabase Realtime. This is the primary dashboard surface — the "digging"
 * the two-tier design promised: everything here already passed a trigger,
 * nothing here is the raw wide-net Tier-1 data.
 */
export function TriggerFeed() {
  const [rows, setRows] = useState<FeedRow[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const { data } = await supabase
        .from("trigger_events")
        .select("id, ts, status, symbol_id, trigger_id, symbols(ticker), triggers(name, category)")
        .order("ts", { ascending: false })
        .limit(50);
      if (!cancelled) setRows((data as unknown as FeedRow[]) ?? []);
    }
    load();

    const channel = supabase
      .channel("trigger_events_feed")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "trigger_events" },
        () => load(),
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  if (rows.length === 0) {
    return <p className="empty-state">No trigger events yet — once eod-scan and intraday-scan are running, fires will show up here live.</p>;
  }

  return (
    <table className="trigger-feed">
      <thead>
        <tr>
          <th>Time</th>
          <th>Symbol</th>
          <th>Trigger</th>
          <th>Category</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td>{new Date(row.ts).toLocaleString()}</td>
            <td>
              <Link to={`/symbol/${row.symbols?.ticker ?? row.symbol_id}`}>
                {row.symbols?.ticker ?? row.symbol_id}
              </Link>
            </td>
            <td>{row.triggers?.name ?? row.trigger_id}</td>
            <td>{row.triggers?.category ?? "—"}</td>
            <td>
              <span className={`status status-${row.status}`}>{row.status}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
