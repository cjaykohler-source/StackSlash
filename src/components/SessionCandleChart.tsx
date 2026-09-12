import { useEffect, useMemo, useRef, useState } from "react";
import { etTimeLabel, sessionAxis } from "../lib/marketTime";

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

interface Props {
  bars: Candle[];
  prevClose: number | null;
  height?: number;
}

const LEFT = 8;
const RIGHT = 68; // price labels
const TOP = 10;
const AXIS_H = 22;
const PANE_GAP = 10;
const PRICE_SHARE = 0.74; // of the plot height; the rest is volume

const fmtPrice = (p: number) => (p < 1 ? p.toFixed(4) : p.toFixed(2));
const fmtVol = (v: number) =>
  v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : `${v}`;
const fmtPct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;

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
 * beneath, the session VWAP (regular hours), the prior close, and shading
 * over pre-market and after-hours. Hover for a crosshair with the bar's
 * OHLC, volume, trades and running VWAP.
 *
 * Plain SVG rather than recharts: recharts has no candlestick, and a
 * session is at most ~960 bars, so direct drawing stays light.
 */
export function SessionCandleChart({ bars, prevClose, height = 480 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(320, Math.floor(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const m = useMemo(() => {
    const pts = bars.map((b) => ({ ...b, ms: Date.parse(b.t) })).sort((a, b) => a.ms - b.ms);
    const axis = sessionAxis(pts[0]?.ms ?? Date.now());
    const [d0, d1] = axis.domain;
    const plotW = width - LEFT - RIGHT;
    const sx = (u: number) => LEFT + ((u - d0) / (d1 - d0)) * plotW;
    const isRegular = (ms: number) => {
      const u = axis.toX(ms);
      return u >= axis.open && u < axis.close;
    };

    // Each bar covers [t, t+60s); centre it there and size it to the local
    // minute width (regular minutes are 3x wider than extended ones).
    const geo = pts.map((p) => {
      const x0 = sx(axis.toX(p.ms));
      const x1 = sx(axis.toX(p.ms + 60_000));
      return { cx: (x0 + x1) / 2, w: Math.max(1, (x1 - x0) * 0.7) };
    });

    const plotH = height - TOP - AXIS_H - PANE_GAP;
    const priceH = plotH * PRICE_SHARE;
    const volH = plotH - priceH;
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
    const maxV = Math.max(1, ...pts.map((p) => p.v));

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

    const reg = pts.filter((p) => isRegular(p.ms));
    const stats = {
      open: reg[0]?.o ?? null,
      high: reg.length ? Math.max(...reg.map((p) => p.h)) : null,
      low: reg.length ? Math.min(...reg.map((p) => p.l)) : null,
      close: reg.length ? reg[reg.length - 1].c : null,
      last: pts.length ? pts[pts.length - 1].c : null,
      volume: pts.reduce((s, p) => s + p.v, 0),
      regVolume: reg.reduce((s, p) => s + p.v, 0),
      preVolume: pts.filter((p) => axis.toX(p.ms) < axis.open).reduce((s, p) => s + p.v, 0),
      trades: pts.reduce((s, p) => s + (p.n ?? 0), 0),
      minutesTraded: reg.length,
    };

    return { pts, axis, sx, geo, priceH, volH, volBase, py, maxV, vwap, yTicks, stats, lo, hi };
  }, [bars, prevClose, width, height]);

  if (!bars.length) return null;
  const { pts, axis, sx, geo, volH, volBase, py, maxV, vwap, yTicks, stats } = m;

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

  return (
    <div className="candle-chart" ref={wrapRef}>
      <div className="candle-stats">
        <span>Open <b>{stats.open != null ? fmtPrice(stats.open) : "—"}</b></span>
        <span>High <b>{stats.high != null ? fmtPrice(stats.high) : "—"}</b></span>
        <span>Low <b>{stats.low != null ? fmtPrice(stats.low) : "—"}</b></span>
        <span>Close <b>{stats.close != null ? fmtPrice(stats.close) : "—"}</b> <em>{change(stats.close)}</em></span>
        <span>Gap <b>{change(stats.open)}</b></span>
        <span>Volume <b>{fmtVol(stats.volume)}</b> <em>pre {fmtVol(stats.preVolume)}</em></span>
        <span>Trades <b>{stats.trades.toLocaleString()}</b></span>
        <span>Minutes traded <b>{stats.minutesTraded}/390</b></span>
      </div>
      <svg width={width} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img"
           aria-label="Session candlestick chart with volume">
        {/* extended-hours shading */}
        <rect x={sx(axis.domain[0])} y={TOP} width={sx(axis.open) - sx(axis.domain[0])} height={volBase - TOP} className="cc-ext" />
        <rect x={sx(axis.close)} y={TOP} width={sx(axis.domain[1]) - sx(axis.close)} height={volBase - TOP} className="cc-ext" />

        {yTicks.map((v) => (
          <g key={v}>
            <line x1={LEFT} x2={width - RIGHT} y1={py(v)} y2={py(v)} className="cc-grid" />
            <text x={width - RIGHT + 6} y={py(v) + 4} className="cc-label">{fmtPrice(v)}</text>
          </g>
        ))}

        {[axis.open, axis.close].map((u) => (
          <line key={u} x1={sx(u)} x2={sx(u)} y1={TOP} y2={volBase} className="cc-divider" />
        ))}

        {prevClose != null && (
          <g>
            <line x1={LEFT} x2={width - RIGHT} y1={py(prevClose)} y2={py(prevClose)} className="cc-prev" />
            <text x={LEFT + 4} y={py(prevClose) - 4} className="cc-label cc-prev-label">prev close {fmtPrice(prevClose)}</text>
          </g>
        )}

        {/* volume, bottom-aligned */}
        {pts.map((p, i) => {
          const h = Math.max(1, (p.v / maxV) * volH);
          return (
            <rect key={`v${p.ms}`} x={geo[i].cx - geo[i].w / 2} y={volBase - h} width={geo[i].w} height={h}
                  className={p.c >= p.o ? "cc-vol-up" : "cc-vol-down"} />
          );
        })}

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

        {axis.ticks.map((u) => (
          <text key={u} x={sx(u)} y={height - 6} textAnchor="middle" className="cc-label">{axis.tickLabels[u]}</text>
        ))}
        <text x={width - RIGHT + 6} y={volBase - volH + 10} className="cc-label">{fmtVol(maxV)}</text>

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
        <span className="cc-key cc-key-prev">prior close</span>
        <span className="cc-key cc-key-ext">extended hours (compressed)</span>
      </div>
      {hp && hover != null && (
        <div className="candle-tip" style={{ left: Math.min(Math.max(geo[hover].cx + 12, 0), width - 190) }}>
          <div className="candle-tip-when">{etTimeLabel(hp.ms)}</div>
          <div>O {fmtPrice(hp.o)} · H {fmtPrice(hp.h)}</div>
          <div>L {fmtPrice(hp.l)} · C {fmtPrice(hp.c)}</div>
          <div>vs prev close {change(hp.c)}</div>
          <div>Vol {fmtVol(hp.v)}{hp.n != null ? ` · ${hp.n.toLocaleString()} trades` : ""}</div>
          {vwap[hover] != null && <div>VWAP {fmtPrice(vwap[hover]!)}</div>}
        </div>
      )}
    </div>
  );
}
