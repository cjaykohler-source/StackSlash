import { fetchSipBars } from "./lib/alpaca";
import { etWallClock } from "./lib/etTime";

/**
 * On-demand candlestick data for one symbol-session: every consolidated-
 * tape (SIP) 1-minute bar from 04:00 to 20:00 ET with open/high/low/close,
 * volume, VWAP and trade count, plus the prior session's close. Powers the
 * symbol page's Session view. Nothing is stored.
 *
 * bars_intraday can't serve this: it keeps only close + volume, from IEX
 * (one exchange's slice of the tape — a median ~1% of real volume on
 * sub-$5 names, measured 2026-09-11).
 *
 *   GET /.netlify/functions/session-candles?symbol=AAPL                 -> most recent session
 *   GET /.netlify/functions/session-candles?symbol=AAPL&date=2019-03-14 -> that session
 *
 * The free data plan only serves SIP data older than 15 minutes, so a
 * session still in progress is returned up to now - 16 min (`delayed`).
 * A date with no trading (weekend, holiday, halt) returns bars: [].
 */
const SIP_DELAY_MS = 16 * 60_000;
const DAY_MS = 86_400_000;

export default async (req: Request) => {
  const url = new URL(req.url);
  const ticker = url.searchParams.get("symbol")?.trim().toUpperCase();
  const dateParam = url.searchParams.get("date")?.trim() || null;
  const json = (body: unknown, status = 200, maxAge = 60) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${maxAge}` },
    });

  if (!ticker || !/^[A-Z][A-Z0-9./-]{0,9}$/.test(ticker)) return json({ error: "missing or invalid ?symbol" }, 400, 0);
  if (dateParam && !/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) return json({ error: "date must be YYYY-MM-DD" }, 400, 0);

  const now = Date.now();
  const cap = now - SIP_DELAY_MS;
  try {
    let sessionDate = dateParam;
    if (!sessionDate) {
      // Most recent session = newest daily bar in the last 10 days
      // (handles weekends, holidays and a name whose last print was days ago).
      const recent = await fetchSipBars(ticker, "1Day", new Date(now - 10 * DAY_MS).toISOString(), new Date(cap).toISOString());
      if (!recent.length) return json({ symbol: ticker, session_date: null, prev_close: null, bars: [] });
      // Daily bars are stamped midnight ET in UTC, so the UTC date is the session date.
      sessionDate = recent[recent.length - 1].t.slice(0, 10);
    }

    const sessionEnd = etWallClock(sessionDate, 20, 0);
    const start = etWallClock(sessionDate, 4, 0);
    const end = Math.min(sessionEnd, cap);
    if (end <= start) {
      return json({ symbol: ticker, session_date: sessionDate, prev_close: null, bars: [], delayed: true }, 200, 60);
    }

    const [bars, prior] = await Promise.all([
      fetchSipBars(ticker, "1Min", new Date(start).toISOString(), new Date(end).toISOString()),
      fetchSipBars(ticker, "1Day", new Date(start - 12 * DAY_MS).toISOString(), new Date(start).toISOString()),
    ]);
    const prev = prior.filter((b) => b.t.slice(0, 10) < sessionDate!).pop();
    const inProgress = end < sessionEnd;

    return json(
      {
        symbol: ticker,
        session_date: sessionDate,
        prev_close: prev?.c ?? null,
        prev_date: prev?.t.slice(0, 10) ?? null,
        delayed: inProgress,
        as_of: new Date(end).toISOString(),
        bars: bars.map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, vw: b.vw ?? null, n: b.n ?? null })),
      },
      200,
      // A finished session never changes; one in progress refreshes every minute.
      inProgress ? 60 : DAY_MS / 1000,
    );
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "fetch failed" }, 502, 0);
  }
};
