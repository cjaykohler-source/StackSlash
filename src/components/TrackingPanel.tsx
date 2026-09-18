import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";
import { etDateString, sessionAxis } from "../lib/marketTime";
import { PriceChart, type PricePoint } from "./PriceChart";
import { useQuotes, type Quote } from "./QuoteTag";
import { SpotlightIcon } from "./SpotlightIcon";
import { useTracking, type TrackedSymbol as Tracked } from "../lib/useTracking";

// The live quote (price + intraday %) polls fast; the chart's bar series
// reloads slowly, since bars_intraday only updates every ~5 min and the
// current quote is appended as the line's tip between reloads.
const QUOTE_MS = 15_000;
const SERIES_MS = 90_000;

/**
 * Dashboard "Spotlight" grid — the live mini charts at the top of the
 * page. It shows only the tracked symbols flagged `spotlight`; everything
 * else tracked lives as a row in the sidebar's Tracking column, where the
 * spotlight toggle lifts it up here. Renders nothing when none are lit.
 */
export function TrackingPanel() {
  const { tracked, setSpotlight } = useTracking();
  const spotlit = tracked.filter((t) => t.spotlight);

  // One batched, self-repolling quote fetch for every spotlit ticker.
  const quotes = useQuotes(
    spotlit.map((t) => t.ticker),
    QUOTE_MS,
  );

  // Nothing spotlit: the Tracking column in the sidebar is the whole
  // watchlist, and this grid stays out of the way.
  if (spotlit.length === 0) return null;

  return (
    <section className="tracking">
      <div className="tracking-head">
        <h2>Spotlight</h2>
        <span className="tracking-hint">
          {spotlit.length} of {tracked.length} tracked · the rest are in the Tracking column
        </span>
      </div>
      <div className="tracking-grid">
        {spotlit.map((t) => (
          <TrackedCard
            key={t.symbol_id}
            tracked={t}
            quote={quotes.get(t.ticker)}
            onRemove={() => setSpotlight(t.symbol_id, false)}
          />
        ))}
      </div>
    </section>
  );
}

interface Point {
  t: number; // epoch ms, for the chart
  price: number;
}

