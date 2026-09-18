import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { triggerLabel, triggerSide, TRIGGER_INFO } from "../lib/triggerInfo";
import { InfoTooltip } from "./InfoTooltip";
import { FlagIcon, flagIconName } from "./FlagIcon";
import { useQuotes } from "./QuoteTag";

// The feed shows every trigger fire — fires still sitting in
// pending_fires (out of band, so never promoted) alongside the promoted
// trigger_events, one per fire since the confluence gate was removed
// (2026-09-17). Scoped to scan_config's price band; sub-$1 gets its own flag.
// Rows we can't price yet stay visible until a quote lands.
const SUB_DOLLAR_FLAG_PRICE = 1;
const DEFAULT_BAND = { price_min: 0.1, price_max: 3 };

interface RiskFlag {
  level: "red" | "amber" | "green";
  label: string;
  note?: string;
}

// Feed flag display order: negatives first, positives last.
const FLAG_ORDER: Record<RiskFlag["level"], number> = { red: 0, amber: 1, green: 2 };

interface FeedRow {
  key: string; // "e<id>" | "p<id>"
  ts: string;
  symbol_id: number;
  ticker: string | null;
  triggerName: string | null;
  priority: "normal" | "high" | null;
  status: string; // "pending" for un-promoted single fires
  riskFlags: RiskFlag[]; // from the linked dossier (promoted events only)
  side: "buy" | "watch" | "sell"; // exit / bearish -> sell; watch triggers or red-flagged buys -> watch
  /** fires of this trigger on this stock this session (rows are collapsed) */
  fireCount: number;
  lastTs: string;
  /** Price when the trigger fired (static), from the fire's snapshot. */
  firePrice: number | null;
}

/**
 * The price a fire happened at, from its stored snapshot. Each source keys
 * it differently: exits carry exit_price, live intraday alerts latest_price
 * / last_price, the realtime worker price, after-close setups close.
 */
