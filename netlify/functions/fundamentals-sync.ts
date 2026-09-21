import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { fetchEarningsCalendarRecent, fetchProfile, DESCRIPTION_CAPTURE_START } from "./lib/fmp";

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
 * Runs on the worker host via launchd (02:00 + 17:00 ET,
 * scripts/run-netlify-job.sh). Also accepts a manual POST for a one-off run.
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

    // --- 2. Profiles: the $0.10-$5 band first (never-synced, then stale),
    // then everything else. The free tier's ~250 calls/day would take ~24
    // days to cover the whole universe; band-first covers the ~1,400 names
    // the scanner cares about in ~8.
    const staleCutoff = new Date(Date.now() - PROFILE_STALE_DAYS * 86400_000).toISOString();
    // Also: profiles synced before descriptions were captured, still missing one.
    type NeedRow = { id: number; ticker: string; profile_synced_at: string | null; description: string | null };
    const need: NeedRow[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await db
        .from("symbols")
        .select("id, ticker, profile_synced_at, description")
        .eq("active", true)
        .or(
          `profile_synced_at.is.null,profile_synced_at.lt.${staleCutoff},and(description.is.null,profile_synced_at.lt.${DESCRIPTION_CAPTURE_START})`,
        )
        .range(from, from + 999);
      need.push(...((data as NeedRow[] | null) ?? []));
      if (!data || data.length < 1000) break;
    }
    const inBand = new Set<number>();
    {
      const { data: cfg } = await db.from("scan_config").select("price_min, price_max").eq("id", 1).maybeSingle();
      const { data: asOfRow } = await db.from("factor_state").select("as_of").order("as_of", { ascending: false }).limit(1).maybeSingle();
      const asOf = (asOfRow as { as_of: string } | null)?.as_of;
      if (asOf) {
        for (let from = 0; ; from += 1000) {
          const { data } = await db
            .from("factor_state")
            .select("symbol_id")
            .eq("as_of", asOf)
            .gte("last_close", Number(cfg?.price_min ?? 0.1))
            .lte("last_close", Number(cfg?.price_max ?? 10))
            .range(from, from + 999);
          for (const r of (data as { symbol_id: number }[] | null) ?? []) inBand.add(r.symbol_id);
          if (!data || data.length < 1000) break;
        }
      }
    }
    // band first; within it never-synced, then missing-description, then stale
    const rank = (r: NeedRow) =>
      (inBand.has(r.id) ? 0 : 3) + (!r.profile_synced_at ? 0 : r.description == null ? 1 : 2);
    const needProfile = need
      .sort((a, b) => rank(a) - rank(b) || (a.profile_synced_at ?? "").localeCompare(b.profile_synced_at ?? ""))
      .slice(0, PROFILE_MAX_PER_RUN);
    let profilesUpdated = 0;
    for (const s of needProfile) {
      try {
        const p = await fetchProfile(s.ticker);
        await db
          .from("symbols")
          .update({
            description: p?.description ?? null,
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
