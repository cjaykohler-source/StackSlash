import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { triggerLabel, triggerCategoryLabel } from "../lib/triggerInfo";

interface FeedRow {
  id: number;
  ts: string;
  status: string;
  symbol_id: number;
  trigger_id: number;
  symbols: { ticker: string } | null;
  triggers: { name: string; category: string | null } | null;
}

interface DayGroup {
  key: string; // YYYY-MM-DD, local time
  label: string; // e.g. "Friday, September 4, 2026"
  rows: FeedRow[];
}

// en-CA locale conveniently formats as YYYY-MM-DD — used purely as a
// stable, lexicographically-sortable grouping key in the viewer's local
// time zone, not shown to the user.
function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA");
}

function dayLabel(key: string): string {
  // key is YYYY-MM-DD local; append a time so the Date constructor
  // parses it in local time rather than UTC (avoiding an off-by-one-day
  // display near midnight).
  return new Date(`${key}T00:00:00`).toLocaleDateString([], {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function timeOnly(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

/**
 * Live feed of fired triggers, grouped by day and updated in real time via
 * Supabase Realtime. This is the primary dashboard surface — the
 * "digging" the two-tier design promised: everything here already passed
 * a trigger, nothing here is the raw wide-net Tier-1 data.
 *
 * Grouped into a collapsible section per day (native <details>, so it's
 * keyboard/accessible-tree friendly for free) since the timestamp column
 * only needs to show time-of-day once it's filed under its date's
 * heading. Today's section starts expanded; every other day starts
 * collapsed — most days won't have anything worth re-reading once
 * they're not "today" anymore.
 */
export function TriggerFeed() {
  const [rows, setRows] = useState<FeedRow[]>([]);
  const [expandedDays, setExpandedDays] = useState<Set<string> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const { data } = await supabase
        .from("trigger_events")
        .select("id, ts, status, symbol_id, trigger_id, symbols(ticker), triggers(name, category)")
        .order("ts", { ascending: false })
        .limit(200);
      if (cancelled) return;
      const loaded = (data as unknown as FeedRow[]) ?? [];
      setRows(loaded);
      // Only set the initial expanded-days default once, the first time
      // data loads — otherwise a realtime refresh would silently
      // re-collapse a day the user just opened.
      setExpandedDays((prev) => prev ?? new Set([dayKey(new Date().toISOString())]));
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

  const groups = useMemo<DayGroup[]>(() => {
    const byDay = new Map<string, FeedRow[]>();
    for (const row of rows) {
      const key = dayKey(row.ts);
      const existing = byDay.get(key);
      if (existing) existing.push(row);
      else byDay.set(key, [row]);
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => (a < b ? 1 : -1)) // newest day first
      .map(([key, dayRows]) => ({ key, label: dayLabel(key), rows: dayRows }));
  }, [rows]);

  if (rows.length === 0) {
    return <p className="empty-state">No trigger events yet — once eod-scan and intraday-scan are running, fires will show up here live.</p>;
  }

  function toggleDay(key: string, isOpen: boolean) {
    setExpandedDays((prev) => {
      const next = new Set(prev ?? []);
      if (isOpen) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  return (
    <div className="trigger-feed-days">
      {groups.map((group) => (
        <details
          key={group.key}
          className="trigger-feed-day"
          open={expandedDays?.has(group.key) ?? false}
          onToggle={(e) => toggleDay(group.key, e.currentTarget.open)}
        >
          <summary>
            {group.label} <span className="trigger-feed-day-count">({group.rows.length})</span>
          </summary>
          <div className="trigger-feed-scroll">
            <table className="trigger-feed">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Symbol</th>
                  <th>Trigger</th>
                  <th className="col-category">Category</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((row) => (
                  <tr key={row.id}>
                    <td>{timeOnly(row.ts)}</td>
                    <td>
                      <Link to={`/symbol/${row.symbols?.ticker ?? row.symbol_id}`}>
                        {row.symbols?.ticker ?? row.symbol_id}
                      </Link>
                    </td>
                    <td>{row.triggers?.name ? triggerLabel(row.triggers.name) : row.trigger_id}</td>
                    <td className="col-category">{row.triggers?.name ? triggerCategoryLabel(row.triggers.name) : "—"}</td>
                    <td>
                      <span className={`status status-${row.status}`}>{row.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ))}
    </div>
  );
}
