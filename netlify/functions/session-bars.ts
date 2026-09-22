import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { fetchIntradayBarsRange, fetchDelayedSipMinutesToday } from "./lib/alpaca";
import { etDateString, etWallClock } from "./lib/etTime";

/**
 * On-demand: fetch the most recent trading session's 1-minute bars for a
 * single symbol and store them in bars_intraday, so the "Day" chart and
 * the tracking-panel mini charts work for EVERY symbol — not just the
 * ~1,200 in intraday-bars-scan's priority set.
 *
 * The frontend calls this when it opens a chart and finds no intraday
 * rows for a recent session. Cheap (one Alpaca request), cached by the
 * upsert (a second view of the same symbol the same session is a no-op),
 * and it fills the row for intraday-bars-scan-covered symbols too if
 * they've somehow fallen behind.
 *
 *   GET /.netlify/functions/session-bars?symbol=AAPL
 *   -> { symbol, session_date, bars: [{ ts, price }], delayed? }
 *      (bars: [] if none)
 *
 * IEX-only names: any time within 4:00a–8:05p ET, if IEX has nothing for
 * today, it falls back to the consolidated tape delayed ~16 minutes and
 * sets `delayed: true`. Those bars are returned but NOT stored —
 * bars_intraday is the IEX real-time series the factor and trigger layers
 * read, and mixing feeds into it would repeat the volume distortion the
 * 2026-09-17 SIP reload just fixed.
 *
 * The fallback window is the whole extended session, so pre-market and
 * after-hours reach the chart. That is as close to real time as this data
 * gets: the free plan refuses SIP newer than 15 minutes, and IEX — the
 * feed that would be live — sees almost nothing on a thin sub-$5 name
 * outside regular hours. Extended-hours bars are therefore always ~16
 * minutes behind, and `delayed` says so.
 */
export default async (req: Request) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=120" },
    });

  const ticker = new URL(req.url).searchParams.get("symbol")?.trim().toUpperCase();
  if (!ticker) return json({ error: "missing ?symbol" }, 400);

  const db = getSupabaseAdmin();
  const { data: sym } = await db.from("symbols").select("id").eq("ticker", ticker).maybeSingle();
  if (!sym) return json({ error: `unknown symbol ${ticker}` }, 404);
  const symbolId = sym.id as number;

  // Serve straight from the DB (no Alpaca call) when what's stored is
  // already the current session:
  //   - has bars dated today  -> always fresh enough
  //   - market closed AND has bars from the last ~4 days -> that IS the
  //     most recent session and it won't change until the next open
  const now = new Date();
  // ET, not UTC. The old form compared UTC hours against fixed 1330/2005
  // bounds, which only line up with 9:30a-4:05p ET under EDT -- in EST it
  // made the window 8:30a-3:05p, admitting an hour of pre-market and
  // dropping the last hour of the session. It also took the session date
  // from the UTC date, which rolls over at 8:00p ET (EDT) -- exactly the
  // end of the extended session this now has to serve.
  const todayStr = etDateString(now);
  const weekday = new Date(`${todayStr}T12:00:00Z`).getUTCDay();
  // 4:00a-8:05p ET: the whole extended session, not just regular hours.
  // Before this, the delayed-tape fallback below was gated to regular
  // hours, so a thin name had no pre-market at all -- the opposite of what
  // a pre-open report needs (README "Still open" 8).
  const sessionActive =
    weekday >= 1 &&
    weekday <= 5 &&
    now.getTime() >= etWallClock(todayStr, 4, 0) &&
    now.getTime() < etWallClock(todayStr, 20, 5);

  const { data: existing } = await db
    .from("bars_intraday")
    .select("ts, price")
    .eq("symbol_id", symbolId)
    .gte("ts", new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString())
    .order("ts", { ascending: true })
    .limit(1000);
  const existingRows = (existing as { ts: string; price: number }[] | null) ?? [];
  const STALE_BAR_MS = 20 * 60_000;
  const todayStored = existingRows.filter((b) => b.ts.slice(0, 10) === todayStr);
  // A thin name's IEX series can be one early print and then nothing for
  // hours while the tape keeps trading, so "has bars today" isn't the same
  // as "is current". Treat a sparse or stalled today as no today at all.
  const storedIsCurrent =
    todayStored.length >= 2 &&
    Date.now() - Date.parse(todayStored[todayStored.length - 1].ts) < STALE_BAR_MS;
  if (existingRows.length >= 2) {
    const lastDay = existingRows[existingRows.length - 1].ts.slice(0, 10);
    if ((lastDay === todayStr && (storedIsCurrent || !sessionActive)) || (!sessionActive && lastDay !== todayStr)) {
      return json({
        symbol: ticker,
        session_date: lastDay,
        bars: existingRows.filter((b) => b.ts.slice(0, 10) === lastDay),
      });
    }
  }

  // Pull the last few calendar days of 1-min bars; the newest date present
  // IS the most recent session (handles weekends / holidays / a halted or
  // thinly-traded name whose last print was days ago).
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let bars: { t: string; c: number; v: number }[] = [];
  try {
    let pageToken: string | undefined;
    do {
      const res = await fetchIntradayBarsRange([ticker], start, end, pageToken);
      bars.push(...(res.bars[ticker] ?? []));
      pageToken = res.nextPageToken ?? undefined;
    } while (pageToken);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "fetch failed" }, 502);
  }

  const sessionDateOf = (rows: { t: string }[]) =>
    rows.reduce((mx, b) => (b.t.slice(0, 10) > mx ? b.t.slice(0, 10) : mx), "");

  // A running session with no IEX print today: ask the tape instead of
  // handing back yesterday labelled as the latest session. In pre-market
  // and after-hours this is the ONLY source -- IEX is near-blind on thin
  // sub-$5 names at the best of times and routinely silent outside regular
  // hours. These bars are returned but never stored: bars_intraday is the
  // IEX real-time series the factor and trigger layers read, and mixing
  // feeds into it would repeat the volume distortion the 2026-09-17 SIP
  // reload fixed.
  const iexToday = bars.filter((b) => b.t.slice(0, 10) === todayStr);
  if (sessionActive && (iexToday.length < 2 || !storedIsCurrent)) {
    try {
      const sip = await fetchDelayedSipMinutesToday(ticker);
      // Only worth swapping in if the tape actually sees more than IEX did.
      if (sip.length > iexToday.length) {
        return json({
          symbol: ticker,
          session_date: todayStr,
          delayed: true,
          bars: sip.map((b) => ({ ts: b.t, price: b.c })),
        });
      }
    } catch {
      /* fall through to whatever IEX had */
    }
  }

  if (!bars.length) return json({ symbol: ticker, session_date: null, bars: [] });

  const sessionDate = sessionDateOf(bars);
  const sessionBars = bars.filter((b) => b.t.slice(0, 10) === sessionDate);

  const rows = sessionBars.map((b) => ({ symbol_id: symbolId, ts: b.t, price: b.c, volume: b.v }));
  const { error } = await db.from("bars_intraday").upsert(rows, { onConflict: "symbol_id,ts" });
  if (error) return json({ error: error.message }, 500);

  return json({
    symbol: ticker,
    session_date: sessionDate,
    bars: sessionBars.map((b) => ({ ts: b.t, price: b.c })),
  });
};
