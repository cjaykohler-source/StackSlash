// Dark -> bright endpoint colors per trigger direction. Entry triggers
// (momentum/technical/breakout/earnings — everything that opens a
// position) use the app's existing brand green as the "at threshold"
// color; exit signals use a bright red distinct from --red so a maxed-out
// exit bar reads as more urgent than the neutral --red already used
// elsewhere (dossier score, RegimeBanner's regime-off state).
const PALETTE: Record<"entry" | "exit", { from: [number, number, number]; to: [number, number, number] }> = {
  entry: { from: [18, 61, 33], to: [37, 233, 121] }, // dark forest green -> brand green
  exit: { from: [61, 15, 20], to: [255, 56, 56] }, // dark maroon -> bright red
};

function lerpColor(from: [number, number, number], to: [number, number, number], t: number): string {
  const c = from.map((v, i) => Math.round(v + (to[i] - v) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

interface ProximityBarProps {
  /** 0 = far from firing, 1 = exactly at the threshold, >1 = already past it. */
  proximity: number | null;
  variant: "entry" | "exit";
}

/**
 * Continuous "how close is this to firing" readout for a trigger-status
 * row, sitting alongside the existing satisfied/not-satisfied badge
 * (which only shows the boolean end state). Bar width and label track the
 * real proximity value uncapped past 100% ("how far passed the trigger
 * point it has reached" per the ask); the fill *color* clamps at the
 * 100%-mark color so overshoot doesn't need a third palette stop.
 */
export function ProximityBar({ proximity, variant }: ProximityBarProps) {
  if (proximity === null) return null;

  const clamped = Math.max(0, Math.min(1, proximity));
  const widthPct = Math.max(0, Math.min(100, proximity * 100));
  const color = lerpColor(PALETTE[variant].from, PALETTE[variant].to, clamped);

  return (
    <div className="proximity-bar-row">
      <div className="proximity-bar-track">
        <div className="proximity-bar-fill" style={{ width: `${widthPct}%`, background: color }} />
      </div>
      <span className="proximity-bar-label">{Math.round(proximity * 100)}%</span>
    </div>
  );
}
