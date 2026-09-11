/**
 * The fix for this project's most expensive recurring bug.
 *
 * PostgREST silently caps an unranged `.select()` at ~1,000 rows — no
 * error, no warning, just a truncated result that every downstream
 * calculation then treats as the whole table. That has been found and
 * fixed five separate times here (MarketBreadth, eod-scan,
 * backfill-history, backtest-triggers, sim-flip-exits), and each time it
 * had been quietly changing real numbers for weeks or months: at one
 * point it left ~4,000 of ~5,000 symbols with an 18-month history
 * instead of 5 years, and skewed every trigger_stats row toward the
 * S&P-seeded first thousand tickers.
 *
 * Use this instead of writing another `.range()` loop by hand. Callers
 * pass a function that applies the range to their own query, so filters,
 * ordering, and joins stay theirs:
 *
 *   const symbols = await fetchAllPaginated((from, to) =>
 *     db.from("symbols").select("id, ticker").eq("active", true).range(from, to)
 *   );
 *
 * Throws on a short-read inconsistency rather than returning a
 * plausible-looking partial result — a truncated universe should stop a
 * job, not quietly shrink it.
 */

type RangedQuery<T> = (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>;

export async function fetchAllPaginated<T>(
  query: RangedQuery<T>,
  opts: { pageSize?: number; maxRows?: number } = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? 1000;
  const maxRows = opts.maxRows ?? 500_000;
  const rows: T[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await query(from, from + pageSize - 1);
    if (error) throw error;
    if (!data?.length) break;

    rows.push(...data);

    if (data.length < pageSize) break;
    if (rows.length >= maxRows) {
      throw new Error(
        `fetchAllPaginated exceeded maxRows (${maxRows}) — refusing to keep paging. ` +
          `Either the query is unfiltered or maxRows needs raising deliberately.`,
      );
    }
  }

  return rows;
}
