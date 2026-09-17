/**
 * Spotlight glyph — a stage light throwing a cone of light. Marks the
 * tracked symbols whose live charts are lifted into the dashboard's
 * Spotlight grid. Filled when on, outline when off.
 */
export function SpotlightIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      {/* the lamp */}
      <rect
        x="4.5"
        y="1.5"
        width="7"
        height="4"
        rx="1.2"
        fill={on ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.2"
      />
      {/* the beam */}
      <path
        d="M4.9 5.8 L1.8 14.2 H14.2 L11.1 5.8 Z"
        fill={on ? "currentColor" : "none"}
        fillOpacity={on ? 0.35 : 0}
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