function firePriceOf(snapshot: unknown): number | null {
  const s = (snapshot ?? {}) as Record<string, unknown>;
  for (const k of ["exit_price", "latest_price", "last_price", "price", "close"]) {
    const v = Number(s[k]);
    if (s[k] != null && Number.isFinite(v) && v > 0) return v;
  }
  return null;
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

/** "3:22" — hour and minute only, for the compact re-fire note. */
function hourMinute(iso: string): string {
  return new Date(iso)
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true })
    .replace(/\s?[AP]M$/i, "");
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
 * Fired-trigger feed, grouped by day and updated in real time via Supabase
 * Realtime. Two sources, merged by timestamp:
 *  - `trigger_events` — promoted events (one per in-band fire)
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
          // `dossiers(risk_flags:analysis->risk_flags)` projects just the
          // flag array out of the (large) analysis JSON.
          .select(
            "id, ts, status, priority, symbol_id, trigger_id, snapshot, symbols(ticker, alert_excluded), triggers(name), dossiers(risk_flags:analysis->risk_flags)",
          )
          .order("ts", { ascending: false })
          .limit(400),
        supabase
          .from("pending_fires")
          .select("id, created_at, symbol_id, trigger_id, snapshot, symbols(ticker, alert_excluded), triggers(name)")
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
        snapshot: unknown;
        symbols: { ticker: string; alert_excluded: boolean } | null;
        triggers: { name: string } | null;
        dossiers: { risk_flags: RiskFlag[] | null }[] | null;
      };
      type RawPending = {
        id: number;
        created_at: string;
        symbol_id: number;
        snapshot: unknown;
        symbols: { ticker: string; alert_excluded: boolean } | null;
        triggers: { name: string } | null;
      };

      const events: FeedRow[] = ((eventsRes.data as unknown as RawEvent[]) ?? [])
        .filter((r) => !r.symbols?.alert_excluded)
        .map((r) => {
        return {
          key: `e${r.id}`,
          ts: r.ts,
          symbol_id: r.symbol_id,
          ticker: r.symbols?.ticker ?? null,
          triggerName: r.triggers?.name ?? null,
          priority: r.priority,
          status: r.status,
          riskFlags: (r.dossiers?.[0]?.risk_flags ?? []).map((x) => ({
            level: x.level,
            label: x.label,
            note: x.note,
          })),
          side: triggerSide(r.triggers?.name ?? null),
          firePrice: firePriceOf(r.snapshot),
          fireCount: 1,
          lastTs: r.ts,
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
        riskFlags: [],
        side: triggerSide(r.triggers?.name ?? null),
        firePrice: firePriceOf(r.snapshot),
        fireCount: 1,
        lastTs: r.created_at,
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

  const rows = useMemo(() => {
    // One row per stock + trigger + session: keep the FIRST fire (its Fired at
    // price stays the reference) and count the re-fires.
    const byKey = new Map<string, FeedRow>();
    for (const r of [...eventRows, ...pendingRows].sort((a, b) => (a.ts < b.ts ? -1 : 1))) {
      const key = `${r.symbol_id}|${r.triggerName}|${dayKey(r.ts)}`;
      const first = byKey.get(key);
      if (!first) {
        byKey.set(key, { ...r });
        continue;
      }
      first.fireCount += 1;
      if (r.ts > first.lastTs) first.lastTs = r.ts;
      if (!first.riskFlags.length && r.riskFlags.length) first.riskFlags = r.riskFlags;
      if (first.status === "pending" && r.status !== "pending") first.status = r.status;
    }
    // A buy setup carrying a red flag (a real negative) is shown as Watch.
    for (const r of byKey.values()) {
      if (r.side === "buy" && r.riskFlags.some((f) => f.level === "red")) r.side = "watch";
    }
    return [...byKey.values()].sort((a, b) => (a.ts < b.ts ? 1 : -1));
  }, [eventRows, pendingRows]);

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
    // Change since the trigger fired: current price vs the static fire price.
    const pct =
      quote && row.firePrice ? Number(((quote.price / row.firePrice - 1) * 100).toFixed(1)) : null;
    const pctDir = pct === null ? "" : pct > 0 ? "up" : pct < 0 ? "down" : "";
    // Sub-$1 is computed here from the live quote so it shows on un-promoted
    // pending fires too; suppress it when the dossier already carries it.
    const subDollar =
      quote != null &&
      quote.price < SUB_DOLLAR_FLAG_PRICE &&
      !row.riskFlags.some((f) => f.label.startsWith("Sub-$1"));
    const hasRed = row.riskFlags.some((f) => f.level === "red");
    const isHigh = row.priority === "high";
    return (
      <tr key={row.key} className={isHigh || hasRed ? "trigger-feed-row-high" : undefined}>
        <td>
          {timeOnly(row.ts)}
          {row.fireCount > 1 && (
            <span
              className="feed-refire"
              title={`Fired ${row.fireCount} times this session; last at ${timeOnly(row.lastTs)}. Fired at is the first fire.`}
            >
              {" "}×{row.fireCount} - {hourMinute(row.lastTs)}
            </span>
          )}
        </td>
        <td>
          <Link to={`/symbol/${row.ticker ?? row.symbol_id}`}>{row.ticker ?? row.symbol_id}</Link>
        </td>
        <td className="col-catalyst">
          {/* Why it's listed: the trigger(s) behind this row. */}
          {(row.triggerName ? [row.triggerName] : []).map((name) => (
            <InfoTooltip key={name} underline={false} text={TRIGGER_INFO[name]?.summary ?? triggerLabel(name)}>
              <span className={`catalyst-chip catalyst-${row.side}`}>{triggerLabel(name)}</span>
            </InfoTooltip>
          ))}
        </td>
        <td className="col-flags">
          {subDollar && (
            <InfoTooltip underline={false} text="Sub-$1 — trading under $1/share, the lowest-price tier (highest manipulation and delisting risk).">
              <span className="feed-flag feed-flag-amber">
                <FlagIcon name="subdollar" />
              </span>
            </InfoTooltip>
          )}
          {[...row.riskFlags]
            .sort((a, b) => FLAG_ORDER[a.level] - FLAG_ORDER[b.level])
            .map((f) => (
              <InfoTooltip
                key={f.label}
                underline={false}
                text={f.note ? `${f.label} — ${f.note}` : f.label}
              >
                <span className={`feed-flag feed-flag-${f.level}`}>
                  <FlagIcon name={flagIconName(f.label)} />
                </span>
              </InfoTooltip>
            ))}
        </td>
        <td className="col-num">{row.firePrice != null ? `$${row.firePrice.toFixed(2)}` : "—"}</td>
        <td className="col-num">{quote ? `$${quote.price.toFixed(2)}` : "—"}</td>
        <td className={`col-num ${pctDir}`}>
          {pct === null ? "—" : `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`}
        </td>
      </tr>
    );
  };

  const table = (rowsToRender: FeedRow[]) => (
    <div className="trigger-feed-scroll">
      <table className="trigger-feed">
        {/* Each side (Buy / Watch / Sell) is its own table, so without a
            fixed layout they size their columns independently and the
            sections don't line up down the page. */}
        <colgroup>
          <col className="col-time" />
          <col className="col-symbol" />
          <col className="col-catalyst" />
          <col className="col-flags" />
          <col className="col-num" />
          <col className="col-num" />
          <col className="col-num" />
        </colgroup>
        <thead>
          <tr>
            <th>Time</th>
            <th>Symbol</th>
            <th className="col-catalyst">Catalyst</th>
            <th className="col-flags">Flags</th>
            <th className="col-num">
              <InfoTooltip underline={false} text="Price when the trigger fired. Fixed; it never updates.">Fired at</InfoTooltip>
            </th>
            <th className="col-num">Price</th>
            <th className="col-num">
              <InfoTooltip underline={false} text="Change from the fired-at price to the current price: how the stock has done since the trigger.">Change</InfoTooltip>
            </th>
          </tr>
        </thead>
        <tbody>{rowsToRender.map(renderRow)}</tbody>
      </table>
    </div>
  );

  // Buy Signals / Sell Signals split. `showEmpty` keeps both headers on
  // the dashboard so the split is always visible; history hides an empty
  // side to cut clutter.
  const sidedSections = (rowsToRender: FeedRow[], showEmpty: boolean) => {
    const block = (title: string, side: "buy" | "watch" | "sell") => {
      const sideRows = rowsToRender.filter((r) => r.side === side);
      if (!sideRows.length && !showEmpty) return null;
      return (
        <div className={`trigger-feed-side trigger-feed-side-${side}`}>
          <h3 className="trigger-feed-side-title">
            {title} <span className="trigger-feed-side-count">{sideRows.length}</span>
          </h3>
          {sideRows.length ? table(sideRows) : <p className="top-movers-empty">None.</p>}
        </div>
      );
    };
    return (
      <>
        {block("Buy Signals", "buy")}
        {block("Watch", "watch")}
        {block("Sell Signals", "sell")}
      </>
    );
  };

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
            {sidedSections(group.rows, false)}
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
    body = sidedSections(todayRows, true);
  }

  return (
    <section className="trigger-feed-panel">
      <h2 className="trigger-feed-panel-title">Trigger feed</h2>
      {body}
    </section>
  );
}
