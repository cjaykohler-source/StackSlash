import { useEffect, useState } from "react";

export interface Quote {
  price: number;
  changePct: number; // fraction, measured from today's open
  /** from the consolidated tape, ~15 min behind: IEX had no print today */
  delayed?: boolean;
  /** no trade today on any feed — price/change are the session in `asOf` */
  stale?: boolean;
  /** YYYY-MM-DD of the session this quote describes, when not today */
  asOf?: string;
}

/** "Sep 17" from a YYYY-MM-DD session date. */
export function sessionLabel(asOf: string | undefined): string {
  if (!asOf) return "";
  return new Date(`${asOf}T12:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Fetches `$price | ±x%` quotes for a set of tickers in one batched call
 * to the `quotes` function (Alpaca snapshots server-side). Refetches only
 * when the distinct sorted ticker set changes. Returns a Map keyed by
 * ticker; missing entries just render nothing.
 */
export function useQuotes(tickers: string[], pollMs?: number): Map<string, Quote> {
  const [quotes, setQuotes] = useState<Map<string, Quote>>(new Map());
  const key = [...new Set(tickers.filter(Boolean))].sort().join(",");

  useEffect(() => {
    if (!key) {
      setQuotes(new Map());
      return;
    }
    let cancelled = false;
    const fetchQuotes = () =>
      fetch(`/.netlify/functions/quotes?symbols=${encodeURIComponent(key)}`)
        .then((r) => (r.ok ? r.json() : {}))
        .then((data: Record<string, Quote>) => {
          if (!cancelled) setQuotes(new Map(Object.entries(data)));
        })
        .catch(() => {
          /* quotes are non-critical chrome — leave the last set on failure */
        });

    fetchQuotes();
    const id = pollMs ? setInterval(fetchQuotes, pollMs) : undefined;
    return () => {
      cancelled = true;
      if (id) clearInterval(id);
    };
  }, [key, pollMs]);

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
      {quote.delayed && <span className="quote-delayed" title="Consolidated tape, ~15 minutes behind — this stock has no real-time (IEX) prints today."> 15m</span>}
      {quote.stale && (
        <span className="quote-delayed" title="No trade on any feed today — this is the last session's close.">
          {" "}
          {sessionLabel(quote.asOf)}
        </span>
      )}
    </span>
  );
}