/** Regular US session, roughly: weekday 09:30-16:05 ET. */
function isSessionLive(): boolean {
  const now = new Date();
  const utcHM = now.getUTCHours() * 100 + now.getUTCMinutes();
  return now.getUTCDay() >= 1 && now.getUTCDay() <= 5 && utcHM >= 1330 && utcHM < 2005;
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
  // Today's line came from the consolidated tape, ~15 min behind, because
  // this symbol has no real-time IEX prints today.
  const [delayed, setDelayed] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    cancelledRef.current = false;

    const fromIntradayRows = (rows: { ts: string; price: number }[]) =>
      rows.map((r) => ({ t: new Date(r.ts).getTime(), price: Number(r.price) }));

    async function loadSeries() {
      // Today first, always. A thin name with a single print today used to
      // fail a `>= 2 bars` test and fall through to the prior session (or
      // the 30-day daily line), so two cards side by side could be showing
      // different days with only a small tag to say so. Now the only reason
      // to show another day is having no print today at all.
      const todayET = etDateString(Date.now());
      const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      const { data } = await supabase
        .from("bars_intraday")
        .select("ts, price")
        .eq("symbol_id", tracked.symbol_id)
        .gte("ts", cutoff)
        .order("ts", { ascending: false })
        .limit(500);
      if (cancelledRef.current) return;
      const rows = ((data as { ts: string; price: number }[] | null) ?? []).reverse();
      const dayOf = (ts: string) => etDateString(new Date(ts));
      const todayRows = rows.filter((r) => dayOf(r.ts) === todayET);

      // 1. Today's stored (IEX) bars, but only while they're actually
      //    current. One early print and then silence is not "today": FBDT
      //    traded 313 shares at 10:00 ET on 2026-09-18 and nothing more on
      //    IEX, while the tape had it 6% lower — a flat line pretending to
      //    be the session. Sparse or stalled falls through to the tape.
      const lastStored = todayRows.length ? Date.parse(todayRows[todayRows.length - 1].ts) : 0;
      const storedIsCurrent = todayRows.length >= 2 && Date.now() - lastStored < 20 * 60_000;
      if (todayRows.length && (storedIsCurrent || !isSessionLive())) {
        setIntraday(true);
        setSessionLabel(null);
        setDelayed(false);
        setSeries(fromIntradayRows(todayRows));
        return;
      }

      // 2. Nothing stored for today — this symbol may just not be in
      //    intraday-bars-scan's priority set. Ask session-bars, which pulls
      //    the most recent session on demand.
      let onDemand: { ts: string; price: number }[] = [];
      let onDemandDelayed = false;
      try {
        const res = await fetch(`/.netlify/functions/session-bars?symbol=${encodeURIComponent(tracked.ticker)}`);
        const body = (await res.json()) as { bars?: { ts: string; price: number }[]; delayed?: boolean };
        if (cancelledRef.current) return;
        onDemand = body.bars ?? [];
        onDemandDelayed = body.delayed === true;
      } catch {
        /* fall through */
      }
      if (onDemand.length && dayOf(onDemand[onDemand.length - 1].ts) === todayET) {
        setIntraday(true);
        setSessionLabel(null);
        setDelayed(onDemandDelayed);
        setSeries(fromIntradayRows(onDemand.filter((b) => dayOf(b.ts) === todayET)));
        return;
      }

      // 3. No print today anywhere: the most recent prior session, labelled
      //    with its date so it can't be mistaken for today.
      const priorSource = rows.length >= 2 ? rows : onDemand.length >= 2 ? onDemand : [];
      if (priorSource.length >= 2) {
        const targetDay = dayOf(priorSource[priorSource.length - 1].ts);
        setIntraday(true);
        setDelayed(false);
        setSessionLabel(new Date(`${targetDay}T12:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric" }));
        setSeries(fromIntradayRows(priorSource.filter((r) => dayOf(r.ts) === targetDay)));
        return;
      }

      // 4. Truly no intraday data (delisted / no IEX prints) — daily line.
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
      setDelayed(false);
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
  // Append even when the price is unchanged, as long as time has moved on:
  // a thin name whose only print is the open should still draw a flat line
  // to now, not sit on "waiting for prints" next to fuller cards.
  if (
    showingToday &&
    quote &&
    (points.length === 0 ||
      quote.price !== points[points.length - 1].price ||
      Date.now() - points[points.length - 1].t > 60_000)
  ) {
    points.push({ t: Date.now(), price: quote.price });
  }

  const changePct = quote?.changePct ?? null;
  const price = quote?.price ?? (points.length ? points[points.length - 1].price : null);
  const dir = changePct == null ? "" : changePct > 0 ? "up" : changePct < 0 ? "down" : "";
  const stroke =
    dir === "up" ? "var(--brand-green)" : dir === "down" ? "var(--red)" : "var(--text-dim)";

  // Map to PriceChart's model. Intraday runs the regular session only
  // (9:30a–4:00p ET) across the full card width, like the symbol page's
  // Session chart; the line fills in from the left as the session runs.
  // Before the open (pre-market prints only) it falls back to the full
  // 4a–8p frame so the card isn't blank. The daily fallback keeps a plain
  // categorical axis.
  const fullSession = intraday ? sessionAxis(Date.now()) : null;
  const regularPoints = fullSession
    ? points.filter((p) => {
        const u = fullSession.toX(p.t);
        return u >= fullSession.open && u <= fullSession.close;
      })
    : [];
  const useRegular = fullSession !== null && regularPoints.length >= 2;
  const daySession =
    fullSession && useRegular
      ? { ...fullSession, domain: [fullSession.open, fullSession.close] as typeof fullSession.domain }
      : fullSession;
  const shown = useRegular ? regularPoints : points;
  const chartData: PricePoint[] = daySession
    ? shown.map((p) => ({ x: daySession.toX(p.t), y: p.price, t: p.t }))
    : shown.map((p) => ({
        x: new Date(p.t).toLocaleDateString([], { month: "short", day: "numeric" }),
        y: p.price,
      }));

  return (
    <div className="tracked-card">
      <div className="tracked-card-head">
        <Link to={`/symbol/${tracked.ticker}`} className="tracked-ticker">
          {tracked.ticker}
        </Link>
        <button
          className="tracked-remove"
          onClick={onRemove}
          aria-label={`Remove ${tracked.ticker} from the Spotlight`}
          title={`Remove ${tracked.ticker} from the Spotlight (stays tracked)`}
        >
          <SpotlightIcon on />
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
        {shown.length < 2 ? (
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
            {intraday && !sessionLabel && delayed && (
              <span className="tracked-chart-tag" title="Consolidated tape, ~15 minutes behind — this stock has no real-time (IEX) prints today.">
                tape · ~15m behind
              </span>
            )}
          </>
        )}
      </div>
      {tracked.name && <div className="tracked-name">{tracked.name}</div>}
    </div>
  );
}
