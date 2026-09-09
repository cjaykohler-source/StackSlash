import { useEffect, useState } from "react";

interface NewsItem {
  id: number;
  headline: string;
  url: string;
  source: string;
  author: string;
  ts: string;
}

function ago(ts: string): string {
  const mins = Math.round((Date.now() - Date.parse(ts)) / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Recent headlines for a symbol (Alpaca / Benzinga via the `news`
 * function). The scanner surfaces price action; this is the "why".
 * Headline-only on the free tier — each links out to the full article.
 */
export function SymbolNews({ ticker }: { ticker: string }) {
  const [items, setItems] = useState<NewsItem[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setFailed(false);
    fetch(`/.netlify/functions/news?symbol=${encodeURIComponent(ticker)}`)
      .then((r) => r.json())
      .then((body: { news?: NewsItem[] }) => {
        if (!cancelled) setItems(body.news ?? []);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [ticker]);

  if (failed) return null;

  return (
    <div className="symbol-news">
      <h3 className="symbol-news-title">Recent news</h3>
      {items === null ? (
        <p className="symbol-news-empty">Loading…</p>
      ) : items.length === 0 ? (
        <p className="symbol-news-empty">No recent headlines for this symbol.</p>
      ) : (
        <ul className="symbol-news-list">
          {items.map((n) => (
            <li key={n.id} className="symbol-news-item">
              <a href={n.url} target="_blank" rel="noopener noreferrer">
                {n.headline}
              </a>
              <span className="symbol-news-meta">
                {n.source} · {ago(n.ts)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
