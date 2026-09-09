import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { fetchEarningsCalendarRecent, fetchProfile } from "./lib/fmp";

/**
 * Daily FMP pull, sized for the free tier (see lib/fmp.ts). Two jobs:
 *
 *  1. Earnings calendar — ONE call for the whole market's trailing ~3mo
 *     of reported quarters. Filtered to our active tickers, upserted into
 *     `earnings` with the actual-vs-estimate surprise (`surprise_pct`).
 *     There is no forward calendar on this tier, so this is "who just
 *     reported", not "who reports next" — the drift trigger keys off it.
 *
 *  2. Company profiles (sector / industry / market cap / ETF / ADR flag)
 *     — one FMP call per symbol, so only PROFILE_MAX_PER_RUN symbols per
 *     run: never-synced first, then stalest. Backfills the tradeable set
 *     over a couple of weeks; deep-dive.ts fills any gap on demand for a
 *     symbol that actually fires before the sweep reaches it.
 *
 * Scheduled via netlify.toml (06:00 + 21:00 UTC). Also accepts a manual
 * POST for a one-off run.
 */
const PROFILE_MAX_PER_RUN = 90; // one FMP call each
const PROFILE_STALE_DAYS = 45;
const UPSERT_BATCH = 2000;

export default async (_req?: Request) => {
  const db = getSupabaseAdmin();

  const result = await withJobRun(db, "fundamentals-sync", async () => {
    // active symbols
    const symbols: { id: number; ticker: string }[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await db.from("symbols").select("id, ticker").eq("active", true).range(from, from + 999);
      if (!data?.length) break;
      symbols.push(...(data as { id: number; ticker: string }[]));
      if (data.length < 1000) break;
    }
    const idByTicker = new Map(symbols.map((s) => [s.ticker, s.id]));

    // --- 1. Earnings calendar (one call, trailing window) ---
    const cal = await fetchEarningsCalendarRecent();
    const earningRows: Record<string, unknown>[] = [];
    for (const e of cal) {
      const symbolId = idByTicker.get(e.symbol);
      if (!symbolId || !e.date) continue;
      const est = e.epsEstimated;
      const act = e.epsActual;
      const surprise_pct = est != null && act != null && est !== 0 ? (act - est) / Math.abs(est) : null;
      earningRows.push({
        symbol_id: symbolId,
        report_date: e.date,
        eps_estimate: est,
        eps_actual: act,
        revenue_estimate: e.revenueEstimated ?? null,
        revenue_actual: e.revenueActual ?? null,
        surprise_pct,
        synced_at: new Date().toISOString(),
      });
    }
    for (let i = 0; i < earningRows.length; i += UPSERT_BATCH) {
      const { error } = await db
        .from("earnings")
        .upsert(earningRows.slice(i, i + UPSERT_BATCH), { onConflict: "symbol_id,report_date" });
      if (error) throw error;
    }

    // --- 2. Profiles (never-synced first, then stale) ---
    const staleCutoff = new Date(Date.now() - PROFILE_STALE_DAYS * 86400_000).toISOString();
    const { data: needProfile } = await db
      .from("symbols")
      .select("id, ticker, profile_synced_at")
      .eq("active", true)
      .or(`profile_synced_at.is.null,profile_synced_at.lt.${staleCutoff}`)
      .order("profile_synced_at", { ascending: true, nullsFirst: true })
      .limit(PROFILE_MAX_PER_RUN);
    let profilesUpdated = 0;
    for (const s of (needProfile as { id: number; ticker: string }[] | null) ?? []) {
      try {
        const p = await fetchProfile(s.ticker);
        await db
          .from("symbols")
          .update({
            sector: p?.sector ?? null,
            industry: p?.industry ?? null,
            market_cap: p?.marketCap ?? null,
            is_etf: p?.isEtf ?? false,
            is_fund: p?.isFund ?? false,
            is_adr: p?.isAdr ?? false,
            profile_synced_at: new Date().toISOString(),
          })
          .eq("id", s.id);
        profilesUpdated++;
      } catch {
        /* skip this symbol, retry next run */
      }
    }

    return {
      rowsProcessed: earningRows.length,
      result: { calendar: earningRows.length, calendarFetched: cal.length, profilesUpdated },
    };
  });

  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
};
