import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { fetchIntradayBarsRange } from "./lib/alpaca";
import { mapWithConcurrency } from "./lib/concurrency";

/**
 * One-off deep backfill of bars_intraday — the minute history the Phase 3
 * intraday flip triggers backtest against (sim-intraday-flips.ts) and the
 * intraday_volume_profile builds from. eod-scan / intraday-bars-scan only
 * ever keep the trailing window current; this fills the ~90 days behind.
 *
 * HTTP POST only, not scheduled. Body (all optional):
 *   {"days": 90}                 how far back (default 90)
 *   {"startDate","endDate"}      explicit window (override `days`)
 *   {"tickers": ["ABC","XYZ"]}   scope to a subset (e.g. retrying failures)
 *   {"allActive": true}          every active symbol, not just the band
 *
 * Default symbol set = the tradeable band (price <= scan_config ceiling,
 * dollar volume above the floor, from the latest factor_state) + tracked.
 * At ~400 symbols x ~90 days this is a long Alpaca pull — run it on the
 * Mac mini, not Netlify. Idempotent (upsert on symbol_id,ts) so a partial
 * run can just be re-invoked.
 */

const FREE_IEX_HISTORY_FLOOR = "2020-09-01"; // Alpaca free-tier 1-min history doesn't go earlier
const UPSERT_BATCH = 5000;
const SYMBOL_CONCURRENCY = 4;

export default async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const db = getSupabaseAdmin();

  let body: { days?: number; startDate?: string; endDate?: string; tickers?: string[]; allActive?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* defaults */
  }

  const end = body.endDate ?? new Date().toISOString().slice(0, 10);
  const start =
    body.startDate ??
    (() => {
      const d = new Date();
      d.setDate(d.getDate() - (body.days ?? 90));
      const iso = d.toISOString().slice(0, 10);
      return iso < FREE_IEX_HISTORY_FLOOR ? FREE_IEX_HISTORY_FLOOR : iso;
    })();

  const result = await withJobRun(db, "backfill-intraday", async () => {
    // --- symbol set ---
    let ids: { id: number; ticker: string }[] = [];
    if (body.tickers?.length) {
      const { data } = await db.from("symbols").select("id, ticker").in("ticker", body.tickers);
      ids = (data as { id: number; ticker: string }[] | null) ?? [];
    } else if (body.allActive) {
      for (let from = 0; ; from += 1000) {
        const { data } = await db.from("symbols").select("id, ticker").eq("active", true).range(from, from + 999);
        if (!data?.length) break;
        ids.push(...(data as { id: number; ticker: string }[]));
        if (data.length < 1000) break;
      }
    } else {
      const { data: cfg } = await db
        .from("scan_config")
        .select("price_max, min_dollar_vol_20d")
        .eq("id", 1)
        .maybeSingle();
      const priceMax = Number(cfg?.price_max ?? 5);
      const minVol = Number(cfg?.min_dollar_vol_20d ?? 50_000);
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
              .select("symbol_id, symbols(ticker)")
              .eq("as_of", asOf)
              .not("last_close", "is", null)
              .lte("last_close", priceMax)
              .gte("dollar_vol_20d", minVol)
          : Promise.resolve({ data: [] as unknown[] }),
        db.from("tracked_symbols").select("symbol_id, symbols(ticker)"),
      ]);
      const seen = new Set<number>();
      for (const r of [...((band as unknown[]) ?? []), ...((tracked as unknown[]) ?? [])] as {
        symbol_id: number;
        symbols: { ticker: string } | null;
      }[]) {
        if (r.symbols?.ticker && !seen.has(r.symbol_id)) {
          seen.add(r.symbol_id);
          ids.push({ id: r.symbol_id, ticker: r.symbols.ticker });
        }
      }
    }
    if (!ids.length)
      return { rowsProcessed: 0, result: { symbols: 0, window: `${start}..${end}`, failures: [] as string[], failureCount: 0 } };

    let totalRows = 0;
    let done = 0;
    const failures: string[] = [];

    await mapWithConcurrency(ids, SYMBOL_CONCURRENCY, async ({ id, ticker }) => {
      try {
        let buf: { symbol_id: number; ts: string; price: number; volume: number }[] = [];
        let symbolRows = 0;
        let pageToken: string | undefined;
        do {
          const { bars, nextPageToken } = await fetchIntradayBarsRange([ticker], start, end, pageToken);
          for (const b of bars[ticker] ?? []) {
            buf.push({ symbol_id: id, ts: b.t, price: b.c, volume: b.v });
          }
          pageToken = nextPageToken ?? undefined;
          if (buf.length >= UPSERT_BATCH) {
            symbolRows += buf.length;
            await flush(db, buf);
            buf = [];
          }
        } while (pageToken);
        if (buf.length) {
          symbolRows += buf.length;
          await flush(db, buf);
        }
        totalRows += symbolRows;
      } catch (err) {
        failures.push(`${ticker}: ${err instanceof Error ? err.message : String(err)}`);
      }
      done++;
      if (done % 25 === 0) console.log(`backfill-intraday: ${done}/${ids.length} symbols, ${totalRows} rows`);
    });

    return {
      rowsProcessed: totalRows,
      result: { symbols: ids.length, window: `${start}..${end}`, failures: failures.slice(0, 20), failureCount: failures.length },
    };
  });

  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
};

async function flush(
  db: ReturnType<typeof getSupabaseAdmin>,
  rows: { symbol_id: number; ts: string; price: number; volume: number }[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const { error } = await db
      .from("bars_intraday")
      .upsert(rows.slice(i, i + UPSERT_BATCH), { onConflict: "symbol_id,ts" });
    if (error) throw error;
  }
}
