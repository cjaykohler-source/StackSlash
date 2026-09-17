// Mirror of netlify/functions/lib/newsFilter.ts (the browser bundle can't
// import from netlify/functions). Drops Benzinga sector roundups such as
// "12 Industrials Stocks Moving In Friday's Pre-Market Session" — they carry
// no symbol-specific news. Keep the two regexes identical.
export const ROUNDUP_HEADLINE = /^\s*\d+\s+[a-z&,/'’\- ]*\bstocks?\b/i;

export function isRoundupHeadline(headline: string | null | undefined): boolean {
  return !!headline && ROUNDUP_HEADLINE.test(headline);
}
