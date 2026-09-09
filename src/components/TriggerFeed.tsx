import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { triggerLabel, triggerCategoryLabel, TRIGGER_INFO } from "../lib/triggerInfo";
import { InfoTooltip } from "./InfoTooltip";
import { useQuotes } from "./QuoteTag";

// The feed shows every trigger fire — single-trigger fires (still sitting
// in pending_fires, un-clustered) alongside the confluence-gate's
// promoted cluster events. Rows are flagged by how many distinct triggers
// agreed: 2 gets a badge, 3+ gets the high-priority treatment. Scoped to
// scan_config's price band (default $0.10–$3); sub-$1 gets its own flag.
// Rows we can't price yet stay visible until a quote lands.
const SUB_DOLLAR_FLAG_PRICE = 1;
const DEFAULT_BAND = { price_min: 0.1, price_max: 3 };

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
 * Fired-trigger feed, grouped by day and updated in real time via Supabase
 * Realtime. Two sources, merged by timestamp:
 *  - `trigger_events` — the confluence gate's promoted cluster events
 *    (one row per cluster) plus non-gated events like momentum_exit.
 *  - `pending_fires` (un-promoted) — single trigger fires that haven't
 *    clustered with anything.
 *
 * Split across two surfaces by `mode`:
 *  - "today"  — the dashboard. Today's fires only, in one open frame
 *               (no dropdown, no date header), the "Trigger feed" label
 *               inside the frame so it lines up with the movers column.
 *  - "history" — the Reports page. Every earlier day, each a collapsed
 *               dropdown.
 */
