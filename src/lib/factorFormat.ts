/**
 * Shared factor_state field labels/formatters — extracted from
 * DossierCard.tsx so both a fired dossier's snapshot and a live current
 * factor_state row (SymbolProfile.tsx) render the same columns with the
 * same labels/units instead of drifting into two vocabularies for the
 * same underlying data.
 */

export function pct(v: unknown, decimals = 2): string {
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return `${(n * 100).toFixed(decimals)}%`;
}

export function num(v: unknown, decimals = 2): string {
  const n = Number(v);
  return Number.isNaN(n) ? String(v) : n.toFixed(decimals);
}

export function usd(v: unknown, decimals = 2): string {
  const n = Number(v);
  return Number.isNaN(n) ? String(v) : `$${n.toFixed(decimals)}`;
}

export function usdCompact(v: unknown): string {
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return usd(n);
}

export function dateTime(v: unknown): string {
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
}

export interface FieldMeta {
  label: string;
  format: (v: unknown) => string;
  /** Plain-English explanation of what this field measures — shown as a
   *  hover tooltip on the label anywhere FIELD_META is rendered. */
  description?: string;
}

// Known fields across every trigger source's snapshot shape (and the
// live factor_state/regime_state columns SymbolProfile reads directly).
// Anything not listed here still renders — just with a humanized key and
// the raw value — so an unrecognized field is visible, not silently
// dropped.
export const FIELD_META: Record<string, FieldMeta> = {
  price: { label: "Price", format: usd, description: "Last traded price at the time this fired." },
  latest_price: { label: "Price", format: usd, description: "Most recent traded price." },
  z_score: {
    label: "Z-Score",
    format: (v) => num(v),
    description: "How many standard deviations this trade's price move is from the stock's normal moment-to-moment behavior. Higher magnitude = more unusual.",
  },
  tick_return: { label: "Tick Return", format: (v) => pct(v, 3), description: "The price change of this single trade versus the previous one." },
  tick_count: { label: "Tick #", format: (v) => String(v), description: "How many trades into today's session this was." },
  trade_ts: { label: "Trade Time", format: dateTime, description: "Timestamp of the trade that triggered this." },
  as_of: { label: "As Of", format: (v) => String(v), description: "The trading date this snapshot reflects." },
  ret_1w: { label: "1-Week Return", format: (v) => pct(v), description: "Price change over the trailing 5 trading days." },
  ret_1w_rank_pct: {
    label: "1-Week Return Rank",
    format: (v) => `${Math.round(Number(v) * 100)}th percentile`,
    description: "Where this stock's 1-week return ranks against every other tracked stock.",
  },
  ret_1m: { label: "1-Month Return", format: (v) => pct(v), description: "Price change over the trailing month." },
  ret_6m: { label: "6-Month Return", format: (v) => pct(v), description: "Price change over the trailing 6 months." },
  ret_12m_ex1m: {
    label: "12-1 Month Momentum",
    format: (v) => pct(v),
    description: "Price change over the trailing 12 months, excluding the most recent month — the standard academic momentum measure, since very recent moves tend to reverse.",
  },
  momentum_rank_pct: {
    label: "Momentum Rank",
    format: (v) => `${Math.round(Number(v) * 100)}th percentile`,
    description: "Where this stock's 12-1 month momentum ranks against every other tracked stock right now.",
  },
  sue: { label: "Earnings Surprise (SUE)", format: (v) => num(v), description: "Standardized Unexpected Earnings — how far the last reported EPS beat or missed consensus, in standard-deviation terms." },
  surprise_pct: { label: "Earnings Surprise", format: (v) => pct(v, 1), description: "How far the last reported EPS came in above (or below) consensus, as a percentage of the estimate." },
  est_revision_30d: { label: "30-Day Estimate Revision", format: (v) => pct(v), description: "How much analyst estimates for this stock have changed over the last 30 days." },
  book_to_market: { label: "Book-to-Market", format: (v) => num(v), description: "Book value of equity divided by market value — a classic value-factor measure." },
  realized_vol_20d: { label: "20-Day Realized Vol", format: (v) => pct(v, 1), description: "How much this stock's price has actually been swinging, annualized, over the last 20 trading days." },
  vol_percentile_252d: {
    label: "Vol Percentile (1Y)",
    format: (v) => `${Math.round(Number(v) * 100)}th`,
    description: "Where today's volatility ranks against this stock's own volatility over the last year.",
  },
  dollar_vol_20d: { label: "20-Day $ Volume", format: usdCompact, description: "Average daily dollar trading volume over the last 20 sessions — a proxy for liquidity." },
  amihud_illiq: { label: "Illiquidity (Amihud)", format: (v) => num(v, 4), description: "A standard measure of price impact per dollar traded — higher means thinner, harder-to-trade liquidity." },
  bb_pctb: {
    label: "Bollinger %B",
    format: (v) => pct(v, 1),
    description: "Where price sits within its Bollinger Bands. Near 0% = price at the lower band (stretched down); near 100% = at the upper band (stretched up).",
  },
  bb_width: { label: "Bollinger Width", format: (v) => pct(v, 1), description: "How wide the Bollinger Bands currently are relative to price — narrow means unusually quiet trading." },
  rsi14: { label: "RSI (14)", format: (v) => num(v, 1), description: "14-day Relative Strength Index. Below 30 is typically read as oversold, above 70 as overbought." },
  rsi2: { label: "RSI (2)", format: (v) => num(v, 1), description: "2-day Relative Strength Index — a much faster, noisier version of RSI used to catch very short-term extremes." },
  dist_ema20: { label: "Distance from 20-day EMA", format: (v) => pct(v), description: "How far the current price is from its 20-day exponential moving average." },
  dist_sma200: { label: "200-DAY MAΔ", format: (v) => pct(v), description: "How far the current price is from its 200-day simple moving average — positive means the stock is in a long-term uptrend." },
  risk_on: { label: "Regime", format: (v) => (v ? "Risk-On" : "Risk-Off"), description: "Whether the overall market is judged to be in a healthy uptrend right now — gates whether new long momentum/technical triggers are allowed to fire." },
  bb_width_percentile_126d: {
    label: "BMP 6MO",
    format: (v) => `${Math.round(Number(v) * 100)}th percentile`,
    description: "Where today's Bollinger Band width ranks against this stock's own last 6 months — low means an unusually tight 'squeeze'.",
  },
  volume_ratio_20d: { label: "Volume vs. 20-Day Avg", format: (v) => `${num(v, 1)}x`, description: "Today's trading volume as a multiple of the last 20 days' average volume." },
  roc_20d: { label: "20-Day Rate of Change", format: (v) => pct(v), description: "Price change over the trailing 20 trading days — a faster momentum measure than the 12-1 month one." },
  roc_20d_rank_pct: {
    label: "20-Day ROC Rank",
    format: (v) => `${Math.round(Number(v) * 100)}th percentile`,
    description: "Where this stock's 20-day rate of change ranks against every other tracked stock.",
  },
  is_20d_high: { label: "20-Day High", format: (v) => (v ? "Yes" : "No"), description: "Whether today's price is the highest close in the last 20 trading days." },
  macd_cross: {
    label: "MACD Cross",
    format: (v) => (Number(v) === 1 ? "Bullish" : Number(v) === -1 ? "Bearish" : "None"),
    description: "Whether the MACD trend indicator just crossed bullish (short-term average moved above long-term) or bearish (below).",
  },
  // momentum_exit's snapshot shape (shadow position closing out)
  shadow_position_id: { label: "Position #", format: (v) => String(v), description: "Internal ID of the tracked hypothetical position that was closed." },
  entry_date: { label: "Entered On", format: (v) => String(v), description: "The date this hypothetical position was opened." },
  days_held: { label: "Days Held", format: (v) => String(v), description: "How many days the position was held before exiting." },
  exit_price: { label: "Exit Price", format: usd, description: "Price at which the hypothetical position was closed." },
  exit_reason: {
    label: "Exit Reason",
    format: (v) =>
      ({ rank_dropped: "Momentum rank dropped", weekly_reversal: "Bad week (reversal)", max_hold_period: "Held past 180 days" })[
        String(v)
      ] ?? String(v),
    description: "Why the position was closed: its momentum rank fell out of the top third, it had an unusually bad week, or it hit the 180-day max hold period.",
  },
};

// Fields that are noise in this context (redundant with the card's own
// header/props, or internal bookkeeping) — hidden rather than dumped.
export const HIDDEN_FIELDS = new Set([
  "symbol_id",
  "note",
  "trigger",
  "ticker",
  "computed_at",
  "confluence",
  "priority",
  "close",
  "last_close",
  "as_of",
  "risk_flags",
  "trade",
  "earnings",
]);
