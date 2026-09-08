import { useEffect, useState } from "react";

export interface Quote {
  price: number;
  changePct: number; // fraction, measured from today's open
}

/**
 * Fetches `$price | ±x%` quotes for a set of tickers in one batched call
 * to the `quotes` function (Alpaca snapshots server-side). Refetches only
 * when the distinct sorted ticker set changes. Returns a Map keyed by
 * ticker; missing entries just render nothing.
 */
export function useQuotes(tickers: string[]): Map<string, Quote> {
  const [quotes, setQuotes] = useState<Map<string, Quote>>(new Map());
  const key = [...new Set(tickers.filter(Boolean))].sort().join(",");

  useEffect(() => {
    if (!key) {
      setQuotes(new Map());
      return;
    }
    let cancelled = false;
    fetch(`/.netlify/functions/quotes?symbols=${encodeURIComponent(key)}`)
      .then((r) => (r.ok ? r.json() : {}))
      .then((data: Record<string, Quote>) => {
        if (!cancelled) setQuotes(new Map(Object.entries(data)));
      })
      .catch(() => {
        /* quotes are non-critical chrome — leave the last set on failure */
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  return quotes;
}

/** `$14.89 | -0.3%`, green if up on the day, red if down. */
export function QuoteTag({ quote }: { quote: Quote | undefined }) {
  if (!quote) return null;
  const { price, changePct } = quote;
  // Round first, then colour off the rounded number so a "-0.0%" reading
  // isn't shown in red.
  const pctRounded = Number((changePct * 100).toFixed(1));
  const dir = pctRounded > 0 ? "up" : pctRounded < 0 ? "down" : "";
  const pctText = `${pctRounded > 0 ? "+" : ""}${pctRounded.toFixed(1)}%`;
  return (
    <span className={`quote-tag ${dir}`}>
      ${price.toFixed(2)} <span className="quote-tag-sep">|</span> {pctText}
    </span>
  );
}
