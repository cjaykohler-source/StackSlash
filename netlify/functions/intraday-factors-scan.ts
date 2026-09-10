import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { mapWithConcurrency } from "./lib/concurrency";
import { intradayFactors, type IntradayBar } from "./lib/intradayFactors";
import { etDateString, etWallClock } from "./lib/etTime";

/**
 * Computes live intraday session-shape factors (RVOL, VWAP distance, gap,
 * opening-range break, off-highs/lows, …) for the tradeable band and
 * upserts them into intraday_factor_state — the intraday counterpart to
 * eod-scan's factor_state. Phase 3 fast triggers read this.
 *
 * Scope: the in-band liquid set from the latest factor_state (price <=
 * scan_config ceiling, dollar volume above the floor) plus tracked
 * symbols — the only names a flip signal could ever fire on, and small
 * enough to fetch each one's session bars individually.
 *
 * Scheduled via netlify.toml, every 5 min during market hours.
 */

const MAX_SYMBOLS = 900;

export default async () => {
  const db = getSupabaseAdmin();

  await withJobRun(db, "intraday-factors-scan", async () => {
    if (!isLikelyMarketHours()) return { rowsProcessed: 0, result: { symbols: 0, computed: 0 } };

    const sessionDate = etDateString(Date.now());
    const openTs = etWallClock(sessionDate, 9, 30);
    const dayStartIso = new Date(openTs - 6 * 3_600_000).toISOString(); // include pre-market for completeness; factors filter to regular session by minute

    const { data: cfgRow } = await db
      .from("scan_config")
      .select("price_max, min_dollar_vol_20d")
      .eq("id", 1)
      .maybeSingle();
    const priceMax = Number(cfgRow?.price_max ?? 5);
    const minVol = Number(cfgRow?.min_dollar_vol_20d ?? 50_000);

    const { data: fsAsOf } = await db
      .from("factor_state")
      .select("as_of")
      .order("as_of", { ascending: false })
      .limit(1)
      .maybeSingle();
    const asOf = (fsAsOf as { as_of: string } | null)?.as_of;
    if (!asOf) return { rowsProcessed: 0, result: { symbols: 0, computed: 0 } };

    const { data: trackedRows } = await db.from("tracked_symbols").select("symbol_id");
    const trackedIds = new Set(((trackedRows as { symbol_id: number }[] | null) ?? []).map((r) => r.symbol_id));

    const [{ data: bandRows }, { data: trackedFs }] = await Promise.all([
      db
        .from("factor_state")
        .select("symbol_id, last_close, realized_vol_20d, symbols(ticker, alert_excluded)")
        .eq("as_of", asOf)
        .not("last_close", "is", null)
        .lte("last_close", priceMax)
        .gte("dollar_vol_20d", minVol)
        .order("dollar_vol_20d", { ascending: false })
        .limit(MAX_SYMBOLS),
      trackedIds.size
        ? db
            .from("factor_state")
            .select("symbol_id, last_close, realized_vol_20d, symbols(ticker, alert_excluded)")
            .eq("as_of", asOf)
            .in("symbol_id", [...trackedIds])
        : Promise.resolve({ data: [] as unknown[] }),
    ]);

    type Row = {
      symbol_id: number;
      last_close: number | null;
      realized_vol_20d: number | null;
      symbols: { ticker: string; alert_excluded: boolean } | null;
    };
    const bySymbol = new Map<number, Row>();
    for (const r of [...((bandRows as unknown as Row[]) ?? []), ...((trackedFs as unknown as Row[]) ?? [])]) {
      if (!r.symbols?.ticker || r.symbols.alert_excluded) continue;
      if (!bySymbol.has(r.symbol_id)) bySymbol.set(r.symbol_id, r);
    }
    const candidates = [...bySymbol.values()].slice(0, MAX_SYMBOLS + trackedIds.size);
    if (!candidates.length) return { rowsProcessed: 0, result: { symbols: 0, computed: 0 } };

    const symIds = candidates.map((c) => c.symbol_id);

    // volume profile: one row per (symbol, minute); pull for all candidates
    // in pages and index by symbol.
    const profileBySymbol = new Map<number, number[]>();
    for (let i = 0; i < symIds.length; i += 200) {
      const chunk = symIds.slice(i, i + 200);
      let from = 0;
      for (;;) {
        const { data, error } = await db
          .from("intraday_volume_profile")
          .select("symbol_id, minute_of_session, avg_volume")
          .in("symbol_id", chunk)
          .range(from, from + 999);
        if (error) throw error;
        for (const p of (data as { symbol_id: number; minute_of_session: number; avg_volume: number }[] | null) ?? []) {
          let arr = profileBySymbol.get(p.symbol_id);
          if (!arr) {
            arr = new Array(390).fill(0);
            profileBySymbol.set(p.symbol_id, arr);
          }
          if (p.minute_of_session >= 0 && p.minute_of_session < 390) arr[p.minute_of_session] = Number(p.avg_volume);
        }
        if (!data || data.length < 1000) break;
        from += 1000;
      }
    }

    const nowIso = new Date().toISOString();
    // Concurrency kept modest — the free-tier pooler 502s on a big burst
    // of parallel selects.
    const rows = await mapWithConcurrency(candidates, 8, async (c) => {
      const bars = await withRetry(() =>
        db
          .from("bars_intraday")
          .select("ts, price, volume")
          .eq("symbol_id", c.symbol_id)
          .gte("ts", dayStartIso)
          .order("ts", { ascending: true })
          .limit(1000),
      );
      const ib: IntradayBar[] = ((bars as { ts: string; price: number; volume: number }[] | null) ?? [])
        .map((b) => ({ ts: Date.parse(b.ts), price: Number(b.price), volume: Number(b.volume) }))
        // regular session only for the factor math
        .filter((b) => b.ts >= openTs && b.ts < openTs + 390 * 60_000);
      if (ib.length < 2) return null;

      // Rough ATR proxy from the annualized 20-day return vol on
      // factor_state: daily vol = annual / sqrt(252); ATR (a high-low
      // range) runs ~1.4x a close-to-close move. Good enough for the
      // range_expansion >= 2 gate.
      const px = c.last_close != null ? Number(c.last_close) : null;
      const rv = c.realized_vol_20d != null ? Number(c.realized_vol_20d) : null;
      const atr20 = px && rv ? (px * rv) / 15.87 * 1.4 : null;

      const f = intradayFactors({
        bars: ib,
        priorClose: px,
        openTs,
        minuteVolume: profileBySymbol.get(c.symbol_id) ?? null,
        atr20,
      });

      return {
        symbol_id: c.symbol_id,
        session_date: sessionDate,
        as_of: nowIso,
        last_price: f.last_price,
        session_bars: f.session_bars,
        cum_volume: f.cum_volume,
        gap_pct: f.gap_pct,
        session_return: f.session_return,
        rvol: f.rvol,
        vwap: f.vwap,
        dist_vwap: f.dist_vwap,
        or_high: f.or_high,
        or_low: f.or_low,
        or_break: f.or_break,
        pct_off_hod: f.pct_off_hod,
        pct_off_lod: f.pct_off_lod,
        range_expansion: f.range_expansion,
        higher_lows: f.higher_lows,
      };
    });

    const upserts = rows.filter((r): r is NonNullable<typeof r> => r !== null);
    for (let i = 0; i < upserts.length; i += 500) {
      const { error } = await db
        .from("intraday_factor_state")
        .upsert(upserts.slice(i, i + 500), { onConflict: "symbol_id,session_date" });
      if (error) throw error;
    }

    return { rowsProcessed: upserts.length, result: { symbols: candidates.length, computed: upserts.length } };
  });

  return new Response("ok");
};

async function withRetry<T>(fn: () => PromiseLike<{ data: T; error: unknown }>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const { data, error } = await fn();
    if (!error) return data;
    lastErr = error;
    await new Promise((r) => setTimeout(r, 300 * 2 ** i));
  }
  throw lastErr;
}

function isLikelyMarketHours(): boolean {
  const now = new Date();
  const d = now.getUTCDay();
  const h = now.getUTCHours();
  return d >= 1 && d <= 5 && h >= 13 && h < 21;
}
