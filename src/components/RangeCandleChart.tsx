import { useEffect, useMemo, useRef, useState } from "react";
import { PRICE_H, VOL_H } from "./SessionCandleChart";

/** One split-adjusted SIP bar from the range-candles function. */
export interface RangeBar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
export type RangeTimeframe = "30Min" | "1Day" | "1Week" | "1Month";

export const TIMEFRAME_LABEL: Record<RangeTimeframe, string> = {
  "30Min": "30-min",
  "1Day": "daily",
  "1Week": "weekly",
  "1Month": "monthly",
};

interface Props {
  bars: RangeBar[];
  timeframe: RangeTimeframe;
}

const LEFT = 8;
const RIGHT = 68; // price labels
const TOP = 10;
const AXIS_H = 22;
const PANE_GAP = 10;
// Same pane heights as the Session chart, so switching ranges doesn't jump.
const HEIGHT = TOP + PRICE_H + PANE_GAP + VOL_H + AXIS_H;
const ET = "America/New_York";
// Auto scale switches to log when the range's high is this many times its
// low (a sub-$5 name over years can span 100x; linear flattens it).
const AUTO_LOG_RATIO = 8;

const fmtPrice = (p: number) => (p < 1 ? p.toFixed(4) : p.toFixed(2));
const fmtVol = (v: number) =>
  v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : `${v}`;
const fmtPct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;

