// Mirrors the public schema in Supabase (project wnzxvdfskmivbyqadtll).
// Keep in sync with the migration in the Supabase project — regenerate with
// `supabase gen types typescript` once the schema stabilizes.

export interface Symbol {
  id: number;
  ticker: string;
  name: string | null;
  sector: string | null;
  active: boolean;
  added_at: string;
}

export interface FactorState {
  symbol_id: number;
  as_of: string;
  ret_1w: number | null;
  ret_1m: number | null;
  ret_6m: number | null;
  ret_12m_ex1m: number | null;
  momentum_rank_pct: number | null;
  sue: number | null;
  days_since_earnings: number | null;
  est_revision_30d: number | null;
  book_to_market: number | null;
  sales_growth: number | null;
  capex_to_assets: number | null;
  realized_vol_20d: number | null;
  vol_percentile_252d: number | null;
  dollar_vol_20d: number | null;
  amihud_illiq: number | null;
  bb_pctb: number | null;
  bb_width: number | null;
  rsi14: number | null;
  rsi2: number | null;
  dist_ema20: number | null;
  dist_sma200: number | null;
  bb_width_percentile_126d: number | null;
  volume_ratio_20d: number | null;
  roc_20d: number | null;
  roc_20d_rank_pct: number | null;
  is_20d_high: boolean | null;
  macd_cross: -1 | 0 | 1 | null;
  computed_at: string;
}

export interface RegimeState {
  as_of: string;
  index_symbol: string;
  above_200dma: boolean | null;
  vol_regime: "low" | "normal" | "high" | null;
  risk_on: boolean | null;
  computed_at: string;
}

export interface Trigger {
  id: number;
  name: string;
  description: string | null;
  definition: Record<string, unknown>;
  category: "momentum" | "earnings" | "technical" | "regime" | null;
  enabled: boolean;
  cooldown_minutes: number;
  version: number;
}

export interface TriggerEvent {
  id: number;
  trigger_id: number;
  symbol_id: number;
  ts: string;
  snapshot: Record<string, unknown>;
  status: "new" | "dossier_ready" | "alerted" | "dismissed";
}

export interface Dossier {
  id: number;
  trigger_event_id: number;
  symbol_id: number;
  ts: string;
  analysis: Record<string, unknown>;
  score: number | null;
}

export interface WatchlistItem {
  user_id: string;
  symbol_id: number;
  note: string | null;
  added_at: string;
}
