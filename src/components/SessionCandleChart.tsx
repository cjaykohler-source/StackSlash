import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type React from "react";
import { etDateString, etTimeLabel, etWallClock, sessionAxis } from "../lib/marketTime";

/** One SIP 1-minute bar, as returned by the session-candles function. */
export interface Candle {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw: number | null;
  n: number | null;
}

/** Prior session's regular-hours totals (cut at the same minute of day when this session is live). */
export interface PrevSession {
  date: string;
  through_minute: number;
  volume: number;
  trades: number;
  minutes_traded: number;
}

interface Props {
  bars: Candle[];
  prevClose: number | null;
  prevSession?: PrevSession | null;
  /** Session still in progress: Auto judges coverage over elapsed minutes only. */
  live?: boolean;
  /** Page column to render the snapshot stats into (right side). */
  statsTarget?: HTMLElement | null;
  /**
   * Typical (median) daily volume over the 20 sessions before this one (see
   * lib/volumeBaseline.ts). Drawn as a dotted line at its per-candle share,
   * so each volume bar reads as above or below a normal pace.
   */
  typicalDailyVolume?: number | null;
  /** Controls row element to render the candle-interval picker into. */
  controlsTarget?: HTMLElement | null;
}

const LEFT = 52; // volume labels
const RIGHT = 68; // price labels
const TOP = 10;
const AXIS_H = 22;
const PANE_GAP = 10;
// Fixed pane heights, so resizing one never resizes the other. The candle
// pane has been grown 15% twice (395 -> 455 -> 523px) and is left alone here
// -- VolumeMeter pins its own height to PRICE_H. The volume pane had been
// held at its original size through both of those and had become a thin
// strip; 139 -> 200 gives it a readable share of the frame.
export const PRICE_H = 523;
export const VOL_H = 200;
const HEIGHT = TOP + PRICE_H + PANE_GAP + VOL_H + AXIS_H;

const fmtPrice = (p: number) => (p < 1 ? p.toFixed(4) : p.toFixed(2));
const fmtVol = (v: number) =>
  v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : `${v}`;
const fmtPct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;

/** Candle intervals offered, in minutes. All divide the 390-minute session evenly. */
const INTERVALS = [1, 2, 5, 10, 15] as const;
type Interval = (typeof INTERVALS)[number];
const SESSION_MINUTES = 390;
// Auto default: the finest interval where at least this share of slots saw
// a trade (so candles read as a price path, not scattered dots)...
const AUTO_MIN_COVERAGE = 0.75;
// ...and that fits this many candles across the session (1-min bars on a
// liquid name are 390 hair-thin candles; 2-min is the readable floor).
const AUTO_MAX_CANDLES = 200;

/**
 * Pick the default interval from the regular-session minutes that traded.
 * `spanMinutes` is how much of the session coverage is judged over: all
 * 390 minutes for a finished session, only the elapsed part of a live one
 * (otherwise every live session looks thin and falls back to 15m).
 */
function autoInterval(tradedMinutes: number[], spanMinutes = SESSION_MINUTES): { k: Interval; coverage: number } {
  const coverageAt = (k: Interval) =>
    new Set(tradedMinutes.map((m) => Math.floor(m / k))).size / Math.max(1, Math.ceil(spanMinutes / k));
  for (const k of INTERVALS) {
    const coverage = coverageAt(k);
    if (coverage >= AUTO_MIN_COVERAGE && SESSION_MINUTES / k <= AUTO_MAX_CANDLES) return { k, coverage };
  }
  // Nothing clears the bar (a very thin name): use the coarsest interval.
  return { k: 15, coverage: coverageAt(15) };
}

function niceStep(span: number, target: number): number {
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
}

