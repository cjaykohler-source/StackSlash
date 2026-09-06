import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { evaluateTrigger, type TriggerDefinition, type TriggerInputs } from "../lib/triggerEval";
import { triggerLabel, triggerCategoryLabel, humanize } from "../lib/triggerInfo";
import { FIELD_META, HIDDEN_FIELDS, pct } from "../lib/factorFormat";
import type { FactorState, RegimeState, Trigger } from "../lib/types";

interface TriggerStatRow {
  trigger_id: number;
  horizon_days: number;
  sample_size: number;
  win_rate: number | null;
  avg_return: number | null;
}

interface ProfileTrigger {
  trigger: Trigger;
  satisfied: boolean;
  stats: TriggerStatRow[];
}

/**
 * "Profile workup" for a symbol: the current factor_state snapshot, plus
 * — for every stateless trigger — whether it's satisfied *right now*
 * (not just "has it ever fired") and its real backtested win-rate/avg-
 * return from trigger_stats. Entirely client-side: factor_state,
 * triggers, and trigger_stats all already have an `authenticated read`
 * RLS policy, same as RegimeBanner/TriggerFeed/About's direct reads —
 * no new backend endpoint needed.
 *
 * Excludes category IN ('outlier', 'exit') — same exclusion
 * backtest-triggers.ts uses. realtime_outlier_zscore is tick-level
 * (bars_daily-derived factor_state can't evaluate it meaningfully) and
 * momentum_exit depends on shadow_positions state, not a stateless
 * factor check — evaluating either here would be meaningless, not just
 * redundant.
 *
 * evaluateTrigger comes from lib/triggerEval.ts, a client-side port of
 * the canonical netlify/functions/lib/triggers.ts — see that file's own
 * comment for why this is a deliberate duplicate, display-only.
 */
export function SymbolProfile({ symbolId }: { symbolId: number }) {
  const [factorState, setFactorState] = useState<FactorState | null>(null);
  const [profileTriggers, setProfileTriggers] = useState<ProfileTrigger[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      const [factorRes, regimeRes, triggersRes] = await Promise.all([
        supabase
          .from("factor_state")
          .select("*")
          .eq("symbol_id", symbolId)
          .order("as_of", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase.from("regime_state").select("*").order("as_of", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("triggers").select("*").eq("enabled", true).not("category", "in", "(outlier,exit)"),
      ]);
      if (cancelled) return;

      const factor = factorRes.data as FactorState | null;
      const regime = regimeRes.data as RegimeState | null;
      const triggers = (triggersRes.data as Trigger[] | null) ?? [];

      setFactorState(factor);

      if (!factor || !triggers.length) {
        setProfileTriggers([]);
        setLoading(false);
        return;
      }

      const triggerIds = triggers.map((t) => t.id);
      const { data: statsData } = await supabase
        .from("trigger_stats")
        .select("trigger_id, horizon_days, sample_size, win_rate, avg_return")
        .in("trigger_id", triggerIds);
      if (cancelled) return;

      const statsByTrigger = new Map<number, TriggerStatRow[]>();
      for (const row of (statsData as TriggerStatRow[] | null) ?? []) {
        const existing = statsByTrigger.get(row.trigger_id) ?? [];
        existing.push(row);
        statsByTrigger.set(row.trigger_id, existing);
      }

      // Same merge pattern eod-scan.ts uses when building trigger inputs.
      const inputs: TriggerInputs = { ...factor, risk_on: regime?.risk_on ?? null };

      const results: ProfileTrigger[] = triggers.map((t) => ({
        trigger: t,
        satisfied: evaluateTrigger(t.definition as unknown as TriggerDefinition, inputs),
        stats: (statsByTrigger.get(t.id) ?? []).sort((a, b) => a.horizon_days - b.horizon_days),
      }));

      setProfileTriggers(results);
      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [symbolId]);

  if (loading) return <p className="empty-state">Loading profile…</p>;
  if (!factorState) {
    return <p className="empty-state">No factor data yet for this symbol — it may not have been through a scan yet.</p>;
  }

  const snapshotFields = Object.entries(factorState).filter(
    ([key, value]) => !HIDDEN_FIELDS.has(key) && key !== "as_of" && value !== null,
  );

  return (
    <div className="symbol-profile">
      <h3 className="profile-subheading">
        Current factor snapshot <span className="profile-asof">as of {factorState.as_of}</span>
      </h3>
      <div className="dossier-metrics">
        {snapshotFields.map(([key, value]) => {
          const meta = FIELD_META[key];
          const label = meta?.label ?? humanize(key);
          const formatted = meta?.format(value) ?? String(value);
          return (
            <div className="dossier-metric" key={key}>
              <span className="dossier-metric-label">{label}</span>
              <span className="dossier-metric-value">{formatted}</span>
            </div>
          );
        })}
      </div>

      {profileTriggers && profileTriggers.filter((p) => p.satisfied).length >= 2 && (
        <div className="confluence-banner">
          <strong>Confluence: {profileTriggers.filter((p) => p.satisfied).length} signals agree right now</strong> —{" "}
          {profileTriggers
            .filter((p) => p.satisfied)
            .map((p) => triggerLabel(p.trigger.name))
            .join(", ")}
        </div>
      )}

      <h3 className="profile-subheading">Trigger status</h3>
      {!profileTriggers || profileTriggers.length === 0 ? (
        <p className="empty-state">No evaluable triggers configured.</p>
      ) : (
        <div className="trigger-profile-list">
          {profileTriggers.map(({ trigger, satisfied, stats }) => {
            const realStats = stats.filter((s) => s.sample_size > 0);
            return (
              <div className="trigger-profile-row" key={trigger.id}>
                <div className="trigger-profile-header">
                  <span className="trigger-profile-label">{triggerLabel(trigger.name)}</span>
                  <span className="trigger-profile-category">{triggerCategoryLabel(trigger.name)}</span>
                  <span className={`trigger-profile-status ${satisfied ? "satisfied" : "unsatisfied"}`}>
                    {satisfied ? "Satisfied now" : "Not satisfied"}
                  </span>
                </div>
                {realStats.length === 0 ? (
                  <p className="trigger-profile-note">No backtested history yet.</p>
                ) : (
                  <div className="trigger-profile-stats">
                    {realStats.map((s) => (
                      <span key={s.horizon_days} className="trigger-profile-stat">
                        {s.horizon_days}d: {pct(s.win_rate ?? 0, 0)} win rate ({s.sample_size} samples), avg{" "}
                        {pct(s.avg_return ?? 0)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
