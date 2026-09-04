// Deliberately a narrow structural type rather than importing the full
// Dossier from lib/types — this only needs these four fields, and
// decoupling avoids forcing every caller to also supply
// trigger_event_id/symbol_id it doesn't use.
export interface DossierCardData {
  ts: string;
  score: number | null;
  analysis: Record<string, unknown>;
}

/**
 * Renders a dossier's `analysis` JSON as readable labeled metrics instead
 * of a raw code dump. The shape of `analysis.fired_on` varies by which
 * job produced the trigger_event (eod-scan's full factor_state row,
 * intraday-scan's leaner technical-only fields, or the outlier worker's
 * tick-level snapshot — see deep-dive.ts) — this formats whatever fields
 * are actually present rather than assuming one fixed schema, so it stays
 * correct as new trigger categories get added.
 */

const TRIGGER_LABELS: Record<string, string> = {
  momentum_rank_entry: "Momentum Rank Entry",
  earnings_surprise_drift: "Earnings Surprise Drift",
  bb_rsi_confluence_long: "Bollinger/RSI Confluence (Long)",
  bb_rsi_confluence_short: "Bollinger/RSI Confluence (Short)",
  realtime_outlier_zscore: "Real-Time Outlier",
  volatility_squeeze_breakout_long: "Volatility Squeeze Breakout (Up)",
  volatility_squeeze_breakout_short: "Volatility Squeeze Breakout (Down)",
  momentum_breakout: "Momentum Breakout",
  macd_bullish_cross: "MACD Bullish Cross",
  macd_bearish_cross: "MACD Bearish Cross",
};

function humanizeKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function pct(v: unknown, decimals = 2): string {
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return `${(n * 100).toFixed(decimals)}%`;
}

function num(v: unknown, decimals = 2): string {
  const n = Number(v);
  return Number.isNaN(n) ? String(v) : n.toFixed(decimals);
}

function usd(v: unknown, decimals = 2): string {
  const n = Number(v);
  return Number.isNaN(n) ? String(v) : `$${n.toFixed(decimals)}`;
}

function usdCompact(v: unknown): string {
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return usd(n);
}

function dateTime(v: unknown): string {
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
}

interface FieldMeta {
  label: string;
  format: (v: unknown) => string;
}

// Known fields across every trigger source's snapshot shape. Anything not
// listed here still renders — just with a humanized key and the raw value
// — so an unrecognized field is visible, not silently dropped.
const FIELD_META: Record<string, FieldMeta> = {
  price: { label: "Price", format: usd },
  latest_price: { label: "Price", format: usd },
  z_score: { label: "Z-Score", format: (v) => num(v) },
  tick_return: { label: "Tick Return", format: (v) => pct(v, 3) },
  tick_count: { label: "Tick #", format: (v) => String(v) },
  trade_ts: { label: "Trade Time", format: dateTime },
  as_of: { label: "As Of", format: (v) => String(v) },
  ret_1w: { label: "1-Week Return", format: (v) => pct(v) },
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
};

// Fields that are noise in this context (redundant with the card's own
// header/props, or internal bookkeeping) — hidden rather than dumped.
const HIDDEN_FIELDS = new Set(["symbol_id", "note", "trigger", "ticker"]);

export function DossierCard({ dossier }: { dossier: DossierCardData }) {
  const analysis = dossier.analysis as {
    trigger?: string;
    ticker?: string;
    fired_on?: Record<string, unknown>;
    note?: string;
  };

  const triggerLabel = analysis.trigger
    ? (TRIGGER_LABELS[analysis.trigger] ?? humanizeKey(analysis.trigger))
    : "Unknown trigger";

  const fields = Object.entries(analysis.fired_on ?? {}).filter(([key]) => !HIDDEN_FIELDS.has(key));

  return (
    <div className="dossier-card">
      <div className="dossier-card-header">
        <div>
          <div className="dossier-trigger-name">{triggerLabel}</div>
          <div className="dossier-timestamp">{new Date(dossier.ts).toLocaleString()}</div>
        </div>
        <div className="dossier-score" title="Conviction score">
          {dossier.score !== null ? `${Math.round(dossier.score * 100)}%` : "—"}
        </div>
      </div>

      {fields.length > 0 && (
        <div className="dossier-metrics">
          {fields.map(([key, value]) => {
            const meta = FIELD_META[key];
            const label = meta?.label ?? humanizeKey(key);
            const formatted = value === null || value === undefined ? "—" : (meta?.format(value) ?? String(value));
            return (
              <div className="dossier-metric" key={key}>
                <span className="dossier-metric-label">{label}</span>
                <span className="dossier-metric-value">{formatted}</span>
              </div>
            );
          })}
        </div>
      )}

      {analysis.note && <div className="dossier-note">{analysis.note}</div>}
    </div>
  );
}
