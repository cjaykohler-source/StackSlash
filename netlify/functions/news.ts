import { fetchNews } from "./lib/alpaca";

/**
 * GET /.netlify/functions/news?symbol=AAPL
 * Recent headlines for one symbol, for the symbol drill-down page.
 * Public (like quotes.ts / session-bars.ts) — no secrets in the response,
 * short edge cache since headlines are real-time-ish.
 */
export default async (req: Request) => {
  const symbol = new URL(req.url).searchParams.get("symbol")?.trim().toUpperCase();
  if (!symbol) {
    return new Response(JSON.stringify({ error: "symbol required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const items = await fetchNews([symbol], { limit: 15 });
  const news = items.map((n) => ({
    id: n.id,
    headline: n.headline,
    url: n.url,
    source: n.source,
    author: n.author,
    ts: n.created_at,
  }));

  return new Response(JSON.stringify({ symbol, news }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=300",
    },
  });
};
