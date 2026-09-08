import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface InfoTooltipProps {
  text: string;
  children: ReactNode;
  /** For metric/trigger labels, underlines the label so it reads as
   *  hoverable. Off by default for things like badges that already look
   *  interactive on their own. */
  underline?: boolean;
}

/**
 * Portal-rendered hover/focus tooltip, positioned from the anchor's own
 * getBoundingClientRect() rather than CSS. A pure-CSS tooltip (absolutely
 * positioned inside the label, shown on :hover) would get clipped by every
 * scrolling ancestor with overflow set — and this app has several
 * (.trigger-feed-scroll, .symbol-profile, .report-canvas's wrapper) — so
 * position: fixed computed in JS and portaled to document.body is the only
 * way a tooltip over a table cell or a scrolled list doesn't get cut off.
 *
 * Flips below the anchor near the top of the viewport so it's never
 * rendered off-screen above row 1 of a table.
 */
const BUBBLE_HALF_WIDTH = 130; // matches --info-tooltip-max-width / 2 in CSS
const VIEWPORT_MARGIN = 8;

export function InfoTooltip({ text, children, underline = true }: InfoTooltipProps) {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; placement: "above" | "below" } | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);

  function show() {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const placement = rect.top < 60 ? "below" : "above";
    // Clamp so the bubble (centered under transform: translateX(-50%))
    // never renders partly off-screen for an anchor near the left/right
    // edge — e.g. the leftmost column of a table.
    const centerX = rect.left + rect.width / 2;
    const left = Math.min(
      Math.max(centerX, BUBBLE_HALF_WIDTH + VIEWPORT_MARGIN),
      window.innerWidth - BUBBLE_HALF_WIDTH - VIEWPORT_MARGIN,
    );
    setPos({
      top: placement === "above" ? rect.top : rect.bottom,
      left,
      placement,
    });
    setVisible(true);
  }

  function hide() {
    setVisible(false);
  }

  return (
    <span
      ref={anchorRef}
      className={`info-tooltip-anchor${underline ? " info-tooltip-underline" : ""}`}
      tabIndex={0}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {visible &&
        pos &&
        createPortal(
          <div
            className={`info-tooltip-bubble info-tooltip-${pos.placement}`}
            style={{ top: pos.top, left: pos.left }}
          >
            {text}
          </div>,
          document.body,
        )}
    </span>
  );
}
