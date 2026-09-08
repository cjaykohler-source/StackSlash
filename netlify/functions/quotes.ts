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
 * One batched Alpaca call regardless of how many symbols are asked for.
 * Cached for 30s at the edge so a dashboard refresh doesn't re-hit Alpaca.
 */
export default async (req: Request) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30" },
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
  ].slice(0, 200);
  if (!symbols.length) return json({});

  let snaps;
  try {
    snaps = await fetchSnapshots(symbols);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "snapshot fetch failed" }, 502);
  }

  const out: Record<string, { price: number; changePct: number }> = {};
  for (const [sym, snap] of Object.entries(snaps)) {
    const open = snap.dailyBar?.o;
    const price = snap.latestTrade?.p ?? snap.dailyBar?.c ?? null;
    if (open && price && open > 0) {
      out[sym] = { price, changePct: (price - open) / open };
    }
  }
  return json(out);
};
