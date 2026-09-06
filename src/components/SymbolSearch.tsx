import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabaseClient";

/**
 * Jump straight to any symbol's page. If it's already tracked, this is
 * just a fast client-side lookup + navigate. If it isn't, it calls
 * onboard-symbol (validate against Alpaca, backfill history, run a real
 * eod-scan so the new symbol gets correctly cross-sectional-ranked
 * factors) before navigating — synchronous with a single honest status
 * message, not fake step-by-step progress, since the backend call
 * doesn't stream real progress.
 */
export function SymbolSearch() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const ticker = query.trim().toUpperCase();
    if (!ticker || busy) return;
    setError(null);

    const { data: existing } = await supabase
      .from("symbols")
      .select("ticker")
      .eq("ticker", ticker)
      .eq("active", true)
      .maybeSingle();
    if (existing) {
      navigate(`/symbol/${ticker}`);
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/.netlify/functions/onboard-symbol", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? `Couldn't add ${ticker}.`);
        setBusy(false);
        return;
      }
      navigate(`/symbol/${ticker}`);
    } catch {
      setError("Network error — try again.");
      setBusy(false);
    }
  }

  return (
    <form className="symbol-search" onSubmit={handleSubmit}>
      <input
        type="text"
        placeholder="Search symbol…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        disabled={busy}
      />
      <button type="submit" disabled={busy || !query.trim()}>
        {busy ? "Adding…" : "Go"}
      </button>
      {busy && (
        <p className="symbol-search-status">
          Adding {query.trim().toUpperCase()}… backfilling history and running the scan, this can take a bit.
        </p>
      )}
      {error && <p className="symbol-search-error">{error}</p>}
    </form>
  );
}
