import type { SupabaseClient } from "@supabase/supabase-js";
import { doltQueryAll, n } from "./dolthub";

/**
 * Weekly financial-statement sync from the DoltHub
 * `post-no-preference/earnings` dataset. Pulls recent quarterly balance
 * sheets, income statements, cash-flow statements, the forward earnings
 * calendar, and Zacks analyst ranks; reduces to one `fundamentals` row
 * per symbol and upserts forward earnings dates into `earnings`.
 *
 * Shared by refresh-fundamentals-background.ts (the Settings-page button)
 * and the weekly launchd job on the worker host.
 */

const iso = (d: Date) => d.toISOString().slice(0, 10);
const UPSERT_BATCH = 1000;

const RANK_TO_NUM: Record<string, number> = {
  "strong buy": 1,
  buy: 2,
  hold: 3,
  sell: 4,
  "strong sell": 5,
};

/** The row closest to ~1 year before `latest.date`, for YoY comparisons.
 *  `rows` are newest-first. */
function yearAgo(rows: Row[]): Row | undefined {
  if (rows.length < 2) return undefined;
  const latest = Date.parse(rows[0].date ?? "");
  if (Number.isNaN(latest)) return undefined;
  const target = latest - 365 * 86400_000;
  let best: Row | undefined;
  let bestGap = Infinity;
  for (const r of rows.slice(1)) {
    const t = Date.parse(r.date ?? "");
    if (Number.isNaN(t)) continue;
    const gap = Math.abs(t - target);
    if (gap < bestGap && gap < 120 * 86400_000) {
      best = r;
      bestGap = gap;
    }
  }
  return best;
}

type Row = Record<string, string | null>;

/** Newest-first rows already ordered by (act_symbol, date DESC): keep the
 *  first `keep` per symbol. */
function topPerSymbol(rows: Row[], keep: number): Map<string, Row[]> {
  const by = new Map<string, Row[]>();
  for (const r of rows) {
    const s = r.act_symbol;
    if (!s) continue;
    const arr = by.get(s) ?? [];
    if (arr.length < keep) arr.push(r);
    by.set(s, arr);
  }
  return by;
}

