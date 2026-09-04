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
