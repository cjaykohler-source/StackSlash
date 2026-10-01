/**
 * Headline catalysts validated out of sample as avoid rules
 * (docs/catalyst-2022-prereg.md, 2026-10-01): a trading halt and a
 * partnership / licensing PR. The patterns are copied verbatim from the
 * research classifier (research/catalysts/sources.py NEWS_TYPES, matched
 * case-insensitively) and so is its rule that only headlines naming at most
 * three tickers count — keep them identical, or the live flag stops being
 * the thing that was tested.
 */

export const HALT_RE = /\bhalted\b|trading halt/i;
// One deliberate difference from the research pattern: Benzinga's "Halt status updated ... IPO security
// released for quotation" notices (from 2026) mark a new listing, not a halt. A new listing has no 20-day
// dollar-volume history, so these almost never passed the test's liquidity gate (86 such headlines in
// 2026, vs ~2,600 ordinary halt-status notices 2023-26 that did count); flagging every fresh IPO as
// "halted" would claim a result the test never measured.
export const HALT_EXCLUDE_RE = /IPO security released/i;
export const PARTNERSHIP_RE = /\b(?:partnership|collaboration|strategic alliance|licens(?:e|ing) agreement|joint venture)\b/i;
export const MAX_SYMBOLS = 3;
// The test measured the 20 sessions after the headline; ~28 calendar days covers them.
export const FLAG_DAYS = 28;

export interface NewsRow {
  headline: string;
  created_at: string;
  symbols: string[] | null;
}

/** Days since the newest qualifying headline of each kind (null if none in the window). */
export function catalystNewsAges(rows: NewsRow[], now = Date.now()): { haltDays: number | null; partnershipDays: number | null } {
  let halt: number | null = null;
  let partnership: number | null = null;
  for (const r of rows) {
    const n = r.symbols?.length ?? 0;
    if (n < 1 || n > MAX_SYMBOLS) continue;
    const days = Math.max(0, Math.floor((now - Date.parse(r.created_at)) / 86400_000));
    if (days > FLAG_DAYS) continue;
    if (HALT_RE.test(r.headline) && !HALT_EXCLUDE_RE.test(r.headline) && (halt == null || days < halt)) halt = days;
    if (PARTNERSHIP_RE.test(r.headline) && (partnership == null || days < partnership)) partnership = days;
  }
  return { haltDays: halt, partnershipDays: partnership };
}