export async function syncFundamentalsFromDolt(db: SupabaseClient): Promise<{
  rowsProcessed: number;
  result: { symbols: number; withRunway: number; forwardEarnings: number };
}> {
  // active symbols -> id
  const symbols: { id: number; ticker: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from("symbols").select("id, ticker").eq("active", true).range(from, from + 999);
    if (!data?.length) break;
    symbols.push(...(data as { id: number; ticker: string }[]));
    if (data.length < 1000) break;
  }
  const idByTicker = new Map(symbols.map((s) => [s.ticker, s.id]));

  // market cap for net-cash / book-to-market ratios
  const mktCap = new Map<number, number>();
  for (let from = 0; ; from += 1000) {
    const { data } = await db
      .from("symbols")
      .select("id, market_cap")
      .eq("active", true)
      .not("market_cap", "is", null)
      .range(from, from + 999);
    if (!data?.length) break;
    for (const r of data as { id: number; market_cap: number }[]) mktCap.set(r.id, Number(r.market_cap));
    if (data.length < 1000) break;
  }

  const today = new Date();
  const cut560 = iso(new Date(today.getTime() - 560 * 86400_000)); // ~6 quarters, for YoY comparisons
  const cut200 = iso(new Date(today.getTime() - 200 * 86400_000));
  const cut21 = iso(new Date(today.getTime() - 21 * 86400_000));
  const todayIso = iso(today);

  const [assets, liabs, equity, income, cash, cal, ranks] = await Promise.all([
    doltQueryAll(
      `SELECT act_symbol, date, cash_and_equivalents, total_assets FROM balance_sheet_assets
       WHERE period = 'Quarter' AND date >= '${cut200}' ORDER BY act_symbol, date DESC`,
    ),
    doltQueryAll(
      `SELECT act_symbol, date, long_term_debt, current_portion_long_term_debt, convertible_debt,
              current_portion_capital_leases, non_current_capital_leases, total_liabilities
       FROM balance_sheet_liabilities
       WHERE period = 'Quarter' AND date >= '${cut200}' ORDER BY act_symbol, date DESC`,
    ),
    doltQueryAll(
      `SELECT act_symbol, date, total_equity, shares_outstanding FROM balance_sheet_equity
       WHERE period = 'Quarter' AND date >= '${cut560}' ORDER BY act_symbol, date DESC`,
    ),
    doltQueryAll(
      `SELECT act_symbol, date, sales FROM income_statement
       WHERE period = 'Quarter' AND date >= '${cut560}' ORDER BY act_symbol, date DESC`,
    ),
    doltQueryAll(
      `SELECT act_symbol, date, net_cash_from_operating_activities, property_and_equipment
       FROM cash_flow_statement
       WHERE period = 'Quarter' AND date >= '${cut560}' ORDER BY act_symbol, date DESC`,
    ),
    doltQueryAll(
      `SELECT act_symbol, MIN(date) AS next_date FROM earnings_calendar
       WHERE date >= '${todayIso}' GROUP BY act_symbol`,
    ),
    doltQueryAll(
      `SELECT act_symbol, date, \`rank\`, \`value\`, growth, momentum, vgm FROM rank_score
       WHERE date >= '${cut21}' ORDER BY act_symbol, date DESC`,
    ),
  ]);

  const aLatest = topPerSymbol(assets, 1);
  const lLatest = topPerSymbol(liabs, 1);
  const eRows = topPerSymbol(equity, 8); // latest + ~1yr back for dilution
  const iRows = topPerSymbol(income, 8); // latest + year-ago quarter for growth
  const cRows = topPerSymbol(cash, 4); // last 4 quarters for burn
  const rLatest = topPerSymbol(ranks, 1);
  const nextEarn = new Map(cal.map((r) => [r.act_symbol!, r.next_date!]));

  const fundamentals: Record<string, unknown>[] = [];
  const forwardEarnings: Record<string, unknown>[] = [];
  let withRunway = 0;

  for (const [ticker, symbolId] of idByTicker) {
    const a = aLatest.get(ticker)?.[0];
    const l = lLatest.get(ticker)?.[0];
    const e = eRows.get(ticker) ?? [];
    const inc = iRows.get(ticker) ?? [];
    const cf = cRows.get(ticker) ?? [];
    const rk = rLatest.get(ticker)?.[0];
    const next = nextEarn.get(ticker) ?? null;

    if (!a && !l && e.length === 0 && !rk && !next) continue;

    const cashVal = n(a?.cash_and_equivalents ?? null);
    const totalDebt =
      (n(l?.long_term_debt ?? null) ?? 0) +
      (n(l?.current_portion_long_term_debt ?? null) ?? 0) +
      (n(l?.convertible_debt ?? null) ?? 0) +
      (n(l?.current_portion_capital_leases ?? null) ?? 0) +
      (n(l?.non_current_capital_leases ?? null) ?? 0);
    const netCash = cashVal != null ? cashVal - totalDebt : null;
    const bookEquity = n(e[0]?.total_equity ?? null);
    const sharesNow = n(e[0]?.shares_outstanding ?? null);
    const sharesYearAgo = n(yearAgo(e)?.shares_outstanding ?? null);
    const cap = mktCap.get(symbolId) ?? null;

    // burn = average of the last <=4 quarters' operating cash flow, when negative
    const ocfs = cf.map((r) => n(r.net_cash_from_operating_activities ?? null)).filter((x): x is number => x != null);
    const avgOcf = ocfs.length ? ocfs.reduce((s, x) => s + x, 0) / ocfs.length : null;
    const quarterlyBurn = avgOcf != null && avgOcf < 0 ? -avgOcf : null;
    const runway = quarterlyBurn && cashVal != null && cashVal > 0 ? cashVal / quarterlyBurn : null;
    if (runway != null) withRunway++;

    const salesNow = n(inc[0]?.sales ?? null);
    const salesYearAgo = n(yearAgo(inc)?.sales ?? null);
    const revenueTtm = inc
      .slice(0, 4)
      .map((r) => n(r.sales ?? null))
      .filter((x): x is number => x != null)
      .reduce((s, x, _i, arr) => (arr.length === 4 ? s + x : s), 0) || null;

    fundamentals.push({
      symbol_id: symbolId,
      as_of: a?.date ?? e[0]?.date ?? null,
      cash: cashVal,
      total_debt: totalDebt || null,
      net_cash: netCash,
      book_equity: bookEquity,
      shares_outstanding: sharesNow,
      net_cash_to_mktcap: netCash != null && cap ? netCash / cap : null,
      book_to_market: bookEquity != null && cap ? bookEquity / cap : null,
      op_cash_flow_ttm: avgOcf != null ? avgOcf * 4 : null,
      quarterly_burn: quarterlyBurn,
      runway_quarters: runway != null ? Math.round(runway * 10) / 10 : null,
      revenue_ttm: revenueTtm,
      revenue_growth_yoy:
        salesNow != null && salesYearAgo != null && salesYearAgo !== 0
          ? (salesNow - salesYearAgo) / Math.abs(salesYearAgo)
          : null,
      gross_margin: null, // gross_profit not pulled in v1
      share_change_yoy:
        sharesNow != null && sharesYearAgo != null && sharesYearAgo !== 0
          ? (sharesNow - sharesYearAgo) / sharesYearAgo
          : null,
      next_earnings_date: next,
      zacks_rank: rk?.rank ? (RANK_TO_NUM[rk.rank.trim().toLowerCase()] ?? null) : null,
      zacks_value: rk?.value ?? null,
      zacks_growth: rk?.growth ?? null,
      zacks_momentum: rk?.momentum ?? null,
      zacks_vgm: rk?.vgm ?? null,
      updated_at: new Date().toISOString(),
    });

    if (next) {
      forwardEarnings.push({ symbol_id: symbolId, report_date: next, synced_at: new Date().toISOString() });
    }
  }

  for (let i = 0; i < fundamentals.length; i += UPSERT_BATCH) {
    const { error } = await db
      .from("fundamentals")
      .upsert(fundamentals.slice(i, i + UPSERT_BATCH), { onConflict: "symbol_id" });
    if (error) throw error;
  }
  for (let i = 0; i < forwardEarnings.length; i += UPSERT_BATCH) {
    const { error } = await db
      .from("earnings")
      .upsert(forwardEarnings.slice(i, i + UPSERT_BATCH), { onConflict: "symbol_id,report_date" });
    if (error) throw error;
  }

  return {
    rowsProcessed: fundamentals.length,
    result: { symbols: fundamentals.length, withRunway, forwardEarnings: forwardEarnings.length },
  };
}
