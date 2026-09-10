import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { etDateString, sessionAxis } from "../lib/marketTime";
import { PriceChart, type PricePoint } from "./PriceChart";
import { useQuotes, type Quote } from "./QuoteTag";

interface Tracked {
  symbol_id: number;
  ticker: string;
  name: string | null;
}

// The live quote (price + intraday %) polls fast; the chart's bar series
// reloads slowly, since bars_intraday only updates every ~5 min and the
// current quote is appended as the line's tip between reloads.
const QUOTE_MS = 15_000;
const SERIES_MS = 90_000;

/**
 * Dashboard "Tracking" panel — a user-curated watchlist (persisted in the
 * `tracked_symbols` table). Search a ticker, hit Track, and it gets a
 * live mini chart. Sits above the trigger feed.
 */
export function TrackingPanel() {
  const [tracked, setTracked] = useState<Tracked[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("tracked_symbols")
      .select("symbol_id, symbols(ticker, name)")
      .order("created_at", { ascending: true });
    const rows = (data as unknown as { symbol_id: number; symbols: { ticker: string; name: string | null } | null }[] | null) ?? [];
    setTracked(
      rows
        .filter((r) => r.symbols)
        .map((r) => ({ symbol_id: r.symbol_id, ticker: r.symbols!.ticker, name: r.symbols!.name })),
    );
  }, []);

  useEffect(() => {
    load();
    const channel = supabase
      .channel("tracked_symbols_panel")
      .on("postgres_changes", { event: "*", schema: "public", table: "tracked_symbols" }, () => load())
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [load]);

  async function track(e: React.FormEvent) {
    e.preventDefault();
    const ticker = input.trim().toUpperCase();
    if (!ticker || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { data: sym } = await supabase.from("symbols").select("id").eq("ticker", ticker).maybeSingle();
      if (!sym) {
        setError(`${ticker} isn't in the tracked universe — add it from the search box at the top first.`);
        return;
      }
      const { error: insErr } = await supabase.from("tracked_symbols").insert({ symbol_id: sym.id });
      if (insErr && insErr.code !== "23505") throw insErr; // 23505 = already tracked, fine
      setInput("");
      await load();
    } catch {
      setError(`Couldn't track ${ticker}.`);
    } finally {
      setBusy(false);
    }
  }

  async function untrack(symbolId: number) {
    await supabase.from("tracked_symbols").delete().eq("symbol_id", symbolId);
    await load();
  }

  // One batched, self-repolling quote fetch for every tracked ticker.
  const quotes = useQuotes(
    tracked.map((t) => t.ticker),
    QUOTE_MS,
  );

  return (
    <section className="tracking">
      <div className="tracking-head">
        <h2>Tracking</h2>
        <form className="tracking-add" onSubmit={track}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Add symbol…"
            aria-label="Symbol to track"
          />
          <button type="submit" disabled={busy || !input.trim()}>
            Track
          </button>
        </form>
      </div>
      {error && <p className="tracking-error">{error}</p>}
      {tracked.length === 0 ? (
        <p className="empty-state">Nothing tracked yet — search a symbol above and hit Track.</p>
      ) : (
        <div className="tracking-grid">
          {tracked.map((t) => (
            <TrackedCard
              key={t.symbol_id}
              tracked={t}
              quote={quotes.get(t.ticker)}
              onRemove={() => untrack(t.symbol_id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

interface Point {
  t: number; // epoch ms, for the chart
  price: number;
}

function TrackedCard({
  tracked,
  quote,
  onRemove,
}: {
  tracked: Tracked;
  quote: Quote | undefined;
  onRemove: () => void;
}) {
  const [series, setSeries] = useState<Point[]>([]);
  const [intraday, setIntraday] = useState(true);
  // Which ET session the intraday line is showing. When the newest bars we
  // have are from a prior session (early morning, or a thin name that
  // hasn't printed on IEX yet today), the card shows that session and
  // labels it — rather than silently looking like "today".
  const [sessionLabel, setSessionLabel] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    const fromIntradayRows = (rows: { ts: string; price: number }[]) =>
      rows.map((r) => ({ t: new Date(r.ts).getTime(), price: Number(r.price) }));

    async function loadSeries() {
      // Most recent session's 1-min bars from bars_intraday.
      const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      const { data } = await supabase
        .from("bars_intraday")
        .select("ts, price")
        .eq("symbol_id", tracked.symbol_id)
        .gte("ts", cutoff)
        .order("ts", { ascending: false })
        .limit(500);
      if (cancelledRef.current) return;
      let rows = ((data as { ts: string; price: number }[] | null) ?? []).reverse();
      // Keep just one ET session: today's if we have any of it, otherwise
      // the most recent prior session (dated by ET, not the UTC calendar —
      // after-hours bars run past midnight UTC).
      if (rows.length) {
        const todayET = etDateString(Date.now());
        const hasToday = rows.some((r) => etDateString(new Date(r.ts)) === todayET);
        const targetDay = hasToday ? todayET : etDateString(new Date(rows[rows.length - 1].ts));
        rows = rows.filter((r) => etDateString(new Date(r.ts)) === targetDay);
        setSessionLabel(
          targetDay === todayET
            ? null
            : new Date(`${targetDay}T12:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric" }),
        );
      }
      if (rows.length >= 2) {
        setIntraday(true);
        setSeries(fromIntradayRows(rows));
        return;
      }

      // Not in intraday-bars-scan's priority set — pull the most recent
      // session on demand (session-bars stores it, so this is one-time).
      try {
        const res = await fetch(`/.netlify/functions/session-bars?symbol=${encodeURIComponent(tracked.ticker)}`);
        const body = (await res.json()) as { bars?: { ts: string; price: number }[] };
        if (cancelledRef.current) return;
        if ((body.bars?.length ?? 0) >= 2) {
          const b = body.bars!;
          const todayET = etDateString(Date.now());
          const barDay = etDateString(new Date(b[b.length - 1].ts));
          setSessionLabel(
            barDay === todayET
              ? null
              : new Date(`${barDay}T12:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric" }),
          );
          setIntraday(true);
          setSeries(fromIntradayRows(b));
          return;
        }
      } catch {
        /* fall through to daily */
      }

      // Truly no intraday data (delisted / no IEX prints) — daily line.
      const { data: daily } = await supabase
        .from("bars_daily")
        .select("date, close")
        .eq("symbol_id", tracked.symbol_id)
        .order("date", { ascending: false })
        .limit(30);
      if (cancelledRef.current) return;
      const drows = (daily as { date: string; close: number }[] | null) ?? [];
      setIntraday(false);
      setSessionLabel(null);
      setSeries(drows.reverse().map((r) => ({ t: new Date(`${r.date}T00:00:00Z`).getTime(), price: Number(r.close) })));
    }
    loadSeries();
    const id = setInterval(loadSeries, SERIES_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(id);
    };
  }, [tracked.symbol_id, tracked.ticker]);

  // On today's intraday series, append the current quote as the latest
  // point so the line's tip moves between 5-min bar ingests. Skip it on
  // the daily fallback and on a prior-session line — grafting a live
  // price onto yesterday's bars just draws a spike to nowhere.
  const showingToday = intraday && sessionLabel === null;
  const points = [...series];
  if (showingToday && quote && (points.length === 0 || quote.price !== points[points.length - 1].price)) {
    points.push({ t: Date.now(), price: quote.price });
  }

  const changePct = quote?.changePct ?? null;
  const price = quote?.price ?? (points.length ? points[points.length - 1].price : null);
  const dir = changePct == null ? "" : changePct > 0 ? "up" : changePct < 0 ? "down" : "";
  const stroke =
    dir === "up" ? "var(--brand-green)" : dir === "down" ? "var(--red)" : "var(--text-dim)";

  // Map to PriceChart's model. Intraday uses the same fixed 4a–8p ET
  // session frame as the symbol page (line fills in from the left as the
  // session runs); the daily fallback keeps a plain categorical axis.
  const daySession = intraday ? sessionAxis(Date.now()) : null;
  const chartData: PricePoint[] = daySession
    ? points.map((p) => ({ x: daySession.toX(p.t), y: p.price, t: p.t }))
    : points.map((p) => ({
        x: new Date(p.t).toLocaleDateString([], { month: "short", day: "numeric" }),
        y: p.price,
      }));

  return (
    <div className="tracked-card">
      <div className="tracked-card-head">
        <Link to={`/symbol/${tracked.ticker}`} className="tracked-ticker">
          {tracked.ticker}
        </Link>
        <button className="tracked-remove" onClick={onRemove} aria-label={`Stop tracking ${tracked.ticker}`}>
          ×
        </button>
      </div>
      <div className="tracked-quote">
        <span className="tracked-price">{price != null ? `$${price.toFixed(2)}` : "—"}</span>
        <span className={`tracked-change ${dir}`}>
          {changePct == null
            ? ""
            : `${changePct > 0 ? "+" : ""}${(changePct * 100).toFixed(1)}%`}
        </span>
      </div>
      <div className="tracked-chart">
        {points.length < 2 ? (
          <span className="tracked-chart-empty">
            {showingToday ? "Waiting for today's prints…" : "No chart data"}
          </span>
        ) : (
          <>
            <PriceChart
              data={chartData}
              variant={intraday ? "intraday" : "calendar"}
              session={daySession ?? undefined}
              compact
              height={72}
              stroke={stroke}
            />
            {!intraday && <span className="tracked-chart-tag">~30d daily</span>}
            {intraday && sessionLabel && (
              <span className="tracked-chart-tag">{sessionLabel} session</span>
            )}
          </>
        )}
      </div>
      {tracked.name && <div className="tracked-name">{tracked.name}</div>}
    </div>
  );
}
