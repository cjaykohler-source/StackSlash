import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import type { RegimeState } from "../lib/types";
import { InfoTooltip } from "./InfoTooltip";

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
      <strong>
        <InfoTooltip
          text={
            riskOn
              ? "The overall market is judged to be in a healthy uptrend. New long momentum/technical triggers are allowed to fire."
              : "The overall market is judged to be in an unhealthy trend. New long momentum/technical triggers are suppressed until conditions improve."
          }
        >
          {riskOn ? "RISK ON" : "RISK OFF"}
        </InfoTooltip>
      </strong>
      <span>
        {regime.index_symbol}{" "}
        <InfoTooltip text={`Whether ${regime.index_symbol}, the reference index for this regime read, is trading above or below its own 200-day moving average.`}>
          {regime.above_200dma ? "above" : "below"} 200DMA
        </InfoTooltip>{" "}
        ·{" "}
        <InfoTooltip text="How stretched recent volatility is relative to its own history — informs how aggressively the regime read reacts to short-term noise.">
          vol regime: {regime.vol_regime ?? "unknown"}
        </InfoTooltip>{" "}
        · as of {regime.as_of}
      </span>
    </div>
  );
}
