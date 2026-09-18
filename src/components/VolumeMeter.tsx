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

/** Top of the scale, in multiples of a typical day. */
const MAX_X = 4;
const HEADER_H = 58;
const FOOTER_H = 28;
const TRACK_TOP = 8;
const BAR_W = 34;

const fmtVol = (v: number) =>
  v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}K` : `${Math.round(v)}`;

/**
 * Session volume against a typical day, as one vertical bar the height of
 * the candle pane. The scale runs 0 to 4x the typical (median) day of the
 * prior 20 sessions; 1x sits a quarter of the way up, so crossing it means
 * a full normal day has already traded, and the bar keeps climbing through
 * 2x/3x/4x. Past 4x it pins to the top and the label carries the real
 * multiple — the scale never moves, so the lines always mean the same thing.
 *
 * Volume is the whole session including extended hours, which is how the
 * daily bars it is compared with are built (SNAP 09-17: 49.70M daily vs
 * 49.70M across all minute bars, 45.90M regular-only).
 */
export function VolumeMeter({ volume, typical, sessionDate, live }: Props) {
  const trackH = PRICE_H - HEADER_H - FOOTER_H - TRACK_TOP;
  const ready = volume != null && typical != null && typical > 0;
  const x = ready ? volume! / typical! : 0;
  const shown = Math.min(x, MAX_X);
  const fillH = (shown / MAX_X) * trackH;
  const yOf = (mult: number) => TRACK_TOP + trackH - (mult / MAX_X) * trackH;
  const tone = x >= 3 ? "hot" : x >= 2 ? "warm" : x >= 1 ? "over" : "under";
  const dateLabel = sessionDate
    ? new Date(`${sessionDate}T12:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric" })
    : null;

  return (
    <div className="volume-meter" style={{ height: PRICE_H }} aria-label="Session volume versus a typical day">
      <div className="volume-meter-head" style={{ height: HEADER_H }}>
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

      <svg width="100%" height={trackH + TRACK_TOP + 2} className="volume-meter-svg" role="img"
           aria-label={ready ? `${x.toFixed(1)} times a typical day` : "No reading"}>
        {/* track */}
        <rect x={0} y={TRACK_TOP} width={BAR_W} height={trackH} rx={4} className="vm-track" />
        {/* fill */}
        {ready && fillH > 0 && (
          <rect x={0} y={TRACK_TOP + trackH - fillH} width={BAR_W} height={fillH} rx={4} className={`vm-fill ${tone}`} />
        )}
        {/* past the top of the scale: a cap marker; the header has the real figure */}
        {ready && x > MAX_X && <path d={`M4,${TRACK_TOP + 10} L${BAR_W / 2},${TRACK_TOP + 2} L${BAR_W - 4},${TRACK_TOP + 10}`} className="vm-overflow" />}

        {/* 1x-4x lines; 1x is the one that matters most */}
        {[1, 2, 3, 4].map((m) => (
          <g key={m}>
            <line x1={0} x2={BAR_W + 8} y1={yOf(m)} y2={yOf(m)} className={m === 1 ? "vm-line vm-line-1x" : "vm-line"} />
            <text x={BAR_W + 12} y={yOf(m) + 4} className={m === 1 ? "vm-label vm-label-1x" : "vm-label"}>
              {m === 1 ? "1× typical day" : `${m}×`}
            </text>
          </g>
        ))}
      </svg>

      <div className="volume-meter-foot" style={{ height: FOOTER_H }}>
        {dateLabel ? `${dateLabel}${live ? " · so far" : ""}` : ""}
        {typical != null && <span> · median of prior 20 sessions</span>}
      </div>
    </div>
  );
}
