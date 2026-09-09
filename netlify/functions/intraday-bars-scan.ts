import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { fetchIntradayBars } from "./lib/alpaca";

/**
 * Populates bars_intraday for today — what the "Day" chart range and the
 * dashboard's tracking-panel mini charts need.
 *
 * NOT the whole ~5,000-symbol universe: at that size a full-universe
 * 1-minute fetch every 5 minutes is thousands of Alpaca requests per run
 * and blows the Netlify timeout. Scoped instead to the symbols anyone is
 * actually likely to look at intraday:
 *   - everything on the watchlist (tracked_symbols)
 *   - anything that produced a trigger_event or pending_fire today
 *   - the whole liquid in-band universe (price <= scan_config.price_max,
 *     dollar_vol_20d >= its liquidity floor) — this is the set the
 *     movers panel and the tradeable feed care about; a top-N-by-dollar-
 *     volume slice alone almost never covers sub-$3 names
 *   - top few hundred by 20-day dollar volume as a fallback (covers the
 *     Day chart for whatever else gets opened from the feed)
 *
 * A symbol outside this set has no intraday history; SymbolDetail's Day
 * chart and TrackedCard fetch it on demand via session-bars.
 *
 * Re-fetches the whole trading day on every run (upsert makes it
 * idempotent). Scheduled via netlify.toml, every 5 min during market hours.
 */
const PRIORITY_LIQUID = 250;
const PRIORITY_IN_BAND = 500;
const MAX_SYMBOLS = 1200;
const CHUNK = 25; // Alpaca's multi-symbol bars endpoint drops coverage above ~25 on many-page requests
const UPSERT_BATCH = 5000;

export default async () => {
  const db = getSupabaseAdmin();

  await withJobRun(db, "intraday-bars-scan", async () => {
    const today = new Date().toISOString().slice(0, 10);

    // --- Build the priority symbol set ---
    const wanted = new Map<number, string>(); // symbol_id -> ticker

    const add = (rows: { symbol_id?: number; id?: number; symbols?: { ticker: string } | null; ticker?: string }[] | null) => {
      for (const r of rows ?? []) {
        const id = r.symbol_id ?? r.id;
        const ticker = r.symbols?.ticker ?? r.ticker;
        if (id && ticker && !wanted.has(id)) wanted.set(id, ticker);
      }
    };

    const [tracked, events, pending, asOfRow, cfgRow] = await Promise.all([
      db.from("tracked_symbols").select("symbol_id, symbols(ticker)"),
      db.from("trigger_events").select("symbol_id, symbols(ticker)").gte("ts", `${today}T00:00:00Z`),
      db.from("pending_fires").select("symbol_id, symbols(ticker)").gte("created_at", `${today}T00:00:00Z`),
      db.from("factor_state").select("as_of").order("as_of", { ascending: false }).limit(1).maybeSingle(),
      db.from("scan_config").select("price_max, min_dollar_vol_20d").eq("id", 1).maybeSingle(),
    ]);
    add(tracked.data as never);
    add(events.data as never);
    add(pending.data as never);

    const asOf = asOfRow.data?.as_of;
    const priceMax = Number(cfgRow.data?.price_max ?? 3);
    const minVol = Number(cfgRow.data?.min_dollar_vol_20d ?? 50000);

    type FsRow = { symbol_id: number; symbols: { ticker: string; alert_excluded: boolean } | null };
    const notExcluded = (rows: FsRow[] | null) => (rows ?? []).filter((r) => r.symbols && !r.symbols.alert_excluded);

    if (asOf) {
      // The liquid in-band universe (price <= band ceiling, dollar volume
      // above the floor) — what the movers panel and the tradeable feed
      // need covered — plus a top-by-dollar-volume fallback for anything
      // else opened from the feed.
      const [{ data: inBand }, { data: liquid }] = await Promise.all([
        db
          .from("factor_state")
          .select("symbol_id, symbols(ticker, alert_excluded)")
          .eq("as_of", asOf)
          .gte("dollar_vol_20d", minVol)
          .not("last_close", "is", null)
          .lte("last_close", priceMax)
          .order("dollar_vol_20d", { ascending: false })
          .limit(PRIORITY_IN_BAND),
        db
          .from("factor_state")
          .select("symbol_id, symbols(ticker, alert_excluded)")
          .eq("as_of", asOf)
          .not("dollar_vol_20d", "is", null)
          .order("dollar_vol_20d", { ascending: false })
          .limit(PRIORITY_LIQUID),
      ]);
      add(notExcluded(inBand as unknown as FsRow[]) as never);
      add(notExcluded(liquid as unknown as FsRow[]) as never);
    }

    const tickers = [...wanted.values()].slice(0, MAX_SYMBOLS);
    const idByTicker = new Map([...wanted.entries()].map(([id, t]) => [t, id]));
    if (!tickers.length) return { rowsProcessed: 0, result: { symbols: 0 } };

    // --- Fetch + upsert in batches ---
    let rows: Record<string, unknown>[] = [];
    let written = 0;
    const flush = async () => {
      for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
        const { error } = await db
          .from("bars_intraday")
          .upsert(rows.slice(i, i + UPSERT_BATCH), { onConflict: "symbol_id,ts" });
        if (error) throw error;
      }
      written += rows.length;
      rows = [];
    };

    for (let i = 0; i < tickers.length; i += CHUNK) {
      const chunk = tickers.slice(i, i + CHUNK);
      let pageToken: string | undefined;
      do {
        const { bars, nextPageToken } = await fetchIntradayBars(chunk, today, pageToken);
        for (const [ticker, tickerBars] of Object.entries(bars)) {
          const symbolId = idByTicker.get(ticker);
          if (!symbolId) continue;
          for (const b of tickerBars) rows.push({ symbol_id: symbolId, ts: b.t, price: b.c, volume: b.v });
        }
        pageToken = nextPageToken ?? undefined;
      } while (pageToken);
      if (rows.length >= UPSERT_BATCH) await flush();
    }
    await flush();

    return { rowsProcessed: written, result: { symbols: tickers.length } };
  });

  return new Response("ok");
};

// Schedule is configured in netlify.toml under [functions."intraday-bars-scan"].