export function TriggerFeed({ mode = "today" }: { mode?: "today" | "history" }) {
  const [eventRows, setEventRows] = useState<FeedRow[]>([]);
  const [pendingRows, setPendingRows] = useState<FeedRow[]>([]);
  const [band, setBand] = useState(DEFAULT_BAND);
  const [loaded, setLoaded] = useState(false);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());

  useEffect(() => {
    supabase
      .from("scan_config")
      .select("price_min, price_max")
      .eq("id", 1)
      .maybeSingle()
      .then(({ data }) => {
        if (data) setBand({ price_min: Number(data.price_min), price_max: Number(data.price_max) });
      });
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const [eventsRes, pendingRes] = await Promise.all([
        supabase
          .from("trigger_events")
          .select(
            "id, ts, status, priority, symbol_id, trigger_id, snapshot, symbols(ticker, alert_excluded), triggers(name)",
          )
          .order("ts", { ascending: false })
          .limit(500),
        supabase
          .from("pending_fires")
          .select("id, created_at, symbol_id, trigger_id, symbols(ticker, alert_excluded), triggers(name)")
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
        symbols: { ticker: string; alert_excluded: boolean } | null;
        triggers: { name: string } | null;
      };
      type RawPending = {
        id: number;
        created_at: string;
        symbol_id: number;
        symbols: { ticker: string; alert_excluded: boolean } | null;
        triggers: { name: string } | null;
      };

      const events: FeedRow[] = ((eventsRes.data as unknown as RawEvent[]) ?? [])
        .filter((r) => !r.symbols?.alert_excluded)
        .map((r) => {
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

      const pending: FeedRow[] = ((pendingRes.data as unknown as RawPending[]) ?? [])
        .filter((r) => !r.symbols?.alert_excluded)
        .map((r) => ({
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
    }
    load();

    const channel = supabase
      .channel(`trigger_feed_${mode}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "trigger_events" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "pending_fires" }, () => load())
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [mode]);

  const rows = useMemo(
    () => [...eventRows, ...pendingRows].sort((a, b) => (a.ts < b.ts ? 1 : -1)),
    [eventRows, pendingRows],
  );

  const quotes = useQuotes(rows.map((r) => r.ticker ?? "").filter(Boolean));
  const quotesReady = quotes.size > 0;

  const visibleRows = useMemo(() => {
    return rows.filter((row) => {
      if (!row.ticker) return true;
      const q = quotes.get(row.ticker);
      // Once quotes have loaded, a row we still can't price is almost
      // always an illiquid/delisted name Alpaca has no snapshot for —
      // hide it rather than let an unpriced out-of-band name through.
      if (!q) return !quotesReady;
      return q.price >= band.price_min && q.price <= band.price_max;
    });
  }, [rows, quotes, quotesReady, band]);

  const todayKey = dayKey(new Date().toISOString());

  const todayRows = useMemo(
    () => visibleRows.filter((r) => dayKey(r.ts) === todayKey),
    [visibleRows, todayKey],
  );

  const historyGroups = useMemo<DayGroup[]>(() => {
    const byDay = new Map<string, FeedRow[]>();
    for (const row of visibleRows) {
      const key = dayKey(row.ts);
      if (key === todayKey) continue;
      const existing = byDay.get(key);
      if (existing) existing.push(row);
      else byDay.set(key, [row]);
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .map(([key, dayRows]) => ({ key, label: dayLabel(key), rows: dayRows }));
  }, [visibleRows, todayKey]);

  const renderRow = (row: FeedRow) => {
    const quote = row.ticker ? quotes.get(row.ticker) : undefined;
    const pct = quote ? Number((quote.changePct * 100).toFixed(1)) : null;
    const pctDir = pct === null ? "" : pct > 0 ? "up" : pct < 0 ? "down" : "";
    const subDollar = quote != null && quote.price < SUB_DOLLAR_FLAG_PRICE;
    const isHigh = row.priority === "high" || row.signalCount >= 3;
    return (
      <tr key={row.key} className={isHigh || subDollar ? "trigger-feed-row-high" : undefined}>
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
          {subDollar && (
            <span
              className="confluence-badge confluence-badge-subfive"
              title={`Trading under $${SUB_DOLLAR_FLAG_PRICE}/share — flagged high priority`}
            >
              UNDER ${SUB_DOLLAR_FLAG_PRICE}
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
        <td className="col-category">{row.triggerName ? triggerCategoryLabel(row.triggerName) : "—"}</td>
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
  };

  const table = (rowsToRender: FeedRow[]) => (
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
        <tbody>{rowsToRender.map(renderRow)}</tbody>
      </table>
    </div>
  );

  // --- History surface (Reports page): earlier days as dropdowns ---
  if (mode === "history") {
    if (loaded && historyGroups.length === 0) {
      return <p className="empty-state">No trigger activity from earlier days.</p>;
    }
    return (
      <div className="trigger-feed-days">
        {historyGroups.map((group) => (
          <details
            key={group.key}
            className="trigger-feed-day"
            open={expandedDays.has(group.key)}
            onToggle={(e) => {
              const open = e.currentTarget.open;
              setExpandedDays((prev) => {
                const next = new Set(prev);
                if (open) next.add(group.key);
                else next.delete(group.key);
                return next;
              });
            }}
          >
            <summary>
              {group.label} <span className="trigger-feed-day-count">({group.rows.length})</span>
            </summary>
            {table(group.rows)}
          </details>
        ))}
      </div>
    );
  }

  // --- Today surface (dashboard): one open frame, label inside ---
  let body: React.ReactNode;
  if (!loaded) {
    body = <p className="top-movers-empty">Loading…</p>;
  } else if (todayRows.length === 0) {
    body =
      rows.length === 0 ? (
        <p className="top-movers-empty">
          No trigger activity yet — fires show up here live once eod-scan / intraday-scan / the realtime
          worker run.
        </p>
      ) : quotesReady ? (
        <p className="top-movers-empty">
          Nothing today is in the ${band.price_min.toFixed(2)}–${band.price_max.toFixed(2)} band.
        </p>
      ) : (
        <p className="top-movers-empty">Loading quotes…</p>
      );
  } else {
    body = table(todayRows);
  }

  return (
    <section className="trigger-feed-panel">
      <h2 className="trigger-feed-panel-title">Trigger feed</h2>
      {body}
    </section>
  );
}
