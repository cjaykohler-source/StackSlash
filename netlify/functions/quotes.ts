import { fetchSnapshots, fetchDelayedSipToday } from "./lib/alpaca";

/**
 * Live-ish price + intraday change for a batch of tickers, for the UI.
 *
 * GET /.netlify/functions/quotes?symbols=AAPL,MSFT,NVDA
 *   -> { "AAPL": { "price": 14.89, "changePct": -0.003 }, ... }
 *
 * `changePct` is measured from today's official open (Alpaca snapshot
 * `dailyBar.o`), i.e. the same "since the open" delta a broker app shows
 * during the session. Outside market hours the snapshot's dailyBar is
 * the last session's, so this reports that session's open->close move.
 *
 * Snapshots are IEX (the only real-time feed this plan has). For a thin
 * name IEX can see nothing all session while the tape trades: the
 * snapshot then serves the PREVIOUS session's daily bar, and reporting
 * that as "today" is not a rounding error — on 2026-09-18 it showed MOB
 * at +0.2% while the tape had it at -6%. So during a session, any symbol
 * whose snapshot is not from today falls back to the consolidated tape,
 * delayed ~15 minutes, and comes back marked `delayed: true` for the UI
 * to label. A symbol that really has not traded today is simply absent.
 *
 * Alpaca snapshots, fetched in chunks of 120 (the feed can ask for 300+
 * tickers at once). Cached 30s at the edge so a dashboard refresh doesn't
 * re-hit Alpaca.
 */
export default async (req: Request) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=15" },
    });

  const symbolsParam = new URL(req.url).searchParams.get("symbols");
  if (!symbolsParam) return json({});

  const symbols = [
    ...new Set(
      symbolsParam
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  ].slice(0, 600);
  if (!symbols.length) return json({});

  // Alpaca's snapshot endpoint handles large symbol lists, but chunk
  // anyway so one big list can't be silently truncated and a transient
  // failure only loses one chunk. The feed can ask for 200+ tickers.
  const CHUNK = 120;
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += CHUNK) chunks.push(symbols.slice(i, i + CHUNK));

  const out: Record<string, {
    price: number;
    changePct: number;
    delayed?: boolean;
    /** no trade today on either feed: this is the last session's close */
    stale?: boolean;
    /** the session `price`/`changePct` describe, when it isn't today */
    asOf?: string;
  }> = {};
  // ET session date (the daily bar's timestamp is midnight ET = 04:00Z).
  const todayEt = new Date(Date.now() - 4 * 3_600_000).toISOString().slice(0, 10);
  // Only chase the tape while a session is actually running. Outside
  // market hours every snapshot is legitimately the last session's, and
  // that open->close move is what the UI should show — there is no
  // "today" to be missing.
  const now = new Date();
  const utcHM = now.getUTCHours() * 100 + now.getUTCMinutes();
  const sessionLive = now.getUTCDay() >= 1 && now.getUTCDay() <= 5 && utcHM >= 1330 && utcHM < 2000;
  const stale: string[] = [];
  // Long enough that a normally-quiet name isn't chased on every poll,
  // short enough that a stalled IEX view can't sit wrong for long. The
  // tape itself is ~15 min behind, so anything under that is pointless.
  const STALE_TRADE_MS = 20 * 60_000;
  const staleSnapshot = new Map<string, { price: number; changePct: number; asOf: string }>();
  let anyOk = false;
  const results = await Promise.allSettled(chunks.map((c) => fetchSnapshots(c)));
  for (const res of results) {
    if (res.status !== "fulfilled") continue;
    anyOk = true;
    for (const [sym, snap] of Object.entries(res.value)) {
      const open = snap.dailyBar?.o;
      const price = snap.latestTrade?.p ?? snap.dailyBar?.c ?? null;
      const barDay = snap.dailyBar?.t?.slice(0, 10) ?? null;
      // "Today" is not enough: a single early IEX print (FBDT traded 313
      // shares at 10:00 ET on 2026-09-18) makes the snapshot look current
      // while the tape runs away from it — that one showed 0.0% against a
      // real -6%. A quote whose last trade is older than STALE_TRADE_MS
      // counts as stale too.
      const tradeAgeMs = snap.latestTrade?.t ? Date.now() - Date.parse(snap.latestTrade.t) : Infinity;
      if (sessionLive && (barDay !== todayEt || tradeAgeMs > STALE_TRADE_MS)) {
        stale.push(sym);
        // Keep the last session as a fallback-of-the-fallback: a name that
        // has not traded on any feed today (halted, or simply nothing yet)
        // is better shown as "$0.09 · Sep 17 close" than as a blank "—".
        if (open && price && open > 0 && barDay) {
          staleSnapshot.set(sym, { price, changePct: (price - open) / open, asOf: barDay });
        }
        continue;
      }
      if (open && price && open > 0) out[sym] = { price, changePct: (price - open) / open };
    }
  }
  if (!anyOk) return json({ error: "all snapshot chunks failed" }, 502);

  // Anything IEX has no session for today: ask the tape.
  if (stale.length) {
    try {
      const sip = await fetchDelayedSipToday(stale);
      for (const [sym, bar] of Object.entries(sip)) {
        out[sym] = { price: bar.price, changePct: (bar.price - bar.open) / bar.open, delayed: true };
      }
    } catch {
      /* tape unavailable — fall through to the last-close labelling below */
    }
    for (const sym of stale) {
      if (out[sym]) continue; // the tape had today
      const last = staleSnapshot.get(sym);
      if (last) out[sym] = { ...last, stale: true };
    }
  }
  return json(out);
};