// Daily/weekly/monthly bars are stamped midnight ET, so their UTC date is
// the trading date; 30-min bars need ET for the time of day.
function whenLabel(ms: number, tf: RangeTimeframe): string {
  const d = new Date(ms);
  switch (tf) {
    case "30Min":
      return d.toLocaleString([], { timeZone: ET, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    case "1Day":
      return d.toLocaleDateString([], { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });
    case "1Week":
      return `Week of ${d.toLocaleDateString([], { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" })}`;
    case "1Month":
      return d.toLocaleDateString([], { timeZone: "UTC", month: "long", year: "numeric" });
  }
}

type TickKind = "day" | "month" | "year" | "even";

/** X-axis ticks at calendar boundaries (new day / month / year), thinned to fit. */
function xTicks(ms: number[], tf: RangeTimeframe): { i: number; label: string }[] {
  const n = ms.length;
  const kind: TickKind =
    tf === "30Min" ? "day" : tf === "1Month" ? "year" : tf === "1Week" ? (n > 120 ? "year" : "month") : n > 60 ? "month" : "even";
  const key = (t: number) => {
    const d = new Date(t);
    if (kind === "day") return d.toLocaleDateString("en-CA", { timeZone: ET });
    if (kind === "month") return `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    return `${d.getUTCFullYear()}`;
  };
  const label = (t: number) => {
    const d = new Date(t);
    if (kind === "day") return d.toLocaleDateString([], { timeZone: ET, weekday: "short", month: "numeric", day: "numeric" });
    if (kind === "month") {
      const m = d.toLocaleDateString([], { timeZone: "UTC", month: "short" });
      return d.getUTCMonth() === 0 ? `${m} '${String(d.getUTCFullYear()).slice(2)}` : m;
    }
    if (kind === "year") return `${d.getUTCFullYear()}`;
    return d.toLocaleDateString([], { timeZone: "UTC", month: "short", day: "numeric" });
  };

  let idx: number[] = [];
  if (kind === "even") {
    const step = Math.max(1, Math.ceil(n / 6));
    for (let i = 0; i < n; i += step) idx.push(i);
  } else {
    for (let i = 1; i < n; i++) if (key(ms[i]) !== key(ms[i - 1])) idx.push(i);
    // Label the first (partial) period too, unless it would crowd the next tick.
    if (n && (idx.length === 0 || idx[0] >= n / 12)) idx.unshift(0);
    if (idx.length > 10) {
      const step = Math.ceil(idx.length / 10);
      idx = idx.filter((_, j) => j % step === 0);
    }
  }
  return idx.map((i) => ({ i, label: label(ms[i]) }));
}

function niceStep(span: number, target: number): number {
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
}

/**
 * Candles + bottom-aligned volume for a multi-day range (Week through
 * Since 2016). Candles sit on an index axis — one slot per bar — so
 * nights, weekends and holidays leave no gaps. Linear or log price scale;
 * Auto goes log when the range spans AUTO_LOG_RATIO x or more.
 */
export function RangeCandleChart({ bars, timeframe }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [hover, setHover] = useState<number | null>(null);
  const [scale, setScale] = useState<"auto" | "linear" | "log">("auto");

  useEffect(() => setHover(null), [bars]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(320, Math.floor(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const m = useMemo(() => {
    const pts = bars.map((b) => ({ ...b, ms: Date.parse(b.t) })).sort((a, b) => a.ms - b.ms);
    const n = pts.length;
    const plotW = width - LEFT - RIGHT;
    const slot = plotW / Math.max(1, n);
    const cx = (i: number) => LEFT + (i + 0.5) * slot;
    const bodyW = Math.max(1, slot * 0.7);

    const lo0 = Math.min(...pts.map((p) => p.l));
    const hi0 = Math.max(...pts.map((p) => p.h));
    const autoLog = lo0 > 0 && hi0 / lo0 >= AUTO_LOG_RATIO;
    const log = (scale === "auto" ? autoLog : scale === "log") && lo0 > 0;

    let lo = lo0;
    let hi = hi0;
    let py: (p: number) => number;
    if (log) {
      const padF = (hi / lo) ** 0.05;
      lo /= padF;
      hi *= padF;
      const L = Math.log(lo);
      const H = Math.log(hi);
      py = (p) => TOP + ((H - Math.log(p)) / (H - L)) * PRICE_H;
    } else {
      const pad = (hi - lo) * 0.05 || hi * 0.01 || 0.01;
      lo -= pad;
      hi += pad;
      py = (p) => TOP + ((hi - p) / (hi - lo)) * PRICE_H;
    }

    // Y ticks: 1-2-5 per decade on a log scale (thinned to 1 per decade if
    // crowded), even steps otherwise or when a log range is too narrow.
    let yTicks: number[] = [];
    if (log) {
      for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
        for (const f of [1, 2, 5]) {
          const v = f * 10 ** e;
          if (v >= lo && v <= hi) yTicks.push(v);
        }
      }
      if (yTicks.length > 9) yTicks = yTicks.filter((v) => Math.abs(Math.log10(v) - Math.round(Math.log10(v))) < 1e-9);
    }
    if (yTicks.length < 3) {
      yTicks = [];
      const step = niceStep(hi - lo, 6);
      for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) if (v > 0 || !log) yTicks.push(v);
    }

    const volBase = TOP + PRICE_H + PANE_GAP + VOL_H;
    const maxV = Math.max(1, ...pts.map((p) => p.v));
    const ticks = xTicks(
      pts.map((p) => p.ms),
      timeframe,
    );

    const first = pts[0];
    const last = pts[n - 1];
    const stats = {
      open: first?.o ?? null,
      high: n ? hi0 : null,
      low: n ? lo0 : null,
      close: last?.c ?? null,
      change: first && last && first.o ? last.c / first.o - 1 : null,
      volume: pts.reduce((s, p) => s + p.v, 0),
    };
    return { pts, n, slot, cx, bodyW, py, yTicks, volBase, maxV, ticks, stats, log, autoLog };
  }, [bars, timeframe, width, scale]);

  if (!m.n) return null;
  const { pts, cx, bodyW, py, yTicks, volBase, maxV, ticks, stats, log, autoLog } = m;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    setHover(Math.min(m.n - 1, Math.max(0, Math.floor((x - LEFT) / m.slot))));
  };
  const hp = hover != null ? pts[hover] : null;
  const prevClose = hover != null && hover > 0 ? pts[hover - 1].c : null;

  return (
    <div className="candle-chart" ref={wrapRef}>
      <div className="candle-stats">
        <select
          className="candle-interval"
          value={scale}
          onChange={(e) => setScale(e.target.value as "auto" | "linear" | "log")}
          title={`Auto uses a log scale when the range's high is ${AUTO_LOG_RATIO}x its low or more.`}
          aria-label="Price scale"
        >
          <option value="auto">Auto ({autoLog ? "log" : "linear"})</option>
          <option value="linear">Linear</option>
          <option value="log">Log</option>
        </select>
        <span>Open <b>{stats.open != null ? fmtPrice(stats.open) : "—"}</b></span>
        <span>High <b>{stats.high != null ? fmtPrice(stats.high) : "—"}</b></span>
        <span>Low <b>{stats.low != null ? fmtPrice(stats.low) : "—"}</b></span>
        <span>Close <b>{stats.close != null ? fmtPrice(stats.close) : "—"}</b></span>
        <span>Change <b>{stats.change != null ? fmtPct(stats.change) : "—"}</b></span>
        <span>Volume <b>{fmtVol(stats.volume)}</b></span>
        <span>{m.n.toLocaleString()} {TIMEFRAME_LABEL[timeframe]} candles</span>
      </div>
      <svg width={width} height={HEIGHT} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img"
           aria-label={`${TIMEFRAME_LABEL[timeframe]} candlestick chart with volume`}>
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={LEFT} x2={width - RIGHT} y1={py(v)} y2={py(v)} className="cc-grid" />
            <text x={width - RIGHT + 6} y={py(v) + 4} className="cc-label">{fmtPrice(v)}</text>
          </g>
        ))}

        {pts.map((p, i) => {
          const h = Math.max(1, (p.v / maxV) * VOL_H);
          return (
            <rect key={`v${p.ms}`} x={cx(i) - bodyW / 2} y={volBase - h} width={bodyW} height={h}
                  className={p.c >= p.o ? "cc-vol-up" : "cc-vol-down"} />
          );
        })}

        {pts.map((p, i) => {
          const top = py(Math.max(p.o, p.c));
          const bodyH = Math.max(1, Math.abs(py(p.o) - py(p.c)));
          return (
            <g key={`c${p.ms}`} className={p.c >= p.o ? "cc-up" : "cc-down"}>
              <line x1={cx(i)} x2={cx(i)} y1={py(p.h)} y2={py(p.l)} />
              <rect x={cx(i) - bodyW / 2} y={top} width={bodyW} height={bodyH} />
            </g>
          );
        })}

        {ticks.map(({ i, label }) => (
          <text key={i} x={cx(i)} y={HEIGHT - 6} textAnchor="middle" className="cc-label">{label}</text>
        ))}
        <text x={width - RIGHT + 6} y={volBase - VOL_H + 10} className="cc-label">{fmtVol(maxV)}</text>

        {hp && hover != null && (
          <g className="cc-cross">
            <line x1={cx(hover)} x2={cx(hover)} y1={TOP} y2={volBase} />
            <line x1={LEFT} x2={width - RIGHT} y1={py(hp.c)} y2={py(hp.c)} />
            <text x={width - RIGHT + 6} y={py(hp.c) + 4} className="cc-label cc-cross-label">{fmtPrice(hp.c)}</text>
          </g>
        )}
      </svg>
      <div className="candle-legend">
        <span className="cc-legend-note">
          SIP, split-adjusted · {log ? "log" : "linear"} scale
          {timeframe === "30Min" ? " · regular session 9:30a–4:00p ET" : ""}
        </span>
      </div>
      {hp && hover != null && (
        <div className="candle-tip" style={{ left: Math.min(Math.max(cx(hover) + 12, 0), width - 190) }}>
          <div className="candle-tip-when">{whenLabel(hp.ms, timeframe)}</div>
          <div>O {fmtPrice(hp.o)} · H {fmtPrice(hp.h)}</div>
          <div>L {fmtPrice(hp.l)} · C {fmtPrice(hp.c)}</div>
          {prevClose != null && <div>vs prior candle {fmtPct(hp.c / prevClose - 1)}</div>}
          <div>Vol {fmtVol(hp.v)}</div>
        </div>
      )}
    </div>
  );
}
