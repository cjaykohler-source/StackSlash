import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { triggerLabel, triggerCategoryLabel, TRIGGER_INFO } from "../lib/triggerInfo";
import { InfoTooltip } from "./InfoTooltip";
import { useQuotes } from "./QuoteTag";

// The feed shows every trigger fire — single-trigger fires (still sitting
// in pending_fires, un-clustered) alongside the confluence-gate's
// promoted cluster events. Rows are flagged by how many distinct triggers
// agreed: 2 gets a badge, 3+ gets the high-priority treatment. Still
// scoped to symbols trading at $50/share or less; under $5 gets its own
// flag. Rows we can't price yet stay visible until a quote lands.
const MAX_PRICE = 50;
const SUB_PENNY_FLAG_PRICE = 5;

interface ConfluenceMeta {
  count: number;
  direction: "long" | "short";
  triggers: { id: number; name: string | null }[];
}

interface FeedRow {
  key: string; // "e<id>" | "p<id>"
  ts: string;
  symbol_id: number;
  ticker: string | null;
  triggerName: string | null;
  signalCount: number; // 1 = lone fire / exit, 2 / 3+ = confluence cluster
  clusterTriggerNames: string[]; // for the badge tooltip when >= 2
  priority: "normal" | "high" | null;
  status: string; // "pending" for un-promoted single fires
}

interface DayGroup {
  key: string; // YYYY-MM-DD, local time
  label: string;
  rows: FeedRow[];
}

// en-CA locale conveniently formats as YYYY-MM-DD — used purely as a
// stable, lexicographically-sortable grouping key in the viewer's local
// time zone, not shown to the user.
function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA");
}

