import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuotes, sessionLabel } from "./QuoteTag";
import { SpotlightIcon } from "./SpotlightIcon";
import { useTracking } from "../lib/useTracking";

const QUOTE_MS = 30_000;

/**
 * Dashboard sidebar "Tracking" column — the default home for a tracked
 * symbol. One compact row each (ticker · price · % today), with a
 * spotlight toggle that lifts the symbol's live chart into the Spotlight
 * grid at the top of the page, and × to stop tracking.
 *
 * Sits in the column the Top losers list used to occupy; losers now stack
 * under the gainers in the first column.
 */
export function TrackingList() {
  const { tracked, trackTicker, untrack, setSpotlight } = useTracking();
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const quotes = useQuotes(
    tracked.map((t) => t.ticker),
    QUOTE_MS,
  );

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !input.trim()) return;
    setBusy(true);
    setError(null);
    const message = await trackTicker(input);
    setError(message);
    if (!message) setInput("");
    setBusy(false);
  }

  return (
    <div className="top-movers-section tracking-list">
      <h3 className="top-movers-title">Tracking</h3>
      <form className="tracking-add" onSubmit={add}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Add symbol…"
          aria-label="Symbol to track"
        />
        <button type="submit" disabled={busy || !input.trim()}>
          Track
        </button>
      </form>
      {error && <p className="tracking-error">{error}</p>}
      {tracked.length === 0 ? (
        <p className="top-movers-empty">Nothing tracked yet.</p>
      ) : (
        <ol className="top-movers-list">
          {tracked.map((t) => {
            const q = quotes.get(t.ticker);
            const pct = q ? Number((q.changePct * 100).toFixed(1)) : null;
            const dir = pct == null ? "" : pct > 0 ? "up" : pct < 0 ? "down" : "";
            return (
              <li key={t.symbol_id} className="top-movers-row tracking-row">
                <button
                  type="button"
                  className={`spotlight-toggle${t.spotlight ? " on" : ""}`}
                  onClick={() => setSpotlight(t.symbol_id, !t.spotlight)}
                  aria-pressed={t.spotlight}
                  title={
                    t.spotlight
                      ? `${t.ticker}'s chart is in the Spotlight — click to remove it`
                      : `Show ${t.ticker}'s chart in the Spotlight at the top`
                  }
                >
                  <SpotlightIcon on={t.spotlight} />
                </button>
                <Link to={`/symbol/${t.ticker}`} className="top-movers-ticker">
                  {t.ticker}
                </Link>
                <span className="top-movers-price">{q ? `$${q.price.toFixed(2)}` : "—"}</span>
                <span className={`top-movers-pct ${dir}`}>
                  {pct == null ? "" : `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`}
                  {q?.delayed && (
                    <span className="quote-delayed" title="Consolidated tape, ~15 minutes behind — no real-time (IEX) prints today.">
                      {" "}15m
                    </span>
                  )}
                  {q?.stale && (
                    <span className="quote-delayed" title="No trade on any feed today — this is the last session's close.">
                      {" "}
                      {sessionLabel(q.asOf)}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  className="tracking-row-remove"
                  onClick={() => untrack(t.symbol_id)}
                  aria-label={`Stop tracking ${t.ticker}`}
                  title={`Stop tracking ${t.ticker}`}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
