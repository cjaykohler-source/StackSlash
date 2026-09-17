/**
 * Benzinga's sector roundups — "12 Industrials Stocks Moving In Friday's
 * Pre-Market Session", "10 Health Care Stocks With Whale Alerts In Today's
 * Session" — tag a dozen tickers each and show up on every one of them.
 * They say nothing specific about any single symbol and crowd out the
 * headlines that do, so they are dropped from symbol news, dossiers,
 * alert cards and the catalyst news-age check.
 *
 * Matches a headline that OPENS with a count and then "... Stocks". Checked
 * 2026-09-17 against 30 days of symbol_news: it catches exactly the two
 * roundup families (163 of 1,114 headlines) and none of the company-led
 * multi-ticker stories, e.g. "Why Dell Shares Are Trading Higher...; Here
 * Are 20 Stocks Moving Premarket" is kept. Mirrored in src/lib/newsFilter.ts.
 */
export const ROUNDUP_HEADLINE = /^\s*\d+\s+[a-z&,/'’\- ]*\bstocks?\b/i;

export function isRoundupHeadline(headline: string | null | undefined): boolean {
  return !!headline && ROUNDUP_HEADLINE.test(headline);
}
