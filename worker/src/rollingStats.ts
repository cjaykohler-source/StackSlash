/**
 * Per-symbol EWMA mean/variance of tick-to-tick log returns, updated
 * incrementally on every trade — no stored history, O(1) per tick.
 *
 * This is the streaming analog of indicators.ts's realizedVol(): instead
 * of recomputing over a fixed window of stored bars, it exponentially
 * discounts older observations so "3 standard deviations" always means
 * "3 sigma relative to this symbol's *recent* volatility regime," per the
 * Black Swan paper's method (outliers defined relative to a rolling
 * mean ± 3×stddev, not a fixed threshold).
 */

interface SymbolStats {
  lastPrice: number | null;
  ewmaMean: number;
  ewmaVar: number;
  tickCount: number;
}

export class RollingOutlierDetector {
  private readonly alpha: number;
  private readonly minTicks: number;
  private readonly stats = new Map<string, SymbolStats>();

  constructor(alpha: number, minTicks: number) {
    this.alpha = alpha;
    this.minTicks = minTicks;
  }

  /**
   * Feed one trade price for a symbol. Returns a result only once enough
   * ticks have been observed to trust the stats; null during warm-up or
   * on the very first tick (no return to compute yet).
   */
  update(symbol: string, price: number): { zScore: number; ret: number; tickCount: number } | null {
    let s = this.stats.get(symbol);
    if (!s) {
      s = { lastPrice: price, ewmaMean: 0, ewmaVar: 0, tickCount: 0 };
      this.stats.set(symbol, s);
      return null;
    }

    if (s.lastPrice === null || s.lastPrice <= 0 || price <= 0) {
      s.lastPrice = price;
      return null;
    }

    const ret = Math.log(price / s.lastPrice);
    s.lastPrice = price;
    s.tickCount += 1;

    // Standard EWMA update for mean and variance (Welford-style delta,
    // exponentially weighted instead of a running average over all history).
    const delta = ret - s.ewmaMean;
    s.ewmaMean += this.alpha * delta;
    s.ewmaVar = (1 - this.alpha) * (s.ewmaVar + this.alpha * delta * delta);

    if (s.tickCount < this.minTicks) {
      return null;
    }

    const stdDev = Math.sqrt(s.ewmaVar);
    if (stdDev === 0) {
      return null;
    }

    const zScore = (ret - s.ewmaMean) / stdDev;
    return { zScore, ret, tickCount: s.tickCount };
  }
}
