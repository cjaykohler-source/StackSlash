import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import type { RegimeState } from "../lib/types";

/**
 * Always-visible risk-on/risk-off state. This is the kill-switch gate from
 * the design: when risk_on is false, eod-scan suppresses new momentum/
 * technical long triggers, and the UI should make that impossible to miss.
 */
export function RegimeBanner() {
  const [regime, setRegime] = useState<RegimeState | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const { data } = await supabase
        .from("regime_state")
        .select("*")
        .order("as_of", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!cancelled) setRegime(data as RegimeState | null);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!regime) {
    return <div className="regime-banner regime-unknown">Regime: no data yet</div>;
  }

  const riskOn = regime.risk_on;
  return (
    <div className={`regime-banner ${riskOn ? "regime-on" : "regime-off"}`}>
      <strong>{riskOn ? "RISK ON" : "RISK OFF"}</strong>
      <span>
        {regime.index_symbol} {regime.above_200dma ? "above" : "below"} 200DMA · vol regime:{" "}
        {regime.vol_regime ?? "unknown"} · as of {regime.as_of}
      </span>
    </div>
  );
}
