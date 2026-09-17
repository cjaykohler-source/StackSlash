import { useState } from "react";
import { useTracking } from "../lib/useTracking";

/**
 * Track / Tracking toggle for a symbol page, sitting on the title line
 * beside the price. Tracked symbols land in the dashboard's Tracking
 * column; the Spotlight toggle there decides which ones also get a chart
 * at the top of the dashboard.
 */
export function TrackButton({ symbolId }: { symbolId: number | null }) {
  const { bySymbolId, loaded, trackId, untrack } = useTracking();
  const [busy, setBusy] = useState(false);

  if (symbolId == null || !loaded) return null;
  const isTracked = bySymbolId.has(symbolId);

  async function toggle() {
    if (busy || symbolId == null) return;
    setBusy(true);
    try {
      if (isTracked) await untrack(symbolId);
      else await trackId(symbolId);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={`track-button${isTracked ? " tracking" : ""}`}
      onClick={toggle}
      disabled={busy}
      aria-pressed={isTracked}
      title={isTracked ? "Tracked — click to stop tracking" : "Add to the dashboard's Tracking column"}
    >
      {isTracked ? "✓ Tracking" : "Track"}
    </button>
  );
}
