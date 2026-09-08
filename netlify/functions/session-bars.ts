import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { fetchIntradayBarsRange } from "./lib/alpaca";

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
 *   -> { symbol, session_date, bars: [{ ts, price }] }   (bars: [] if none)
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
  const todayStr = now.toISOString().slice(0, 10);
  const utcHM = now.getUTCHours() * 100 + now.getUTCMinutes();
  const marketOpen = now.getUTCDay() >= 1 && now.getUTCDay() <= 5 && utcHM >= 1330 && utcHM < 2005;

  const { data: existing } = await db
    .from("bars_intraday")
    .select("ts, price")
    .eq("symbol_id", symbolId)
    .gte("ts", new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString())
    .order("ts", { ascending: true })
    .limit(1000);
  const existingRows = (existing as { ts: string; price: number }[] | null) ?? [];
  if (existingRows.length >= 2) {
    const lastDay = existingRows[existingRows.length - 1].ts.slice(0, 10);
    if (lastDay === todayStr || !marketOpen) {
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

  if (!bars.length) return json({ symbol: ticker, session_date: null, bars: [] });

  const sessionDate = bars.reduce((mx, b) => (b.t.slice(0, 10) > mx ? b.t.slice(0, 10) : mx), "");
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
