import { fetchSnapshots } from "./lib/alpaca";

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

  const out: Record<string, { price: number; changePct: number }> = {};
  let anyOk = false;
  const results = await Promise.allSettled(chunks.map((c) => fetchSnapshots(c)));
  for (const res of results) {
    if (res.status !== "fulfilled") continue;
    anyOk = true;
    for (const [sym, snap] of Object.entries(res.value)) {
      const open = snap.dailyBar?.o;
      const price = snap.latestTrade?.p ?? snap.dailyBar?.c ?? null;
      if (open && price && open > 0) out[sym] = { price, changePct: (price - open) / open };
    }
  }
  if (!anyOk) return json({ error: "all snapshot chunks failed" }, 502);
  return json(out);
};
