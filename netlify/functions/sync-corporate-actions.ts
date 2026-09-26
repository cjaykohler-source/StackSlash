import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { fetchReverseSplits } from "./lib/alpaca";
import { etDateString } from "./lib/etTime";

/**
 * Persists Alpaca's forward-looking reverse-split feed into
 * `corporate_actions`. eod-scan.ts already calls fetchReverseSplits() every
 * night to evaluate avoid_reverse_split, but only holds the result in
 * memory -- nothing stored it, so "how many days until symbol X's reverse
 * split" was unqueryable outside that one evaluation. Confirmed live
 * 2026-09-25 that Alpaca's feed carries real lead time (up to ~19 days out
 * on a same-day probe), which is exactly what upcoming_catalysts needs.
 *
 * Window is generous both ways: 60 days back (so a fired avoid warning's
 * split stays queryable after the fact) and 60 days forward (well past the
 * live trigger's own +30d window, so this table is never the reason a
 * split falls out of view before the trigger's window would have caught
 * it). Upserted on (type, ticker, ex_date) -- Alpaca can amend a
 * previously-announced date, which upsert overwrites rather than
 * duplicating.
 *
 * Scheduled via netlify.toml, once daily.
 */
const BACK_DAYS = 60;
const FORWARD_DAYS = 60;

export default async () => {
  const db = getSupabaseAdmin();

  await withJobRun(db, "sync-corporate-actions", async () => {
    const symbolIdByTicker = new Map<string, number>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from("symbols").select("id, ticker").eq("active", true).range(from, from + 999);
      if (error) throw error;
      for (const s of (data as { id: number; ticker: string }[] | null) ?? []) symbolIdByTicker.set(s.ticker, s.id);
      if (!data || data.length < 1000) break;
    }

    const today = etDateString(Date.now());
    const shift = (days: number) => new Date(Date.parse(`${today}T12:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
    const splits = await fetchReverseSplits(shift(-BACK_DAYS), shift(FORWARD_DAYS));

    const rows = splits
      .map((s) => ({
        type: "reverse_split",
        symbol_id: symbolIdByTicker.get(s.symbol) ?? null,
        ticker: s.symbol,
        ex_date: s.ex_date,
        process_date: s.process_date ?? null,
        record_date: s.record_date ?? null,
        payable_date: s.payable_date ?? null,
        old_rate: s.old_rate ?? null,
        new_rate: s.new_rate ?? null,
        synced_at: new Date().toISOString(),
      }))
      // Not every symbol Alpaca lists is one this project tracks -- keep
      // the row only when it maps to a tracked symbol, same convention as
      // sec-filings-sync's ticker resolution.
      .filter((r) => r.symbol_id != null);

    let written = 0;
    for (let i = 0; i < rows.length; i += 1000) {
      const { error } = await db.from("corporate_actions").upsert(rows.slice(i, i + 1000), { onConflict: "type,ticker,ex_date" });
      if (error) throw error;
      written += rows.slice(i, i + 1000).length;
    }

    return { rowsProcessed: written, result: { fetched: splits.length, matched: rows.length } };
  });

  return new Response("ok");
};
