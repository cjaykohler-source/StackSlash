import {
  avgDollarVolume,
  bbWidthPercentile,
  bollinger,
  isNewCloseHigh,
  macdCrossSignal,
  pctReturn,
  percentileRank,
  realizedVol,
  rsi,
  sma,
  volumeRatio,
  type Bar,
} from "./indicators";

/**
 * Single source of truth for factor computation — the exact same logic
 * eod-scan.ts uses for "today," extracted so backtest-triggers.ts can
 * replay it against every historical day too. This matters beyond code
 * reuse: if the backtest computed factors even slightly differently than
 * the live path, its "here's how this trigger has historically
 * performed" numbers wouldn't actually describe what the live trigger
 * does, making them worse than useless — confidently wrong.
 */

export interface FactorFields {
  ret_1w: number | null;
  ret_1m: number | null;
  ret_6m: number | null;
  ret_12m_ex1m: number | null;
  realized_vol_20d: number | null;
  dollar_vol_20d: number | null;
  bb_pctb: number | null;
  bb_width: number | null;
  rsi14: number | null;
  rsi2: number | null;
  dist_sma200: number | null;
  bb_width_percentile_126d: number | null;
  volume_ratio_20d: number | null;
  roc_20d: number | null;
  is_20d_high: boolean | null;
  macd_cross: -1 | 0 | 1 | null;
  momentum_rank_pct: number | null;
  roc_20d_rank_pct: number | null;
  ret_1w_rank_pct: number | null;
}

export interface RegimeFields {
  above_200dma: boolean | null;
  vol_regime: "low" | "normal" | "high" | null;
  risk_on: boolean;
}

/**
 * Computes factor_state-equivalent fields for every symbol, "as of" the
 * last bar in each symbol's array — pass each symbol's full history for
 * live use (eod-scan), or a bars-up-to-day-D slice per symbol for a
 * backtest replaying day D.
 */
export function computeFactors(barsBySymbolId: Map<number, Bar[]>): Map<number, FactorFields> {
  const momentumBySymbol = new Map<number, number>();
  const rocBySymbol = new Map<number, number>();
  const ret1wBySymbol = new Map<number, number>();
  type PartialFields = Omit<FactorFields, "momentum_rank_pct" | "roc_20d_rank_pct" | "ret_1w_rank_pct">;
  const partial = new Map<number, PartialFields>();

  for (const [symbolId, bars] of barsBySymbolId.entries()) {
    if (bars.length < 30) continue;

    const ret1w = pctReturn(bars, 5);
    const ret1m = pctReturn(bars, 21);
    const ret6m = pctReturn(bars, 126);
    const ret12mEx1m = pctReturn(bars, 252 - 21, 21);
    const roc20d = pctReturn(bars, 20);
    const bb = bollinger(bars, 20);
    const sma200 = sma(bars, 200);
    const last = bars[bars.length - 1].close;

    if (ret12mEx1m !== null) momentumBySymbol.set(symbolId, ret12mEx1m);
    if (roc20d !== null) rocBySymbol.set(symbolId, roc20d);
    if (ret1w !== null) ret1wBySymbol.set(symbolId, ret1w);

    partial.set(symbolId, {
      ret_1w: ret1w,
      ret_1m: ret1m,
      ret_6m: ret6m,
      ret_12m_ex1m: ret12mEx1m,
      realized_vol_20d: realizedVol(bars, 20),
      dollar_vol_20d: avgDollarVolume(bars, 20),
      bb_pctb: bb?.pctB ?? null,
      bb_width: bb?.width ?? null,
      rsi14: rsi(bars, 14),
      rsi2: rsi(bars, 2),
      dist_sma200: sma200 ? last / sma200 - 1 : null,
      bb_width_percentile_126d: bbWidthPercentile(bars, 126, 20),
      volume_ratio_20d: volumeRatio(bars, 20),
      roc_20d: roc20d,
      is_20d_high: isNewCloseHigh(bars, 20),
      macd_cross: macdCrossSignal(bars, 12, 26, 9),
    });
  }

  const momentumValues = [...momentumBySymbol.values()];
  const rocValues = [...rocBySymbol.values()];
  const ret1wValues = [...ret1wBySymbol.values()];

  const result = new Map<number, FactorFields>();
  for (const [symbolId, fields] of partial.entries()) {
    const m = momentumBySymbol.get(symbolId);
    const r = rocBySymbol.get(symbolId);
    const w = ret1wBySymbol.get(symbolId);
    result.set(symbolId, {
      ...fields,
      momentum_rank_pct: m !== undefined ? percentileRank(momentumValues, m) : null,
      roc_20d_rank_pct: r !== undefined ? percentileRank(rocValues, r) : null,
      ret_1w_rank_pct: w !== undefined ? percentileRank(ret1wValues, w) : null,
    });
  }
  return result;
}

/** Regime signal off one index symbol's bars (SPY, live and in the backtest). */
export function computeRegime(indexBars: Bar[] | undefined): RegimeFields | null {
  if (!indexBars || indexBars.length < 200) return null;
  const sma200 = sma(indexBars, 200);
  const last = indexBars[indexBars.length - 1].close;
  const vol = realizedVol(indexBars, 20);
  const aboveSma = sma200 !== null ? last > sma200 : null;
  const volRegime = vol === null ? null : vol > 0.25 ? "high" : vol > 0.15 ? "normal" : "low";
  const riskOn = aboveSma === true && volRegime !== "high";
  return { above_200dma: aboveSma, vol_regime: volRegime, risk_on: riskOn };
}
