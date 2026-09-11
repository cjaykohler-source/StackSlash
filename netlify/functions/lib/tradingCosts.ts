/**
 * Transaction costs — the thing every backtest and sim in this project
 * has silently assumed was zero.
 *
 * Why this matters more than any trigger: the best mean edge found
 * anywhere across a 1-day-to-6-month hold-duration sweep was +0.52%,
 * while the minimum *possible* round-trip spread on a $2.72 stock (the
 * median entry price in the band) is 0.37% before any real-world
 * widening. Every "edge" this project has reported was gross of a cost
 * of the same order of magnitude. A sim that fills at the close for free
 * is not modelling this strategy, it is modelling a different and easier
 * one.
 *
 * Two independent estimates are combined, and the wider wins:
 *
 * 1. **Tick floor.** Reg NMS Rule 612 sets the minimum price increment
 *    at $0.01 for stocks >= $1.00 and $0.0001 below that. A stock cannot
 *    have a spread tighter than one tick, so this is a hard lower bound
 *    that needs no data at all. At $2.72 it alone is 0.37%.
 *
 * 2. **Corwin-Schultz (2012) high-low estimator.** Backs an effective
 *    spread out of two-day high/low ranges — the insight being that the
 *    high is nearly always a buy at the ask and the low a sell at the
 *    bid, so the ratio carries the spread inside it. It needs only daily
 *    OHLC, which this project has for 5 years across ~5,000 symbols, so
 *    historical spreads can be *estimated per symbol* rather than
 *    assumed flat. Computed in SQL (see estimate_symbol_spreads()) and
 *    read from symbol_spread_estimates.
 *
 * Taking the max is deliberate. Corwin-Schultz is known to be noisy on
 * thin names and can return implausibly small (or negative, floored to
 * zero) values when a symbol barely trades and its high equals its low.
 * The tick floor catches exactly that case. Being wrong in the
 * conservative direction is the whole point here — this project's
 * recurring failure has been numbers that flattered themselves.
 */

/** Reg NMS Rule 612 minimum price increment. */
export function tickSize(price: number): number {
  return price >= 1 ? 0.01 : 0.0001;
}

/**
 * Hard lower bound on round-trip cost: you cross one tick getting in and
 * one getting out. Expressed as a fraction of notional.
 */
export function tickFloorRoundTripPct(price: number): number {
  if (!(price > 0)) return 0;
  return tickSize(price) / price;
}

/**
 * Corwin-Schultz effective spread from a single consecutive-day pair.
 * Returns a proportional spread (0.01 = 1%), floored at 0 — the
 * estimator legitimately produces negatives on low-volatility pairs and
 * the published treatment is to treat those as zero, then average.
 *
 * Returns null when the pair can't support an estimate (missing or
 * degenerate bars), so callers can skip rather than average in a fake 0.
 */
export function corwinSchultzPair(
  day1: { high: number; low: number },
  day2: { high: number; low: number },
): number | null {
  const { high: h1, low: l1 } = day1;
  const { high: h2, low: l2 } = day2;
  if (!(h1 > 0 && l1 > 0 && h2 > 0 && l2 > 0)) return null;
  if (h1 < l1 || h2 < l2) return null;

  const DENOM = 3 - 2 * Math.SQRT2;

  const beta = Math.log(h1 / l1) ** 2 + Math.log(h2 / l2) ** 2;
  const h2day = Math.max(h1, h2);
  const l2day = Math.min(l1, l2);
  const gamma = Math.log(h2day / l2day) ** 2;

  const alpha = (Math.sqrt(2 * beta) - Math.sqrt(beta)) / DENOM - Math.sqrt(gamma / DENOM);
  if (!Number.isFinite(alpha)) return null;

  const spread = (2 * (Math.exp(alpha) - 1)) / (1 + Math.exp(alpha));
  return spread > 0 ? spread : 0;
}

/**
 * The round-trip cost to apply to a simulated trade, as a fraction of
 * notional. `estimatedSpreadPct` is the per-symbol Corwin-Schultz figure
 * when one is available; without it the tick floor stands alone.
 *
 * A round trip crosses the spread once in and once out. Modelling a full
 * spread each way is the pessimistic read (you always pay); modelling
 * half each way assumes you routinely get filled at the midpoint, which
 * is not a safe assumption for a retail market order on a name trading
 * 50k dollars a day. `crossFraction` exposes that choice rather than
 * burying it — default 1.0, i.e. you cross.
 */
export function roundTripCostPct(
  price: number,
  estimatedSpreadPct: number | null,
  crossFraction = 1.0,
): number {
  const floor = tickFloorRoundTripPct(price);
  const estimated = estimatedSpreadPct != null && estimatedSpreadPct > 0 ? estimatedSpreadPct : 0;
  return Math.max(floor, estimated) * crossFraction;
}

/**
 * Net a gross return for round-trip cost. Kept as its own function so
 * gross and net can always be reported side by side — a modelled cost is
 * an assumption, and an assumption that silently replaces the raw number
 * is how you end up unable to tell which one you were looking at.
 */
export function netOfCosts(grossReturn: number, costPct: number): number {
  return grossReturn - costPct;
}
