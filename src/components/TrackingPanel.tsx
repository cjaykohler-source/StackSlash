import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Line, LineChart, ResponsiveContainer, Tooltip, YAxis } from "recharts";
import { supabase } from "../lib/supabaseClient";
import { useQuotes, type Quote } from "./QuoteTag";

interface Tracked {
  symbol_id: number;
  ticker: string;
  name: string | null;
}

const REFRESH_MS = 60_000;

/**
 * Dashboard "Tracking" panel — a user-curated watchlist (persisted in the
 * `tracked_symbols` table). Search a ticker, hit Track, and it gets a
 * live mini chart that repolls every minute. Sits above the trigger feed.
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
    REFRESH_MS,
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
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;
    async function loadSeries() {
      const dayStart = new Date();
      dayStart.setUTCHours(0, 0, 0, 0);
      const { data } = await supabase
        .from("bars_intraday")
        .select("ts, price")
        .eq("symbol_id", tracked.symbol_id)
        .gte("ts", dayStart.toISOString())
        .order("ts", { ascending: false })
        .limit(400);
      if (cancelledRef.current) return;
      const rows = (data as { ts: string; price: number }[] | null) ?? [];
      setSeries(rows.reverse().map((r) => ({ t: new Date(r.ts).getTime(), price: Number(r.price) })));
    }
    loadSeries();
    const id = setInterval(loadSeries, REFRESH_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(id);
    };
  }, [tracked.symbol_id]);

  // Live tip: append the current quote price as the latest point so the
  // line's end moves every minute even between 5-min bar ingests.
  const points = [...series];
  if (quote && (points.length === 0 || quote.price !== points[points.length - 1].price)) {
    points.push({ t: Date.now(), price: quote.price });
  }

  const changePct =
    quote?.changePct ??
    (points.length >= 2 && points[0].price > 0 ? points[points.length - 1].price / points[0].price - 1 : null);
  const price = quote?.price ?? (points.length ? points[points.length - 1].price : null);
  const dir = changePct == null ? "" : changePct > 0 ? "up" : changePct < 0 ? "down" : "";
  const stroke = dir === "up" ? "#25e979" : dir === "down" ? "#e74c3c" : "#8b93a7";

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
          <span className="tracked-chart-empty">No intraday data yet</span>
        ) : (
          <ResponsiveContainer width="100%" height={72}>
            <LineChart data={points} margin={{ top: 4, bottom: 4, left: 0, right: 0 }}>
              <YAxis hide domain={["dataMin", "dataMax"]} />
              <Tooltip
                labelFormatter={() => ""}
                formatter={(v: number) => [`$${v.toFixed(2)}`, ""]}
                contentStyle={{ fontSize: "0.75rem", padding: "2px 6px" }}
                labelStyle={{ color: "#000" }}
              />
              <Line type="monotone" dataKey="price" stroke={stroke} strokeWidth={1.75} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
      {tracked.name && <div className="tracked-name">{tracked.name}</div>}
    </div>
  );
}
