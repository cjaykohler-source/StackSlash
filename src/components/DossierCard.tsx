import { triggerLabel, humanize } from "../lib/triggerInfo";
import { pct, FIELD_META, HIDDEN_FIELDS } from "../lib/factorFormat";

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
 *
 * Trigger labels come from lib/triggerInfo.ts (shared with TriggerFeed
 * and the About page); field labels/formatters come from
 * lib/factorFormat.ts (shared with SymbolProfile.tsx's live snapshot)
 * rather than a local map, so both places describe the same underlying
 * factor_state columns identically.
 */

interface HistoricalStats {
  horizon_days?: number;
  sample_size: number;
  win_rate?: number | null;
  avg_return?: number | null;
  cev_score?: number | null;
  note?: string;
}

interface Confirmation {
  name: string;
  confirmed: boolean;
  note: string;
}

export function DossierCard({ dossier }: { dossier: DossierCardData }) {
  const analysis = dossier.analysis as {
    trigger?: string;
    ticker?: string;
    fired_on?: Record<string, unknown>;
    note?: string; // legacy placeholder-era dossiers only
    historical?: HistoricalStats;
    confirmations?: Confirmation[];
  };

  const displayLabel = analysis.trigger ? triggerLabel(analysis.trigger) : "Unknown trigger";

  const fields = Object.entries(analysis.fired_on ?? {}).filter(([key]) => !HIDDEN_FIELDS.has(key));

  return (
    <div className="dossier-card">
      <div className="dossier-card-header">
        <div>
          <div className="dossier-trigger-name">{displayLabel}</div>
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
            const label = meta?.label ?? humanize(key);
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

      {analysis.historical && (
        <div className="dossier-historical">
          {analysis.historical.sample_size > 0 && typeof analysis.historical.win_rate === "number" ? (
            <>
              <span className="dossier-historical-label">Historically ({analysis.historical.sample_size} fires, {analysis.historical.horizon_days}-day):</span>{" "}
              wins {pct(analysis.historical.win_rate, 0)} of the time, average return{" "}
              {pct(analysis.historical.avg_return ?? 0)}
            </>
          ) : (
            <span className="dossier-historical-note">{analysis.historical.note}</span>
          )}
        </div>
      )}

      {analysis.confirmations && analysis.confirmations.length > 0 && (
        <div className="dossier-confirmations">
          {analysis.confirmations.map((c) => (
            <span
              key={c.name}
              className={`confirmation-chip ${c.confirmed ? "confirmation-yes" : "confirmation-no"}`}
              title={c.note}
            >
              {c.confirmed ? "✓" : "✗"} {c.name}
            </span>
          ))}
        </div>
      )}

      {analysis.note && <div className="dossier-note">{analysis.note}</div>}
    </div>
  );
}
