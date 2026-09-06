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
}

// Known fields across every trigger source's snapshot shape (and the
// live factor_state/regime_state columns SymbolProfile reads directly).
// Anything not listed here still renders — just with a humanized key and
// the raw value — so an unrecognized field is visible, not silently
// dropped.
export const FIELD_META: Record<string, FieldMeta> = {
  price: { label: "Price", format: usd },
  latest_price: { label: "Price", format: usd },
  z_score: { label: "Z-Score", format: (v) => num(v) },
  tick_return: { label: "Tick Return", format: (v) => pct(v, 3) },
  tick_count: { label: "Tick #", format: (v) => String(v) },
  trade_ts: { label: "Trade Time", format: dateTime },
  as_of: { label: "As Of", format: (v) => String(v) },
  ret_1w: { label: "1-Week Return", format: (v) => pct(v) },
  ret_1w_rank_pct: {
    label: "1-Week Return Rank",
    format: (v) => `${Math.round(Number(v) * 100)}th percentile`,
  },
  ret_1m: { label: "1-Month Return", format: (v) => pct(v) },
  ret_6m: { label: "6-Month Return", format: (v) => pct(v) },
  ret_12m_ex1m: { label: "12-1 Month Momentum", format: (v) => pct(v) },
  momentum_rank_pct: { label: "Momentum Rank", format: (v) => `${Math.round(Number(v) * 100)}th percentile` },
  sue: { label: "Earnings Surprise (SUE)", format: (v) => num(v) },
  est_revision_30d: { label: "30-Day Estimate Revision", format: (v) => pct(v) },
  book_to_market: { label: "Book-to-Market", format: (v) => num(v) },
  realized_vol_20d: { label: "20-Day Realized Vol", format: (v) => pct(v, 1) },
  vol_percentile_252d: { label: "Vol Percentile (1Y)", format: (v) => `${Math.round(Number(v) * 100)}th` },
  dollar_vol_20d: { label: "20-Day $ Volume", format: usdCompact },
  amihud_illiq: { label: "Illiquidity (Amihud)", format: (v) => num(v, 4) },
  bb_pctb: { label: "Bollinger %B", format: (v) => pct(v, 1) },
  bb_width: { label: "Bollinger Width", format: (v) => pct(v, 1) },
  rsi14: { label: "RSI (14)", format: (v) => num(v, 1) },
  rsi2: { label: "RSI (2)", format: (v) => num(v, 1) },
  dist_ema20: { label: "Distance from 20-day EMA", format: (v) => pct(v) },
  dist_sma200: { label: "Distance from 200-day MA", format: (v) => pct(v) },
  risk_on: { label: "Regime", format: (v) => (v ? "Risk-On" : "Risk-Off") },
  bb_width_percentile_126d: {
    label: "Band Width Percentile (6mo)",
    format: (v) => `${Math.round(Number(v) * 100)}th percentile`,
  },
  volume_ratio_20d: { label: "Volume vs. 20-Day Avg", format: (v) => `${num(v, 1)}x` },
  roc_20d: { label: "20-Day Rate of Change", format: (v) => pct(v) },
  roc_20d_rank_pct: {
    label: "20-Day ROC Rank",
    format: (v) => `${Math.round(Number(v) * 100)}th percentile`,
  },
  is_20d_high: { label: "20-Day High", format: (v) => (v ? "Yes" : "No") },
  macd_cross: {
    label: "MACD Cross",
    format: (v) => (Number(v) === 1 ? "Bullish" : Number(v) === -1 ? "Bearish" : "None"),
  },
  // momentum_exit's snapshot shape (shadow position closing out)
  shadow_position_id: { label: "Position #", format: (v) => String(v) },
  entry_date: { label: "Entered On", format: (v) => String(v) },
  days_held: { label: "Days Held", format: (v) => String(v) },
  exit_price: { label: "Exit Price", format: usd },
  exit_reason: {
    label: "Exit Reason",
    format: (v) =>
      ({ rank_dropped: "Momentum rank dropped", weekly_reversal: "Bad week (reversal)", max_hold_period: "Held past 180 days" })[
        String(v)
      ] ?? String(v),
  },
};

// Fields that are noise in this context (redundant with the card's own
// header/props, or internal bookkeeping) — hidden rather than dumped.
export const HIDDEN_FIELDS = new Set(["symbol_id", "note", "trigger", "ticker", "computed_at"]);
