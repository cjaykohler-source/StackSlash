import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { fetchEarningsCalendar, fetchProfiles, fetchEarningsSurprises } from "./lib/fmp";

/**
 * Daily FMP pull. Three jobs, all rate-budget-aware for the free tier:
 *
 *  1. Earnings calendar for [-100d, +45d] — one FMP call covers the whole
 *     market for the range; filtered to our active tickers, upserted into
 *     `earnings` with the actual-vs-estimate surprise.
 *  2. Company profiles (sector / industry / market cap / shares out / ETF
 *     flag) for symbols never synced or stale (>30d), PROFILE_BATCHES
 *     batches per run so it backfills over a few days without blowing the
 *     call budget.
 *  3. SUE (standardized unexpected earnings) for symbols that just
 *     reported and don't have it yet — per-symbol call, capped per run.
 *
 * Scheduled via netlify.toml (06:00 + 21:00 UTC). Also accepts a manual
 * POST (like backfill-history / backtest-triggers) for a one-off run.
 */
const CAL_BACK_DAYS = 100;
const CAL_FWD_DAYS = 45;
const PROFILE_BATCH = 40; // tickers per FMP /profile call
const PROFILE_BATCHES = 30; // batches per run (~1,200 symbols/day -> full universe in ~4 days)
const SUE_MAX_PER_RUN = 40;
const UPSERT_BATCH = 2000;

const iso = (d: Date) => d.toISOString().slice(0, 10);

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

    // --- 1. Earnings calendar ---
    const now = new Date();
    const cal = await fetchEarningsCalendar(
      iso(new Date(now.getTime() - CAL_BACK_DAYS * 86400_000)),
      iso(new Date(now.getTime() + CAL_FWD_DAYS * 86400_000)),
    );
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
        report_time: e.time || null,
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
    const staleCutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
    const { data: needProfile } = await db
      .from("symbols")
      .select("id, ticker, profile_synced_at")
      .eq("active", true)
      .or(`profile_synced_at.is.null,profile_synced_at.lt.${staleCutoff}`)
      .order("profile_synced_at", { ascending: true, nullsFirst: true })
      .limit(PROFILE_BATCH * PROFILE_BATCHES);
    let profilesUpdated = 0;
    const toProfile = (needProfile as { id: number; ticker: string }[] | null) ?? [];
    for (let i = 0; i < toProfile.length; i += PROFILE_BATCH) {
      const batch = toProfile.slice(i, i + PROFILE_BATCH);
      const profiles = await fetchProfiles(batch.map((s) => s.ticker));
      const bySym = new Map(profiles.map((p) => [p.symbol, p]));
      await Promise.all(
        batch.map((s) => {
          const p = bySym.get(s.ticker);
          return db
            .from("symbols")
            .update({
              sector: p?.sector ?? null,
              industry: p?.industry ?? null,
              market_cap: p?.mktCap ?? null,
              shares_outstanding: p && "sharesOutstanding" in p ? (p as { sharesOutstanding?: number }).sharesOutstanding ?? null : null,
              is_etf: p?.isEtf ?? false,
              profile_synced_at: new Date().toISOString(),
            })
            .eq("id", s.id)
            .then(() => {
              profilesUpdated++;
            });
        }),
      );
    }

    // --- 3. SUE for freshly-reported symbols missing it ---
    const { data: recentReports } = await db
      .from("earnings")
      .select("symbol_id, report_date, symbols(ticker)")
      .gte("report_date", iso(new Date(now.getTime() - 10 * 86400_000)))
      .lte("report_date", iso(now))
      .is("sue", null)
      .limit(SUE_MAX_PER_RUN);
    let sueUpdated = 0;
    for (const r of (recentReports as unknown as { symbol_id: number; report_date: string; symbols: { ticker: string } | null }[] | null) ?? []) {
      const ticker = r.symbols?.ticker;
      if (!ticker) continue;
      try {
        const hist = await fetchEarningsSurprises(ticker);
        const surprises = hist
          .filter((h) => h.actualEarningResult != null && h.estimatedEarning != null && h.estimatedEarning !== 0)
          .map((h) => (h.actualEarningResult! - h.estimatedEarning!) / Math.abs(h.estimatedEarning!));
        if (surprises.length < 4) continue;
        const mean = surprises.reduce((a, b) => a + b, 0) / surprises.length;
        const sd = Math.sqrt(surprises.reduce((a, b) => a + (b - mean) ** 2, 0) / surprises.length);
        const latest = surprises[0]; // FMP returns newest first
        const sue = sd > 0 ? (latest - mean) / sd : 0;
        await db.from("earnings").update({ sue }).eq("symbol_id", r.symbol_id).eq("report_date", r.report_date);
        sueUpdated++;
      } catch {
        /* skip this symbol */
      }
    }

    return {
      rowsProcessed: earningRows.length,
      result: { calendar: earningRows.length, profilesUpdated, sueUpdated },
    };
  });

  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
};
