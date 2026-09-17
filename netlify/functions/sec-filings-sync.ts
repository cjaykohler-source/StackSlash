import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { etDateString } from "./lib/etTime";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * SEC filings for tracked symbols, from EDGAR's daily form index — one small
 * file per business day listing every filing (form, company, CIK, date,
 * accession). Kept: share-offering forms (drive the "Offering filed" red
 * flag) plus 8-K and SC 13D/13G (catalyst research). Mapped to symbols via
 * SEC's company_tickers.json.
 *
 * Runs on launchd (07:30 and 17:30 ET weekdays, before eod-scan). Catches up
 * from the latest stored filing date, up to 45 days back on an empty table.
 *
 * SEC fair-access policy: automated requests must identify a contact in the
 * User-Agent (SEC_USER_AGENT in the host .env) and stay under 10 req/s.
 */

export const OFFERING_FORMS = ["S-1", "S-3", "F-1", "F-3", "424B4", "424B5"];
const KEEP_FORMS = new Set([...OFFERING_FORMS, "8-K", "SC 13D", "SC 13G"]);
const BACKFILL_DAYS = 45;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function secFetch(url: string): Promise<Response> {
  const ua = process.env.SEC_USER_AGENT;
  if (!ua) throw new Error("SEC_USER_AGENT is not set (SEC requires a contact in the User-Agent)");
  await sleep(150); // well under SEC's 10 requests/second
  return fetch(url, { headers: { "User-Agent": ua, "Accept-Encoding": "gzip, deflate" } });
}

export default async () => {
  const db = getSupabaseAdmin();

  const result = await withJobRun(db, "sec-filings-sync", async () => {
    // CIK -> tickers (a CIK can list several share classes)
    const tickersRes = await secFetch("https://www.sec.gov/files/company_tickers.json");
    if (!tickersRes.ok) throw new Error(`company_tickers.json: ${tickersRes.status}`);
    const tickersJson = (await tickersRes.json()) as Record<string, { cik_str: number; ticker: string }>;
    const tickersByCik = new Map<number, string[]>();
    for (const r of Object.values(tickersJson)) {
      const list = tickersByCik.get(r.cik_str) ?? [];
      list.push(r.ticker.toUpperCase());
      tickersByCik.set(r.cik_str, list);
    }

    const symbolIdByTicker = new Map<string, number>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from("symbols").select("id, ticker").eq("active", true).range(from, from + 999);
      if (error) throw error;
      for (const s of (data as { id: number; ticker: string }[] | null) ?? []) symbolIdByTicker.set(s.ticker, s.id);
      if (!data || data.length < 1000) break;
    }

    // Business days to fetch: after the latest stored filing date, or backfill.
    const { data: latest } = await db
      .from("sec_filings")
      .select("filing_date")
      .order("filing_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    const today = etDateString(Date.now());
    const start = latest?.filing_date
      ? new Date(Date.parse(`${latest.filing_date}T12:00:00Z`))
      : new Date(Date.parse(`${today}T12:00:00Z`) - BACKFILL_DAYS * 86400_000);
    const days: string[] = [];
    for (let t = start.getTime(); t <= Date.parse(`${today}T12:00:00Z`); t += 86400_000) {
      const d = new Date(t);
      if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) days.push(d.toISOString().slice(0, 10));
    }

    let fetchedDays = 0;
    let kept = 0;
    for (const day of days) {
      const [y, m] = day.split("-").map(Number);
      const q = Math.floor((m - 1) / 3) + 1;
      const url = `https://www.sec.gov/Archives/edgar/daily-index/${y}/QTR${q}/form.${day.replace(/-/g, "")}.idx`;
      const res = await secFetch(url);
      if (res.status === 404 || res.status === 403) continue; // holiday / index not published yet
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      fetchedDays++;
      const text = await res.text();
      const body = text.slice(text.indexOf("-----") >= 0 ? text.indexOf("\n", text.indexOf("-----")) + 1 : 0);

      const rows: Record<string, unknown>[] = [];
      for (const line of body.split("\n")) {
        // Form Type | Company Name | CIK | Date Filed | File Name  (columns separated by 2+ spaces)
        const m2 = line.match(/^(\S(?:.*?\S)?)\s{2,}(.+?)\s{2,}(\d+)\s{2,}(\d{8})\s{2,}(\S+)\s*$/);
        if (!m2) continue;
        const [, form, company, cikStr, dateFiled, fileName] = m2;
        if (!KEEP_FORMS.has(form)) continue;
        const cik = Number(cikStr);
        const accession = fileName.split("/").pop()!.replace(/\.txt$/, "");
        for (const ticker of tickersByCik.get(cik) ?? []) {
          const symbolId = symbolIdByTicker.get(ticker);
          if (symbolId == null) continue;
          rows.push({
            accession: `${accession}:${ticker}`,
            cik,
            symbol_id: symbolId,
            ticker,
            form,
            filing_date: `${dateFiled.slice(0, 4)}-${dateFiled.slice(4, 6)}-${dateFiled.slice(6, 8)}`,
            company: company.trim(),
          });
        }
      }
      for (let i = 0; i < rows.length; i += 1000) {
        const { error } = await db.from("sec_filings").upsert(rows.slice(i, i + 1000), { onConflict: "accession" });
        if (error) throw error;
      }
      kept += rows.length;
    }

    // 8-K item numbers aren't in the daily index. Fill them from SEC's
    // submissions API (one request per company) for recent 8-Ks of $0.10-$5
    // companies — item 2.02 drives the Earnings Release catalyst.
    const itemsFilled = await fillEightKItems(db);

    return { rowsProcessed: kept, result: { days: days.length, fetchedDays, kept, itemsFilled } };
  });

  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
};

