/**
 * Field catalogue for the Isolator screener.
 *
 * Two scopes:
 *  - `snapshot` — the most recent `factor_state` row for a symbol (the
 *    current value of a factor). Deep history isn't needed — it's "right
 *    now".
 *  - `window` — a trailing-window aggregate from `factor_window_stats`,
 *    recomputed nightly from `bars_daily` over the chosen lookback
 *    (20 or 40 sessions). This is where "over the past N sessions…" lives.
 *
 * `screen_symbols(spec)` in Postgres interprets these; keep the `key`s in
 * sync with its column / metric names.
 */

export type Scope = "snapshot" | "window";
export type Unit = "pct" | "ratio" | "num" | "usd" | "price" | "score";

export interface ScreenField {
  key: string;
  label: string;
  group: string;
  unit: Unit;
  help: string;
}

export const WINDOW_CHOICES = [20, 40] as const;
export type WindowLen = (typeof WINDOW_CHOICES)[number];

export const OPERATORS: { key: string; label: string; args: 1 | 2 }[] = [
  { key: "gte", label: "≥", args: 1 },
  { key: "lte", label: "≤", args: 1 },
  { key: "gt", label: ">", args: 1 },
  { key: "lt", label: "<", args: 1 },
  { key: "between", label: "between", args: 2 },
  { key: "eq", label: "=", args: 1 },
];

/** Trailing-window metrics (factor_window_stats.metric). */
export const WINDOW_FIELDS: ScreenField[] = [
  { key: "return", label: "Window return", group: "Trend", unit: "pct", help: "Last close vs the close at the start of the window." },
  { key: "return_vs_avg", label: "Price vs window avg", group: "Trend", unit: "pct", help: "Last close relative to the average close over the window. Near 0 = trading around its own mean." },
  { key: "price_slope", label: "Price trend (slope)", group: "Trend", unit: "num", help: "Per-session linear slope of close, normalised by average price. Positive = drifting up." },
  { key: "up_day_pct", label: "Up-day share", group: "Trend", unit: "ratio", help: "Fraction of sessions in the window that closed green." },
  { key: "rsi_avg", label: "Avg RSI(14)", group: "Trend", unit: "score", help: "Mean 14-day RSI across the window (Cutler's, SMA-based)." },
  { key: "rsi_now", label: "RSI(14) now", group: "Trend", unit: "score", help: "Most recent session's 14-day RSI." },

  { key: "realized_vol", label: "Realized vol (annualised)", group: "Volatility", unit: "pct", help: "Stdev of daily log returns over the window, annualised." },
  { key: "bb_width_avg", label: "Avg Bollinger width", group: "Volatility", unit: "ratio", help: "Mean of the daily 20-day Bollinger band width (band span ÷ midline) across the window. Low = a squeeze." },
  { key: "bb_width_now", label: "Bollinger width now", group: "Volatility", unit: "ratio", help: "Most recent session's 20-day Bollinger band width." },
  { key: "bb_width_delta", label: "Bollinger width change", group: "Volatility", unit: "ratio", help: "Signed change in band width from the start of the window to now. Negative = bands narrowing." },
  { key: "max_up_day", label: "Biggest up day", group: "Volatility", unit: "pct", help: "Largest single-session log return in the window." },
  { key: "max_down_day", label: "Biggest down day", group: "Volatility", unit: "pct", help: "Most negative single-session log return in the window." },

  { key: "dollar_vol_avg", label: "Avg $ volume", group: "Volume", unit: "usd", help: "Mean daily close×volume over the window — a liquidity floor." },
  { key: "volume_delta", label: "Volume high/low spread", group: "Volume", unit: "ratio", help: "(max volume − min volume) ÷ average volume over the window. High = volume is spiky." },
  { key: "volume_slope", label: "Volume trend (slope)", group: "Volume", unit: "num", help: "Per-session slope of volume, normalised by average volume. Positive = volume building." },

  { key: "range_pos", label: "Position in range", group: "Price position", unit: "ratio", help: "Where the last close sits between the window's low and high. 0 = at the low, 1 = at the high." },
  { key: "dist_from_high", label: "Distance from window high", group: "Price position", unit: "pct", help: "Last close vs the highest high in the window. 0 = making new highs." },
  { key: "dist_from_low", label: "Distance from window low", group: "Price position", unit: "pct", help: "Last close vs the lowest low in the window." },
];

