/**
 * Pure intraday factor math — the session-shape signals a quick-flip
 * strategy actually keys off, computed from bars_intraday (per-minute
 * close + volume). No I/O; the mirror of indicators.ts for the intraday
 * timeframe, so intraday-scan and a future backtest evaluate the same way.
 *
 * The caller supplies:
 *  - `bars`         this session's 1-min bars, chronological, REGULAR
 *                   SESSION ONLY (09:30–16:00 ET) — pre/post-market bars
 *                   distort VWAP and the opening range.
 *  - `priorClose`   the prior regular session's close (for the gap).
 *  - `minuteVolume` trailing-average volume *in* each regular-session
 *                   minute, index 0 = 09:30–09:31 … 389 = 15:59–16:00.
 *                   Used for a time-of-day-aware RVOL. Optional.
 *  - `atr20`        average daily (high−low) over the last 20 sessions,
 *                   for range_expansion. Optional.
 *  - `openTs`       epoch-ms of 09:30 ET on the session date, so a bar's
 *                   minute-of-session is (ts − openTs) / 60000.
 */

export interface IntradayBar {
  ts: number; // epoch ms
  price: number; // 1-min bar close
  volume: number;
}

export interface IntradayFactorInput {
  bars: IntradayBar[];
  priorClose: number | null;
  openTs: number;
  minuteVolume?: number[] | null;
  atr20?: number | null;
}

export interface IntradayFactors {
  session_bars: number;
  session_open: number | null;
  last_price: number | null;
  session_high: number | null;
  session_low: number | null;
  gap_pct: number | null; // session open vs prior close
  session_return: number | null; // last vs session open
  vwap: number | null;
  dist_vwap: number | null; // (last − vwap) / vwap
  rvol: number | null; // cumulative session volume ÷ trailing-avg cumulative for this minute
  cum_volume: number;
  or_high: number | null; // opening-range (first OPENING_RANGE_MIN minutes) high
  or_low: number | null;
  or_break: -1 | 0 | 1 | null; // last vs the opening range
  pct_off_hod: number | null; // (last − high) / high, ≤ 0
  pct_off_lod: number | null; // (last − low) / low, ≥ 0
  range_expansion: number | null; // session (high − low) ÷ atr20
  higher_lows: boolean | null; // rising lows across the session's thirds
}

const OPENING_RANGE_MIN = 15;

export function intradayFactors(input: IntradayFactorInput): IntradayFactors {
  const { bars, priorClose, openTs, minuteVolume, atr20 } = input;
  const n = bars.length;

  const empty: IntradayFactors = {
    session_bars: n,
    session_open: null,
    last_price: null,
    session_high: null,
    session_low: null,
    gap_pct: null,
    session_return: null,
    vwap: null,
    dist_vwap: null,
    rvol: null,
    cum_volume: 0,
    or_high: null,
    or_low: null,
    or_break: null,
    pct_off_hod: null,
    pct_off_lod: null,
    range_expansion: null,
    higher_lows: null,
  };
  if (n === 0) return empty;

  const open = bars[0].price;
  const last = bars[n - 1].price;
  let hi = -Infinity;
  let lo = Infinity;
  let pv = 0; // sum price*volume
  let vol = 0; // sum volume
  let orHi = -Infinity;
  let orLo = Infinity;

  for (const b of bars) {
    if (b.price > hi) hi = b.price;
    if (b.price < lo) lo = b.price;
    pv += b.price * b.volume;
    vol += b.volume;
    const minute = (b.ts - openTs) / 60_000;
    if (minute >= 0 && minute < OPENING_RANGE_MIN) {
      if (b.price > orHi) orHi = b.price;
      if (b.price < orLo) orLo = b.price;
    }
  }

  const vwap = vol > 0 ? pv / vol : null;
  const orHigh = orHi === -Infinity ? null : orHi;
  const orLow = orLo === Infinity ? null : orLo;

  // Time-of-day RVOL: cumulative session volume vs the trailing-average
  // cumulative volume through the same minute of the session.
  let rvol: number | null = null;
  if (minuteVolume && minuteVolume.length) {
    const lastMinute = Math.min(
      minuteVolume.length - 1,
      Math.max(0, Math.floor((bars[n - 1].ts - openTs) / 60_000)),
    );
    let expectedCum = 0;
    for (let m = 0; m <= lastMinute; m++) expectedCum += minuteVolume[m] ?? 0;
    if (expectedCum > 0) rvol = vol / expectedCum;
  }

  let orBreak: -1 | 0 | 1 | null = null;
  if (orHigh != null && orLow != null) {
    orBreak = last > orHigh ? 1 : last < orLow ? -1 : 0;
  }

  return {
    session_bars: n,
    session_open: open,
    last_price: last,
    session_high: hi,
    session_low: lo,
    gap_pct: priorClose && priorClose > 0 ? open / priorClose - 1 : null,
    session_return: open > 0 ? last / open - 1 : null,
    vwap,
    dist_vwap: vwap && vwap > 0 ? last / vwap - 1 : null,
    rvol,
    cum_volume: vol,
    or_high: orHigh,
    or_low: orLow,
    or_break: orBreak,
    pct_off_hod: hi > 0 ? last / hi - 1 : null,
    pct_off_lod: lo > 0 ? last / lo - 1 : null,
    range_expansion: atr20 && atr20 > 0 ? (hi - lo) / atr20 : null,
    higher_lows: risingLows(bars),
  };
}

/** Crude market structure: split the session into thirds by count and
 *  check the minimum of each third is strictly rising. Null if too few bars. */
function risingLows(bars: IntradayBar[]): boolean | null {
  if (bars.length < 18) return null;
  const third = Math.floor(bars.length / 3);
  const lowOf = (from: number, to: number) => {
    let m = Infinity;
    for (let i = from; i < to; i++) if (bars[i].price < m) m = bars[i].price;
    return m;
  };
  const l1 = lowOf(0, third);
  const l2 = lowOf(third, third * 2);
  const l3 = lowOf(third * 2, bars.length);
  return l1 < l2 && l2 < l3;
}
