import { useEffect, useRef, useState } from "react";
import { PRICE_H } from "./SessionCandleChart";

interface Props {
  /** The session's total volume so far (all bars, extended hours included). */
  volume: number | null;
  /** Typical (median) daily volume over the 20 sessions before it. */
  typical: number | null;
  /** YYYY-MM-DD of the session being measured. */
  sessionDate: string | null;
  /** Session still in progress (the bar keeps growing). */
  live: boolean;
}

/**
 * Top of the scale, in multiples of a typical day: 0-4x normally, 0-8x
 * once the session reaches 4x (so a heavy day still shows how far past 4x
 * it has run), and pinned at the top past 8x.
 */
const BASE_MAX = 4;
const WIDE_MAX = 8;
const BASE_LINES = [1, 2, 3, 4];
const WIDE_LINES = [1, 2, 4, 6, 8];
const TRACK_TOP = 8;
const BAR_W = 34;

const fmtVol = (v: number) =>
  v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}K` : `${Math.round(v)}`;

/**
 * Session volume against a typical day, as one vertical bar the height of
 * the candle pane. The scale runs 0 to 4x the typical (median) day of the
 * prior 20 sessions; 1x sits a quarter of the way up, so crossing it means
 * a full normal day has already traded, and the bar keeps climbing through
 * 2x/3x/4x. At 4x the scale doubles to 0-8x (lines at 1/2/4/6/8x) so the
 * bar has room to keep growing; past 8x it pins to the top and the label
 * carries the real multiple.
 *
 * Volume is the whole session including extended hours, which is how the
 * daily bars it is compared with are built (SNAP 09-17: 49.70M daily vs
 * 49.70M across all minute bars, 45.90M regular-only).
 */
export function VolumeMeter({ volume, typical, sessionDate, live }: Props) {
  // The track takes whatever height the header and footer leave, measured
  // rather than assumed: a fixed footer allowance overflowed the box as soon
  // as its text wrapped to a second line.
  const trackRef = useRef<HTMLDivElement>(null);
  const [areaH, setAreaH] = useState(400);
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setAreaH(Math.max(120, Math.floor(entry.contentRect.height))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const trackH = areaH - TRACK_TOP - 2;
  const ready = volume != null && typical != null && typical > 0;
  const x = ready ? volume! / typical! : 0;
  const maxX = x >= BASE_MAX ? WIDE_MAX : BASE_MAX;
  const lines = maxX === WIDE_MAX ? WIDE_LINES : BASE_LINES;
  const shown = Math.min(x, maxX);
  const fillH = (shown / maxX) * trackH;
  const yOf = (mult: number) => TRACK_TOP + trackH - (mult / maxX) * trackH;
  const tone = x >= 3 ? "hot" : x >= 2 ? "warm" : x >= 1 ? "over" : "under";
  const dateLabel = sessionDate
    ? new Date(`${sessionDate}T12:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric" })
    : null;

  return (
    <div className="volume-meter" style={{ height: PRICE_H }} aria-label="Session volume versus a typical day">
      <div className="volume-meter-head">
        <span className="volume-meter-title">Volume vs typical</span>
        {ready ? (
          <>
            <b className={`volume-meter-mult ${tone}`}>{x.toFixed(x >= 10 ? 0 : 1)}×</b>
            <span className="volume-meter-sub">
              {fmtVol(volume!)} of {fmtVol(typical!)}
            </span>
          </>
        ) : (
          <span className="volume-meter-sub">{typical == null ? "Under 15 sessions of history" : "No volume yet"}</span>
        )}
      </div>

      <div className="volume-meter-track" ref={trackRef}>
      <svg width="100%" height={areaH} className="volume-meter-svg" role="img"
           aria-label={ready ? `${x.toFixed(1)} times a typical day` : "No reading"}>
        {/* track */}
        <rect x={0} y={TRACK_TOP} width={BAR_W} height={trackH} rx={4} className="vm-track" />
        {/* fill */}
        {ready && fillH > 0 && (
          <rect x={0} y={TRACK_TOP + trackH - fillH} width={BAR_W} height={fillH} rx={4} className={`vm-fill ${tone}`} />
        )}
        {/* past the top of the scale: a cap marker; the header has the real figure */}
        {ready && x > maxX && <path d={`M4,${TRACK_TOP + 10} L${BAR_W / 2},${TRACK_TOP + 2} L${BAR_W - 4},${TRACK_TOP + 10}`} className="vm-overflow" />}

        {/* scale lines; 1x is the one that matters most */}
        {lines.map((m) => (
          <g key={m}>
            <line x1={0} x2={BAR_W + 8} y1={yOf(m)} y2={yOf(m)} className={m === 1 ? "vm-line vm-line-1x" : "vm-line"} />
            <text x={BAR_W + 12} y={yOf(m) + 4} className={m === 1 ? "vm-label vm-label-1x" : "vm-label"}>
              {m === 1 ? "1× typical day" : `${m}×`}
            </text>
          </g>
        ))}
      </svg>
      </div>

      {/* One fact per line, so nothing wraps mid-phrase or starts with a dot. */}
      <div className="volume-meter-foot">
        {dateLabel && <div>{`${dateLabel}${live ? " · so far" : ""}`}</div>}
        {typical != null && <div title="Median daily volume of the 20 sessions before this one">vs 20-session median</div>}
        {maxX === WIDE_MAX && <div>scale widened to 0–8×</div>}
      </div>
    </div>
  );
}