/** Current-snapshot factor fields (latest factor_state row). */
export const SNAPSHOT_FIELDS: ScreenField[] = [
  { key: "last_close", label: "Price", group: "Basics", unit: "price", help: "Most recent close." },
  { key: "dollar_vol_20d", label: "20-day $ volume", group: "Basics", unit: "usd", help: "Average daily dollar volume — liquidity proxy." },

  { key: "momentum_rank_pct", label: "Momentum rank", group: "Momentum", unit: "ratio", help: "Cross-sectional percentile of 12-1 month momentum (1 = strongest in the universe)." },
  { key: "roc_20d", label: "20-day rate of change", group: "Momentum", unit: "pct", help: "Trailing 20-session price change." },
  { key: "roc_20d_rank_pct", label: "20-day ROC rank", group: "Momentum", unit: "ratio", help: "Cross-sectional percentile of the 20-day rate of change." },
  { key: "ret_1w", label: "1-week return", group: "Momentum", unit: "pct", help: "Trailing 5 sessions." },
  { key: "ret_1m", label: "1-month return", group: "Momentum", unit: "pct", help: "Trailing ~21 sessions." },
  { key: "ret_6m", label: "6-month return", group: "Momentum", unit: "pct", help: "Trailing ~126 sessions." },
  { key: "ret_12m_ex1m", label: "12-1 month momentum", group: "Momentum", unit: "pct", help: "Trailing 12 months excluding the most recent month." },

  { key: "rsi14", label: "RSI(14)", group: "Mean reversion", unit: "score", help: "14-day Relative Strength Index. <30 oversold, >70 overbought." },
  { key: "rsi2", label: "RSI(2)", group: "Mean reversion", unit: "score", help: "2-day RSI — fast, noisy, catches short-term extremes." },
  { key: "bb_pctb", label: "Bollinger %B", group: "Mean reversion", unit: "ratio", help: "Position within the Bollinger bands. 0 = lower band, 1 = upper band." },
  { key: "dist_ema20", label: "Distance from 20-day EMA", group: "Mean reversion", unit: "pct", help: "Price vs its 20-day exponential moving average." },
  { key: "dist_sma200", label: "Distance from 200-day SMA", group: "Mean reversion", unit: "pct", help: "Price vs its 200-day simple moving average. Positive = long-term uptrend." },

  { key: "bb_width", label: "Bollinger width", group: "Volatility", unit: "ratio", help: "Current band span relative to price." },
  { key: "bb_width_percentile_126d", label: "Bollinger width pct (6mo)", group: "Volatility", unit: "ratio", help: "Where today's band width ranks vs the stock's own last 6 months. Low = squeeze." },
  { key: "realized_vol_20d", label: "20-day realized vol", group: "Volatility", unit: "pct", help: "Annualised, trailing 20 sessions." },
  { key: "vol_percentile_252d", label: "Vol percentile (1yr)", group: "Volatility", unit: "ratio", help: "Where current volatility ranks vs the stock's own trailing year." },

  { key: "volume_ratio_20d", label: "Volume vs 20-day avg", group: "Volume", unit: "num", help: "Today's volume as a multiple of the 20-day average." },
  { key: "amihud_illiq", label: "Illiquidity (Amihud)", group: "Volume", unit: "num", help: "Price impact per dollar traded — higher = thinner." },

  { key: "days_since_earnings", label: "Days since earnings", group: "Earnings", unit: "num", help: "Sessions since the last reported quarter (from FMP)." },
  { key: "surprise_pct", label: "Earnings surprise", group: "Earnings", unit: "pct", help: "Last reported EPS vs consensus, as a fraction of the estimate." },

  { key: "macd_cross", label: "MACD cross", group: "Signals", unit: "num", help: "1 = bullish cross today, -1 = bearish, 0 = none." },
];

export function fieldsFor(scope: Scope): ScreenField[] {
  return scope === "window" ? WINDOW_FIELDS : SNAPSHOT_FIELDS;
}

export function findField(scope: Scope, key: string): ScreenField | undefined {
  return fieldsFor(scope).find((f) => f.key === key);
}

/** Format a raw metric value for display in the results table. */
export function formatMetric(unit: Unit, v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  switch (unit) {
    case "pct":
      return `${(v * 100).toFixed(1)}%`;
    case "ratio":
      return v.toFixed(2);
    case "score":
      return v.toFixed(1);
    case "num":
      return Math.abs(v) >= 1000 ? v.toLocaleString() : v.toFixed(2);
    case "price":
      return `$${v.toFixed(2)}`;
    case "usd":
      if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
      if (Math.abs(v) >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
      return `$${v.toFixed(0)}`;
    default:
      return String(v);
  }
}

export interface Condition {
  scope: Scope;
  field: string;
  op: string;
  value: string; // kept as strings in the form; coerced on submit
  value2: string;
}

export interface ScreenSpec {
  window: WindowLen;
  restrict_band: boolean;
  exclude_alert_excluded: boolean;
  limit: number;
  sort: string;
  sort_dir: "asc" | "desc";
  conditions: Condition[];
}

export const DEFAULT_SPEC: ScreenSpec = {
  window: 40,
  restrict_band: false,
  exclude_alert_excluded: true,
  limit: 200,
  sort: "dollar_vol_20d",
  sort_dir: "desc",
  conditions: [{ scope: "window", field: "bb_width_avg", op: "lt", value: "0.06", value2: "" }],
};

/** Shape the form spec into the jsonb `screen_symbols` expects. */
export function toRpcSpec(spec: ScreenSpec): Record<string, unknown> {
  return {
    window: spec.window,
    restrict_band: spec.restrict_band,
    exclude_alert_excluded: spec.exclude_alert_excluded,
    limit: spec.limit,
    sort: spec.sort,
    sort_dir: spec.sort_dir,
    conditions: spec.conditions
      .filter((c) => c.field && c.op && c.value !== "")
      .map((c) => ({
        scope: c.scope,
        field: c.field,
        op: c.op,
        value: Number(c.value),
        ...(c.value2 !== "" ? { value2: Number(c.value2) } : {}),
      })),
  };
}
