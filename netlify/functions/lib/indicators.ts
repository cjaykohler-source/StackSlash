/**
 * Pure math for Tier-1 factor computation. No I/O — takes arrays of bars,
 * returns numbers. Called by eod-scan/intraday-scan after fetching bars,
 * and reusable directly from a future backtest script since it has no
 * dependency on Supabase or Alpaca.
 */

export interface Bar {
  date: string;
  close: number;
  volume: number;
}

export function pctReturn(bars: Bar[], lookback: number, skipRecent = 0): number | null {
  const n = bars.length;
  const endIdx = n - 1 - skipRecent;
  const startIdx = endIdx - lookback;
  if (startIdx < 0 || endIdx < 0 || endIdx >= n) return null;
  const start = bars[startIdx].close;
  const end = bars[endIdx].close;
  if (!start) return null;
  return end / start - 1;
}

export function sma(bars: Bar[], period: number): number | null {
  if (bars.length < period) return null;
  const slice = bars.slice(-period);
  return slice.reduce((sum, b) => sum + b.close, 0) / period;
}

export function ema(bars: Bar[], period: number): number | null {
  if (bars.length < period) return null;
  const k = 2 / (period + 1);
  let value = bars[bars.length - period].close;
  for (let i = bars.length - period + 1; i < bars.length; i++) {
    value = bars[i].close * k + value * (1 - k);
  }
  return value;
}