async function fillEightKItems(db: SupabaseClient): Promise<number> {
  const since = new Date(Date.now() - 45 * 86400_000).toISOString().slice(0, 10);
  // band symbols from the latest factor snapshot
  const band = new Set<number>();
  const { data: asOfRow } = await db.from("factor_state").select("as_of").order("as_of", { ascending: false }).limit(1).maybeSingle();
  if (asOfRow?.as_of) {
    for (let from = 0; ; from += 1000) {
      const { data } = await db
        .from("factor_state")
        .select("symbol_id")
        .eq("as_of", asOfRow.as_of)
        .gte("last_close", 0.1)
        .lte("last_close", 5)
        .range(from, from + 999);
      for (const r of (data as { symbol_id: number }[] | null) ?? []) band.add(r.symbol_id);
      if (!data || data.length < 1000) break;
    }
  }
  const pending: { accession: string; cik: number; symbol_id: number }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("sec_filings")
      .select("accession, cik, symbol_id")
      .eq("form", "8-K")
      .is("items", null)
      .gte("filing_date", since)
      .range(from, from + 999);
    if (error) throw error;
    pending.push(...((data as { accession: string; cik: number; symbol_id: number }[] | null) ?? []));
    if (!data || data.length < 1000) break;
  }
  const byCik = new Map<number, string[]>();
  for (const p of pending) {
    if (!band.has(p.symbol_id)) continue;
    const list = byCik.get(p.cik) ?? [];
    list.push(p.accession);
    byCik.set(p.cik, list);
  }
  let filled = 0;
  for (const [cik, keys] of byCik) {
    const res = await secFetch(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`);
    if (!res.ok) continue;
    const body = (await res.json()) as { filings?: { recent?: { accessionNumber: string[]; items: string[] } } };
    const recent = body.filings?.recent;
    if (!recent) continue;
    const itemsByAcc = new Map(recent.accessionNumber.map((a, i) => [a, recent.items[i] ?? ""]));
    for (const key of keys) {
      const items = itemsByAcc.get(key.split(":")[0]);
      if (items == null) continue;
      const { error } = await db.from("sec_filings").update({ items }).eq("accession", key);
      if (error) throw error;
      filled++;
    }
  }
  return filled;
}