/**
 * A full picture of one symbol-session: 1-minute candles over the fixed
 * 4:00a-8:00p ET session axis (extended hours compressed to 1/3 width,
 * same axis as the Day line chart), with volume bars bottom-aligned
 * beneath, the session VWAP (regular hours only), the prior close, and
 * shading over pre-market and after-hours. Hover for a crosshair with the
 * bar's OHLC, volume, trades and running VWAP.
 *
 * Extended-hours bars are drawn but never enter VWAP or the OHLC stats.
 * They come from the consolidated tape (SIP), which the free data plan
 * serves only 15+ minutes old, so a live session's most recent minutes are
 * always missing -- `live` marks the view delayed rather than implying it
 * is current.
 *
 * Plain SVG rather than recharts: recharts has no candlestick, and a
 * session is at most ~960 bars, so direct drawing stays light.
 */
export function SessionCandleChart({
  bars,
  prevClose,
  prevSession = null,
  live = false,
  statsTarget = null,
  typicalDailyVolume = null,
  controlsTarget = null,
}: Props) {
  const height = HEIGHT;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [hover, setHover] = useState<number | null>(null);
  const [choice, setChoice] = useState<"auto" | Interval>("auto");

  // A new session starts back on the automatic interval. Keyed on the
  // session's first bar, so the live view's minute refresh keeps the choice.
  const sessionKey = bars[0]?.t.slice(0, 10);
  useEffect(() => {
    setChoice("auto");
    setHover(null);
  }, [sessionKey]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(320, Math.floor(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const m = useMemo(() => {
    const all = bars.map((b) => ({ ...b, ms: Date.parse(b.t) })).sort((a, b) => a.ms - b.ms);
    const axis = sessionAxis(all[0]?.ms ?? Date.now());
    const isRegular = (ms: number) => {
      const u = axis.toX(ms);
      return u >= axis.open && u < axis.close;
    };
    // The whole 4:00a-8:00p session. Pre-market and after-hours are drawn on
    // the compressed part of the axis (an extended hour is 1/3 the width of a
    // regular one), shaded, and excluded from VWAP and the OHLC stats -- those
    // stay regular-session, because a 4am print is not the day's open.
    const raw = all;
    const regular = all.filter((p) => isRegular(p.ms));
    // Minutes since 9:30, from REAL elapsed time against the session's own
    // 9:30 ET. It cannot come from the axis: `toX` returns layout units, and
    // an extended hour is 1/3 of one, so `(toX - open) * 60` equals minutes
    // only inside the regular session. Feeding extended bars through that
    // form squashed pre-market into a third of its width and put the whole
    // anchor at 5:50 AM -- 4:00a read as 110 minutes before the open rather
    // than 330.
    const sessionDate = etDateString(all[0]?.ms ?? Date.now());
    const openMs = etWallClock(sessionDate, 9, 30);
    const minutesFromOpen = (ms: number) => Math.round((ms - openMs) / 60_000);
    const mods = raw.map((p) => minutesFromOpen(p.ms));
    const regMods = regular.map((p) => minutesFromOpen(p.ms));
    // Candle size is chosen from the regular session only, so a handful of
    // thin pre-market prints cannot drive the whole day to a coarse interval.
    const auto = autoInterval(regMods, live && regMods.length ? Math.min(SESSION_MINUTES, Math.max(...regMods) + 1) : SESSION_MINUTES);
    const k: Interval = choice === "auto" ? auto.k : choice;

    // Merge 1-min bars into k-min candles: first open, max high, min low,
    // last close, summed volume/trades, volume-weighted VWAP (a vendor-garbage
    // bar vwap far outside its range falls back to the close).
    const groups = new Map<number, typeof raw>();
    raw.forEach((p, i) => {
      const b = Math.floor(mods[i] / k);
      (groups.get(b) ?? groups.set(b, []).get(b)!).push(p);
    });
    const pts = [...groups.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([b, arr]) => {
        let v = 0;
        let pv = 0;
        let n = 0;
        let hasN = false;
        for (const p of arr) {
          const bw = p.vw != null && p.vw >= p.l * 0.5 && p.vw <= p.h * 2 ? p.vw : p.c;
          v += p.v;
          pv += bw * p.v;
          if (p.n != null) {
            n += p.n;
            hasN = true;
          }
        }
        const last = arr[arr.length - 1];
        return {
          t: arr[0].t,
          ms: openMs + b * k * 60_000,
          ext: !isRegular(arr[0].ms),
          o: arr[0].o,
          h: Math.max(...arr.map((p) => p.h)),
          l: Math.min(...arr.map((p) => p.l)),
          c: last.c,
          v,
          vw: v > 0 ? pv / v : last.c,
          n: hasN ? n : null,
        };
      });
    const [d0, d1] = axis.domain;
    const plotW = width - LEFT - RIGHT;
    const sx = (u: number) => LEFT + ((u - d0) / (d1 - d0)) * plotW;
    // Every hour 4a-8p, plus the 9:30 open -- thinned so labels cannot
    // overlap. On the compressed axis 9:00a sits only half an extended hour
    // from 9:30a (~32px at full width, narrower than the "9:30a" label itself), so they ran
    // together. Greedy left-to-right with a minimum gap; 9:30 wins any
    // collision, being the open and the most useful label on this axis.
    const MIN_TICK_GAP_PX = 42;
    const toPx = (u: number) => ((u - d0) / (d1 - d0)) * plotW;
    const ticks: number[] = [];
    for (const u of [...axis.ticks, axis.open].sort((a, b) => a - b)) {
      const last = ticks[ticks.length - 1];
      if (last != null && toPx(u) - toPx(last) < MIN_TICK_GAP_PX) {
        if (u === axis.open) ticks.pop();
        else continue;
      }
      ticks.push(u);
    }
    const tickLabels: Record<number, string> = { ...axis.tickLabels, [axis.open]: "9:30a" };

    // Each bar covers [t, t+60s); centre it there and size it to the local
    // minute width (regular minutes are 3x wider than extended ones).
    const geo = pts.map((p) => {
      const x0 = sx(axis.toX(p.ms));
      const x1 = sx(axis.toX(p.ms + k * 60_000));
      return { cx: (x0 + x1) / 2, w: Math.max(1, (x1 - x0) * 0.7) };
    });

    const priceH = PRICE_H;
    const volH = VOL_H;
    const volBase = TOP + priceH + PANE_GAP + volH;

    let lo = Math.min(...pts.map((p) => p.l));
    let hi = Math.max(...pts.map((p) => p.h));
    if (prevClose != null) {
      lo = Math.min(lo, prevClose);
      hi = Math.max(hi, prevClose);
    }
    const pad = (hi - lo) * 0.05 || hi * 0.01 || 0.01;
    lo -= pad;
    hi += pad;
    const py = (p: number) => TOP + ((hi - p) / (hi - lo)) * priceH;
    // The typical day spread evenly over the 390-minute session, at this
    // candle size. Real intraday volume is U-shaped (heavy at the open and
    // close), so mid-day bars sitting under this line is normal; it's the
    // pace a flat day would run at. (Daily volume includes extended hours,
    // so this runs a few percent above a pure regular-session pace.)
    const avgPerCandle =
      typicalDailyVolume != null && typicalDailyVolume > 0 ? (typicalDailyVolume * k) / SESSION_MINUTES : null;
    // Keep the line on the pane even when every bar is below it.
    const maxV = Math.max(1, ...pts.map((p) => p.v), avgPerCandle != null ? avgPerCandle * 1.1 : 0);

    // Running session VWAP over the regular session. Bar vwap falls back to
    // the close; a vendor-garbage vwap far outside the bar's range is ignored.
    let pv = 0;
    let vol = 0;
    const vwap: (number | null)[] = pts.map((p) => {
      if (!isRegular(p.ms)) return null;
      const bw = p.vw != null && p.vw >= p.l * 0.5 && p.vw <= p.h * 2 ? p.vw : p.c;
      pv += bw * p.v;
      vol += p.v;
      return vol > 0 ? pv / vol : null;
    });

    const step = niceStep(hi - lo, 6);
    const yTicks: number[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) yTicks.push(v);

    // OHLC is the REGULAR session: the day's open is 9:30, not the first
    // pre-market print. Volume is the whole tape, with pre and post broken
    // out -- pre-market volume is the number a pre-open report wants.
    const preVolume = raw.filter((p) => axis.toX(p.ms) < axis.open).reduce((s, p) => s + p.v, 0);
    const postVolume = raw.filter((p) => axis.toX(p.ms) >= axis.close).reduce((s, p) => s + p.v, 0);
    const stats = {
      open: regular[0]?.o ?? null,
      high: regular.length ? Math.max(...regular.map((p) => p.h)) : null,
      low: regular.length ? Math.min(...regular.map((p) => p.l)) : null,
      close: regular.length ? regular[regular.length - 1].c : null,
      last: raw.length ? raw[raw.length - 1].c : null,
      // Volume and trades stay REGULAR-session: prevSession carries regular-
      // hours totals, so including extended here would compare a full day
      // against a prior regular session. Pre/post are shown beside them.
      volume: regular.reduce((s, p) => s + p.v, 0),
      preVolume,
      postVolume,
      trades: regular.reduce((s, p) => s + (p.n ?? 0), 0),
      minutesTraded: regular.length,
    };

    return { pts, k, auto, sx, ticks, tickLabels, geo, priceH, volH, volBase, py, maxV, vwap, yTicks, stats, lo, hi, avgPerCandle,
             d0, d1, axisOpen: axis.open, axisClose: axis.close };
  }, [bars, prevClose, width, choice, live, typicalDailyVolume]);

  if (!bars.length) return null;
  const { pts, k, auto, sx, ticks, tickLabels, geo, volH, volBase, py, maxV, vwap, yTicks, stats, avgPerCandle,
          axisOpen, axisClose } = m;
  if (!pts.length) {
    return <p className="empty-state chart-empty-state">No trades this day.</p>;
  }

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    let lo = 0;
    let hi = geo.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (geo[mid].cx < x) lo = mid + 1;
      else hi = mid;
    }
    const i = lo > 0 && Math.abs(geo[lo - 1].cx - x) < Math.abs(geo[lo].cx - x) ? lo - 1 : lo;
    setHover(i);
  };

  const vwapPath = vwap
    .map((v, i) => (v == null ? null : `${geo[i].cx.toFixed(1)},${py(v).toFixed(1)}`))
    .reduce<string[][]>((segs, pt) => {
      if (pt == null) segs.push([]);
      else segs[segs.length - 1].push(pt);
      return segs;
    }, [[]])
    .filter((s) => s.length > 1)
    .map((s) => `M${s.join("L")}`)
    .join("");

  const hp = hover != null ? pts[hover] : null;
  const change = (p: number | null) => (p != null && prevClose ? fmtPct(p / prevClose - 1) : "—");
  // "up" when this session's value beats the prior one, "down" when worse.
  const cmp = (a: number | null, b: number | null | undefined) =>
    a == null || b == null || a === b ? "" : a > b ? "up" : "down";
  const prevTitle = (v: string | null | false) =>
    v && prevSession
      ? `Prior session ${prevSession.date}${prevSession.through_minute < 390 ? ` (through the same time of day)` : ""}: ${v}`
      : undefined;

  const intervalPicker = (
    <select
      className="candle-interval"
      value={choice}
      onChange={(e) => {
        setHover(null);
        setChoice(e.target.value === "auto" ? "auto" : (Number(e.target.value) as Interval));
      }}
      title={`Candle size. Auto picks the finest interval where at least ${AUTO_MIN_COVERAGE * 100}% of slots traded and the session fits in ${AUTO_MAX_CANDLES} candles or fewer. Here: ${Math.round(auto.coverage * 100)}% of ${auto.k}-min slots traded.`}
      aria-label="Candle interval"
    >
      <option value="auto">Auto ({auto.k}m)</option>
      {INTERVALS.map((iv) => (
        <option key={iv} value={iv}>
          {iv}m
        </option>
      ))}
    </select>
  );

  return (
    <div className="candle-chart" ref={wrapRef}>
      {/* Candle size sits in the page's controls row, right of the range buttons. */}
      {controlsTarget ? createPortal(intervalPicker, controlsTarget) : intervalPicker}
      {portalStats(statsTarget,
      <div className="candle-stats">
        {/* Green = better than the prior session, red = worse: prices vs the
            prior close, activity vs the prior session (same time of day
            while this one is live). */}
        {/* Top to bottom: where it is now, how it got there, then activity. */}
        <span>{live ? "Last" : "Close"} <b className={cmp(stats.close, prevClose)}>{stats.close != null ? fmtPrice(stats.close) : "—"}</b></span>
        <span>Change <b className={cmp(stats.close, prevClose)}>{change(stats.close)}</b></span>
        <span>Open <b className={cmp(stats.open, prevClose)}>{stats.open != null ? fmtPrice(stats.open) : "—"}</b></span>
        <span>High <b className={cmp(stats.high, prevClose)}>{stats.high != null ? fmtPrice(stats.high) : "—"}</b></span>
        <span>Low <b className={cmp(stats.low, prevClose)}>{stats.low != null ? fmtPrice(stats.low) : "—"}</b></span>
        <span>Gap <b className={cmp(stats.open, prevClose)}>{change(stats.open)}</b></span>
        <span>Prev close <b>{prevClose != null ? fmtPrice(prevClose) : "—"}</b></span>
        <span title={prevTitle(prevSession && fmtVol(prevSession.volume))}>
          Volume <b className={cmp(stats.volume, prevSession?.volume)}>{fmtVol(stats.volume)}</b>
          {(stats.preVolume > 0 || stats.postVolume > 0) && (
            <em title="Extended-hours volume, not included in the regular-session figure beside it">
              {stats.preVolume > 0 ? ` pre ${fmtVol(stats.preVolume)}` : ""}
              {stats.postVolume > 0 ? ` post ${fmtVol(stats.postVolume)}` : ""}
            </em>
          )}
        </span>
        <span title={prevTitle(prevSession && prevSession.trades.toLocaleString())}>
          Trades <b className={cmp(stats.trades, prevSession?.trades)}>{stats.trades.toLocaleString()}</b>
        </span>
        <span title={prevTitle(prevSession && `${prevSession.minutes_traded}`)}>
          Minutes traded <b className={cmp(stats.minutesTraded, prevSession?.minutes_traded)}>{stats.minutesTraded}/390</b>
        </span>
      </div>)}
      <svg width={width} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img"
           aria-label="Session candlestick chart with volume">
        {/* extended-hours shading: 4:00-9:30a and 4:00-8:00p ET */}
        <rect x={sx(m.d0)} y={TOP} width={sx(axisOpen) - sx(m.d0)} height={volBase - TOP} className="cc-ext" />
        <rect x={sx(axisClose)} y={TOP} width={sx(m.d1) - sx(axisClose)} height={volBase - TOP} className="cc-ext" />

        {[axisOpen, axisClose].map((u) => (
          <line key={u} x1={sx(u)} x2={sx(u)} y1={TOP} y2={volBase} className="cc-divider" />
        ))}

        {yTicks.map((v) => (
          <g key={v}>
            <line x1={LEFT} x2={width - RIGHT} y1={py(v)} y2={py(v)} className="cc-grid" />
            <text x={width - RIGHT + 6} y={py(v) + 4} className="cc-label">{fmtPrice(v)}</text>
          </g>
        ))}

        {/* Value is in the legend below, not on the line. */}
        {prevClose != null && (
          <line x1={LEFT} x2={width - RIGHT} y1={py(prevClose)} y2={py(prevClose)} className="cc-prev" />
        )}

        {/* volume, bottom-aligned */}
        {pts.map((p, i) => {
          const h = Math.max(1, (p.v / maxV) * volH);
          return (
            <rect key={`v${p.ms}`} x={geo[i].cx - geo[i].w / 2} y={volBase - h} width={geo[i].w} height={h}
                  className={p.c >= p.o ? "cc-vol-up" : "cc-vol-down"} />
          );
        })}

        {/* one-month average volume, per candle */}
        {avgPerCandle != null && (
          <g>
            <line x1={LEFT} x2={width - RIGHT} y1={volBase - (avgPerCandle / maxV) * volH}
                  y2={volBase - (avgPerCandle / maxV) * volH} className="cc-vol-avg" />
            <text x={LEFT - 6} y={volBase - (avgPerCandle / maxV) * volH + 4} textAnchor="end" className="cc-label cc-vol-avg-label">
              {fmtVol(avgPerCandle)}
            </text>
          </g>
        )}

        {/* candles */}
        {pts.map((p, i) => {
          const up = p.c >= p.o;
          const top = py(Math.max(p.o, p.c));
          const bodyH = Math.max(1, Math.abs(py(p.o) - py(p.c)));
          return (
            <g key={`c${p.ms}`} className={up ? "cc-up" : "cc-down"}>
              <line x1={geo[i].cx} x2={geo[i].cx} y1={py(p.h)} y2={py(p.l)} />
              <rect x={geo[i].cx - geo[i].w / 2} y={top} width={geo[i].w} height={bodyH} />
            </g>
          );
        })}

        {vwapPath && <path d={vwapPath} className="cc-vwap" />}

        {ticks.map((u, i) => (
          <text key={u} x={m.sx(u)} y={height - 6} textAnchor={i === 0 ? "start" : "middle"} className="cc-label">{tickLabels[u]}</text>
        ))}
        {/* Volume scale on the LEFT, price on the right: two different units
            sharing one gutter made them easy to read as one axis. */}
        <text x={LEFT - 6} y={volBase - volH + 10} textAnchor="end" className="cc-label">{fmtVol(maxV)}</text>

        {hp && hover != null && (
          <g className="cc-cross">
            <line x1={geo[hover].cx} x2={geo[hover].cx} y1={TOP} y2={volBase} />
            <line x1={LEFT} x2={width - RIGHT} y1={py(hp.c)} y2={py(hp.c)} />
            <text x={width - RIGHT + 6} y={py(hp.c) + 4} className="cc-label cc-cross-label">{fmtPrice(hp.c)}</text>
          </g>
        )}
      </svg>
      <div className="candle-legend">
        <span className="cc-key cc-key-vwap">VWAP (regular session)</span>
        {avgPerCandle != null && (
          <span className="cc-key cc-key-vol-avg" title="Median daily volume over the prior 20 sessions, spread evenly across the 390-minute session at this candle size. The median, so one spike day can't inflate it.">
            typical volume per {k}-min, prior 20 regular sessions
          </span>
        )}
        {prevClose != null && <span className="cc-key cc-key-prev">prior close {fmtPrice(prevClose)}</span>}
        <span className="cc-key cc-key-ext">extended hours (compressed)</span>
      </div>
      {hp && hover != null && (
        <div className="candle-tip" style={{ left: Math.min(Math.max(geo[hover].cx + 12, 0), width - 190) }}>
          <div className="candle-tip-when">{etTimeLabel(hp.ms)}{k > 1 ? ` · ${k}-min` : ""}</div>
          <div>O {fmtPrice(hp.o)} · H {fmtPrice(hp.h)}</div>
          <div>L {fmtPrice(hp.l)} · C {fmtPrice(hp.c)}</div>
          <div>vs prev close {change(hp.c)}</div>
          <div>
            Vol {fmtVol(hp.v)}
            {/* `typical` is a REGULAR-session rate (a typical day spread over
                390 minutes), so on an extended-hours bar it is a cross-scale
                comparison and has to say so. Pre-market volume against a
                normal session minute is the number a pre-open read wants --
                worth keeping, not worth showing unlabelled. */}
            {avgPerCandle != null
              ? ` · ${(hp.v / avgPerCandle).toFixed(1)}× ${hp.ext ? "a regular-session " + k + "-min" : "typical"}`
              : ""}
            {hp.n != null ? ` · ${hp.n.toLocaleString()} trades` : ""}
          </div>
          {vwap[hover] != null && <div>VWAP {fmtPrice(vwap[hover]!)}</div>}
        </div>
      )}
    </div>
  );
}

/** Render the stats block into the page's snapshot column when one is provided. */
export function portalStats(target: HTMLElement | null, node: React.ReactNode) {
  return target ? createPortal(node, target) : node;
}