export function rsi(bars: Bar[], period: number): number | null {
  if (bars.length < period + 1) return null;
  const recent = bars.slice(-(period + 1));
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < recent.length; i++) {
    const change = recent[i].close - recent[i - 1].close;
    if (change >= 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function bollinger(
  bars: Bar[],
  period = 20,
  stdDevMultiplier = 2,
): { mid: number; upper: number; lower: number; pctB: number; width: number } | null {
  if (bars.length < period) return null;
  const slice = bars.slice(-period);
  const mid = slice.reduce((sum, b) => sum + b.close, 0) / period;
  const variance = slice.reduce((sum, b) => sum + (b.close - mid) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);
  const upper = mid + stdDevMultiplier * stdDev;
  const lower = mid - stdDevMultiplier * stdDev;
  const last = bars[bars.length - 1].close;
  const pctB = upper === lower ? 0.5 : (last - lower) / (upper - lower);
  const width = mid === 0 ? 0 : (upper - lower) / mid;
  return { mid, upper, lower, pctB, width };
}

export function realizedVol(bars: Bar[], period = 20): number | null {
  if (bars.length < period + 1) return null;
  const slice = bars.slice(-(period + 1));
  const rets: number[] = [];
  for (let i = 1; i < slice.length; i++) {
    rets.push(Math.log(slice[i].close / slice[i - 1].close));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance) * Math.sqrt(252); // annualized
}

export function avgDollarVolume(bars: Bar[], period = 20): number | null {
  if (bars.length < period) return null;
  const slice = bars.slice(-period);
  return slice.reduce((sum, b) => sum + b.close * b.volume, 0) / period;
}

/** Percentile rank of `value` within `all` (0-1), used for cross-sectional momentum ranking. */
export function percentileRank(all: number[], value: number): number {
  const sorted = [...all].sort((a, b) => a - b);
  const idx = sorted.findIndex((v) => v >= value);
  if (idx === -1) return 1;
  return idx / sorted.length;
}

/**
 * Where today's Bollinger Band width ranks (0-1) within its own recent
 * history — the "squeeze" a Volatility Squeeze Breakout trigger looks
 * for is bb_width sitting near the bottom of this distribution, then
 * breaking out. Recomputes bb_width for each day in the lookback window
 * (not just today) since that's the whole point: a percentile needs a
 * real historical distribution, not a single snapshot.
 */
export function bbWidthPercentile(bars: Bar[], lookbackDays = 126, bbPeriod = 20): number | null {
  if (bars.length < lookbackDays + bbPeriod) return null;
  const widths: number[] = [];
  for (let i = bars.length - lookbackDays; i < bars.length; i++) {
    // bollinger() only ever uses the trailing `bbPeriod` elements of
    // whatever's passed in — slicing just that window (not the whole
    // growing prefix up to i) turns this from O(lookbackDays * bars.length)
    // into O(lookbackDays * bbPeriod), which matters a lot once this gets
    // called against years of history (a backtest replaying every
    // historical day) rather than one ~400-day live fetch.
    const bb = bollinger(bars.slice(i + 1 - bbPeriod, i + 1), bbPeriod);
    if (bb) widths.push(bb.width);
  }
  if (widths.length === 0) return null;
  return percentileRank(widths, widths[widths.length - 1]);
}

/** Today's volume divided by the average volume of the `period` days before it (today excluded from the average, so a genuine spike isn't diluted by itself). */
export function volumeRatio(bars: Bar[], period = 20): number | null {
  if (bars.length < period + 1) return null;
  const today = bars[bars.length - 1].volume;
  const priorSlice = bars.slice(-(period + 1), -1);
  const avgPrior = priorSlice.reduce((sum, b) => sum + b.volume, 0) / period;
  if (avgPrior === 0) return null;
  return today / avgPrior;
}

/**
 * Whether today's close is a new high relative to the `period` days
 * before it. Uses closing price rather than intraday high/low — bars_daily
 * stores full OHLC, but the in-memory Bar type callers build only carries
 * close/volume today, and close-based is a common enough variant of
 * "N-day high" to not warrant plumbing high/low through everywhere yet.
 */
export function isNewCloseHigh(bars: Bar[], period = 20): boolean | null {
  if (bars.length < period + 1) return null;
  const today = bars[bars.length - 1].close;
  const priorSlice = bars.slice(-(period + 1), -1);
  const priorMax = Math.max(...priorSlice.map((b) => b.close));
  return today > priorMax;
}

/** EMA over a plain numeric series (e.g. a MACD line), same formula as ema() but not tied to Bar.close. */
function emaOfValues(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values[values.length - period];
  for (let i = values.length - period + 1; i < values.length; i++) {
    value = values[i] * k + value * (1 - k);
  }
  return value;
}

/**
 * Detects a MACD line / signal line cross as of the most recent bar:
 * 1 = bullish cross (histogram flipped negative-to-positive), -1 =
 * bearish cross, 0 = no cross, null = not enough history.
 *
 * The signal line needs its own EMA over a short history of the MACD
 * line itself (not a single point), and detecting a *cross* needs that
 * comparison for both today and yesterday — so this builds a short
 * rolling MACD-line series first, rather than computing one live value.
 */
export function macdCrossSignal(
  bars: Bar[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): -1 | 0 | 1 | null {
  const pointsNeeded = signalPeriod + 1; // need "today" and "yesterday" signal values
  if (bars.length < slowPeriod + pointsNeeded) return null;

  const macdSeries: number[] = [];
  for (let i = 0; i < pointsNeeded; i++) {
    const endIdx = bars.length - pointsNeeded + i + 1;
    const window = bars.slice(0, endIdx);
    const fast = ema(window, fastPeriod);
    const slow = ema(window, slowPeriod);
    if (fast === null || slow === null) return null;
    macdSeries.push(fast - slow);
  }

  const signalToday = emaOfValues(macdSeries, signalPeriod);
  const signalYesterday = emaOfValues(macdSeries.slice(0, -1), signalPeriod);
  if (signalToday === null || signalYesterday === null) return null;

  const histToday = macdSeries[macdSeries.length - 1] - signalToday;
  const histYesterday = macdSeries[macdSeries.length - 2] - signalYesterday;

  if (histYesterday <= 0 && histToday > 0) return 1;
  if (histYesterday >= 0 && histToday < 0) return -1;
  return 0;
}
