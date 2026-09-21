import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { fetchNews } from "./lib/alpaca";
import { mapWithConcurrency } from "./lib/concurrency";

/**
 * One-off: seed symbol_news with ~90 days of headlines per band symbol so
 * catalyst_momentum can be backtested (sim-intraday-flips). Per-symbol
 * fetch, newest 50 since `start` — enough for the thinly-covered penny
 * names, may miss older headlines on heavily-covered ones (acceptable for
 * the sim). POST only. Body: {"days": 90, "tickers": [...]}.
 */
export default async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const db = getSupabaseAdmin();

  let body: { days?: number; tickers?: string[] } = {};
  try {
    body = await req.json();
  } catch {
    /* defaults */
  }
  const start = new Date(Date.now() - (body.days ?? 90) * 86400_000).toISOString();

  const result = await withJobRun(db, "backfill-news", async () => {
    let tickers: string[] = [];
    if (body.tickers?.length) {
      tickers = body.tickers;
    } else {
      const { data: cfg } = await db
        .from("scan_config")
        .select("price_max, min_dollar_vol_20d")
        .eq("id", 1)
        .maybeSingle();
      const { data: asOfRow } = await db
        .from("factor_state")
        .select("as_of")
        .order("as_of", { ascending: false })
        .limit(1)
        .maybeSingle();
      const asOf = (asOfRow as { as_of: string } | null)?.as_of;
      const [{ data: band }, { data: tracked }] = await Promise.all([
        asOf
          ? db
              .from("factor_state")
              .select("symbols(ticker)")
              .eq("as_of", asOf)
              .not("last_close", "is", null)
              .lte("last_close", Number(cfg?.price_max ?? 5))
              .gte("dollar_vol_20d", Number(cfg?.min_dollar_vol_20d ?? 50_000))
              .limit(1000)
          : Promise.resolve({ data: [] as unknown[] }),
        db.from("tracked_symbols").select("symbols(ticker)"),
      ]);
      const set = new Set<string>();
      for (const r of [...((band as unknown[]) ?? []), ...((tracked as unknown[]) ?? [])] as {
        symbols: { ticker: string } | null;
      }[]) {
        if (r.symbols?.ticker) set.add(r.symbols.ticker);
      }
      tickers = [...set];
    }
    if (!tickers.length) return { rowsProcessed: 0, result: { symbols: 0, headlines: 0 } };

    let headlines = 0;
    await mapWithConcurrency(tickers, 5, async (ticker) => {
      const items = await fetchNews([ticker], { start, limit: 50 });
      if (!items.length) return;
      const rows = items.map((n) => ({
        id: n.id,
        headline: n.headline,
        summary: n.summary ?? null,
        source: n.source ?? null,
        url: n.url ?? null,
        created_at: n.created_at,
        symbols: n.symbols ?? [ticker],
      }));
      const { error } = await db.from("symbol_news").upsert(rows, { onConflict: "id", ignoreDuplicates: true });
      if (error) throw error;
      headlines += rows.length;
    });

    return { rowsProcessed: headlines, result: { symbols: tickers.length, headlines } };
  });

  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
};