function dayLabel(key: string): string {
  return new Date(`${key}T00:00:00`).toLocaleDateString([], {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

const STATUS_INFO: Record<string, string> = {
  pending: "One trigger fired — no second, same-direction trigger has clustered with it yet, so no dossier or alert.",
  new: "Trigger just fired — dossier generation and alerting haven't run yet.",
  dossier_ready: "The trigger's supporting evidence (dossier) has been assembled.",
  alerted: "A Discord alert went out for this fire.",
  dismissed: "This fire was manually dismissed and won't generate further downstream action.",
};

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
 * Supabase Realtime. This is the primary dashboard surface.
 *
 * Two sources, merged by timestamp:
 *  - `trigger_events` — the confluence gate's promoted cluster events
 *    (one row per cluster) plus non-gated events like momentum_exit.
 *  - `pending_fires` (un-promoted) — single trigger fires that haven't
 *    clustered with anything.
 * Price/change are their own columns; a symbol's signal count drives the
 * 2-signal / 3+-signal flags.
 */
export function TriggerFeed() {
  const [eventRows, setEventRows] = useState<FeedRow[]>([]);
  const [pendingRows, setPendingRows] = useState<FeedRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expandedDays, setExpandedDays] = useState<Set<string> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const [eventsRes, pendingRes] = await Promise.all([
        supabase
          .from("trigger_events")
          .select("id, ts, status, priority, symbol_id, trigger_id, snapshot, symbols(ticker), triggers(name)")
          .order("ts", { ascending: false })
          .limit(500),
        supabase
          .from("pending_fires")
          .select("id, created_at, symbol_id, trigger_id, symbols(ticker), triggers(name)")
          .is("promoted_at", null)
          .order("created_at", { ascending: false })
          .limit(300),
      ]);
      if (cancelled) return;

      type RawEvent = {
        id: number;
        ts: string;
        status: string;
        priority: "normal" | "high" | null;
        symbol_id: number;
        trigger_id: number;
        snapshot: { confluence?: ConfluenceMeta | null } | null;
        symbols: { ticker: string } | null;
        triggers: { name: string } | null;
      };
      type RawPending = {
        id: number;
        created_at: string;
        symbol_id: number;
        symbols: { ticker: string } | null;
        triggers: { name: string } | null;
      };

      const events: FeedRow[] = ((eventsRes.data as unknown as RawEvent[]) ?? []).map((r) => {
        const conf = r.snapshot?.confluence ?? null;
        const names = conf?.triggers.map((t) => t.name).filter((n): n is string => !!n) ?? [];
        return {
          key: `e${r.id}`,
          ts: r.ts,
          symbol_id: r.symbol_id,
          ticker: r.symbols?.ticker ?? null,
          triggerName: r.triggers?.name ?? null,
          signalCount: conf?.count ?? 1,
          clusterTriggerNames: names.length ? names : r.triggers?.name ? [r.triggers.name] : [],
          priority: r.priority,
          status: r.status,
        };
      });

      const pending: FeedRow[] = ((pendingRes.data as unknown as RawPending[]) ?? []).map((r) => ({
        key: `p${r.id}`,
        ts: r.created_at,
        symbol_id: r.symbol_id,
        ticker: r.symbols?.ticker ?? null,
        triggerName: r.triggers?.name ?? null,
        signalCount: 1,
        clusterTriggerNames: r.triggers?.name ? [r.triggers.name] : [],
        priority: null,
        status: "pending",
      }));

      setEventRows(events);
      setPendingRows(pending);
      setLoaded(true);
      setExpandedDays((prev) => prev ?? new Set([dayKey(new Date().toISOString())]));
    }
    load();

    const channel = supabase
      .channel("trigger_feed")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "trigger_events" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "pending_fires" }, () => load())
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, []);

  const rows = useMemo(
    () => [...eventRows, ...pendingRows].sort((a, b) => (a.ts < b.ts ? 1 : -1)),
    [eventRows, pendingRows],
  );

  const quotes = useQuotes(rows.map((r) => r.ticker ?? "").filter(Boolean));

  const visibleRows = useMemo(() => {
    return rows.filter((row) => {
      const q = row.ticker ? quotes.get(row.ticker) : undefined;
      return !(q && q.price > MAX_PRICE);
    });
  }, [rows, quotes]);

  const groups = useMemo<DayGroup[]>(() => {
    const byDay = new Map<string, FeedRow[]>();
    for (const row of visibleRows) {
      const key = dayKey(row.ts);
      const existing = byDay.get(key);
      if (existing) existing.push(row);
      else byDay.set(key, [row]);
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([key, dayRows]) => ({ key, label: dayLabel(key), rows: dayRows }));
  }, [visibleRows]);

  if (loaded && rows.length === 0) {
    return (
      <p className="empty-state">
        No trigger activity yet — fires will show up here live once eod-scan / intraday-scan / the realtime worker run.
      </p>
    );
  }
  if (loaded && visibleRows.length === 0) {
    return <p className="empty-state">Nothing in the recent feed is trading at ${MAX_PRICE}/share or less.</p>;
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
                  <th className="col-num">Price</th>
                  <th className="col-num">Change</th>
                  <th>Trigger</th>
                  <th className="col-category">Category</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((row) => {
                  const quote = row.ticker ? quotes.get(row.ticker) : undefined;
                  const pct = quote ? Number((quote.changePct * 100).toFixed(1)) : null;
                  const pctDir = pct === null ? "" : pct > 0 ? "up" : pct < 0 ? "down" : "";
                  const subFive = quote != null && quote.price < SUB_PENNY_FLAG_PRICE;
                  const isHigh = row.priority === "high" || row.signalCount >= 3;
                  return (
                    <tr key={row.key} className={isHigh || subFive ? "trigger-feed-row-high" : undefined}>
                      <td>{timeOnly(row.ts)}</td>
                      <td>
                        <Link to={`/symbol/${row.ticker ?? row.symbol_id}`}>{row.ticker ?? row.symbol_id}</Link>
                        {row.signalCount >= 2 && (
                          <span
                            className={`confluence-badge${row.signalCount >= 3 ? " confluence-badge-high" : ""}`}
                            title={`${row.signalCount} independent triggers agreed: ${row.clusterTriggerNames
                              .map((n) => triggerLabel(n))
                              .join(", ")}`}
                          >
                            {row.signalCount >= 3 ? `${row.signalCount} signals` : "2 signals"}
                          </span>
                        )}
                        {subFive && (
                          <span
                            className="confluence-badge confluence-badge-subfive"
                            title={`Trading under $${SUB_PENNY_FLAG_PRICE}/share — flagged high priority`}
                          >
                            UNDER ${SUB_PENNY_FLAG_PRICE}
                          </span>
                        )}
                      </td>
                      <td className="col-num">{quote ? `$${quote.price.toFixed(2)}` : "—"}</td>
                      <td className={`col-num ${pctDir}`}>
                        {pct === null ? "—" : `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`}
                      </td>
                      <td>
                        {row.triggerName && TRIGGER_INFO[row.triggerName]?.summary ? (
                          <InfoTooltip text={TRIGGER_INFO[row.triggerName]!.summary}>
                            {triggerLabel(row.triggerName)}
                          </InfoTooltip>
                        ) : row.triggerName ? (
                          triggerLabel(row.triggerName)
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="col-category">
                        {row.triggerName ? triggerCategoryLabel(row.triggerName) : "—"}
                      </td>
                      <td>
                        {STATUS_INFO[row.status] ? (
                          <InfoTooltip underline={false} text={STATUS_INFO[row.status]}>
                            <span className={`status status-${row.status}`}>{row.status}</span>
                          </InfoTooltip>
                        ) : (
                          <span className={`status status-${row.status}`}>{row.status}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      ))}
    </div>
  );
}
