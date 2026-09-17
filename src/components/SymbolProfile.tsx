import { useEffect, useState } from "react";
import { etDateString } from "../lib/marketTime";
import { createPortal } from "react-dom";
import { supabase } from "../lib/supabaseClient";
import { evaluateTrigger, type TriggerDefinition, type TriggerInputs } from "../lib/triggerEval";
import { computeProximity } from "../lib/triggerProximity";
import { triggerLabel, humanize, TRIGGER_INFO } from "../lib/triggerInfo";
import { FIELD_META, HIDDEN_FIELDS, formatField, pct } from "../lib/factorFormat";
import type { FactorState, RegimeState, Trigger } from "../lib/types";
import { InfoTooltip } from "./InfoTooltip";
import { ProximityBar } from "./ProximityBar";

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
  proximity: number | null;
  variant: "entry" | "exit";
  /** buy setup, avoid warning, or exit tracking */
  kind: "buy" | "avoid" | "exit";
  /** fast triggers read today's live session; slow ones the last close */
  timing: "live" | "close";
  /** a live trigger with no live factors for this symbol this session */
  noLiveData: boolean;
  lastFired: string | null;
  position?: TrackedPosition | null;
}

interface TrackedPosition {
  entry_ts: string | null;
  entry_date: string;
  entry_price: number | null;
  stop_price: number | null;
  rules: { profit_target_pct?: number; trail_pct?: number; time_stop_days?: number } | null;
}

interface OpenShadowPosition {
  entry_date: string;
}

/**
 * momentum_exit isn't a declarative {all:[...]} trigger — its three
 * sub-conditions (rank dropped below the top third, a bottom-decile
 * week, or a 180-day max hold) are OR'd together directly in eod-scan.ts
 * against an open shadow_positions row, not evaluated by triggers.ts.
 * This mirrors that logic for the proximity bar only: overall proximity
 * is the *max* of the three (OR semantics — whichever sub-condition is
 * closest determines how close the exit as a whole is), matching the
 * *min*-across-AND-conditions approach computeProximity() uses for every
 * other trigger, just flipped for OR.
 */
function momentumExitProximity(position: OpenShadowPosition, factor: FactorState): number | null {
  const rankPct = factor.momentum_rank_pct;
  const ret1wRankPct = factor.ret_1w_rank_pct;
  if (rankPct === null || rankPct === undefined || ret1wRankPct === null || ret1wRankPct === undefined) return null;

  const rankDroppedProximity = (1 - rankPct) / (1 - 0.67);
  const weeklyReversalProximity = (1 - ret1wRankPct) / (1 - 0.1);
  const daysHeld = Math.floor((Date.now() - new Date(`${position.entry_date}T00:00:00Z`).getTime()) / 86_400_000);
  const maxHoldProximity = daysHeld / 180;

  return Math.max(rankDroppedProximity, weeklyReversalProximity, maxHoldProximity);
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
export function SymbolProfile({
  symbolId,
  news, factorsTarget = null }: {
  symbolId: number;
  news?: React.ReactNode; factorsTarget?: HTMLElement | null }) {
  const [factorState, setFactorState] = useState<FactorState | null>(null);
  const [profileTriggers, setProfileTriggers] = useState<ProfileTrigger[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      const today = etDateString(Date.now());
      const [factorRes, regimeRes, triggersRes, openPositionRes, trackedRes, liveRes, firedRes] = await Promise.all([
        supabase
          .from("factor_state")
          .select("*")
          .eq("symbol_id", symbolId)
          .order("as_of", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase.from("regime_state").select("*").order("as_of", { ascending: false }).limit(1).maybeSingle(),
        supabase.from("triggers").select("*").eq("enabled", true).neq("category", "outlier"),
        supabase
          .from("shadow_positions")
          .select("entry_date")
          .eq("symbol_id", symbolId)
          .eq("status", "open")
          .eq("strategy", "swing")
          .order("entry_date", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("shadow_positions")
          .select("entry_ts, entry_date, entry_price, stop_price, rules")
          .eq("symbol_id", symbolId)
          .eq("status", "open")
          .eq("strategy", "flip")
          .order("entry_ts", { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from("intraday_factor_state")
          .select("*")
          .eq("symbol_id", symbolId)
          .eq("session_date", today)
          .maybeSingle(),
        supabase
          .from("trigger_events")
          .select("trigger_id, ts")
          .eq("symbol_id", symbolId)
          .order("ts", { ascending: false })
          .limit(100),
      ]);
      if (cancelled) return;

      const factor = factorRes.data as FactorState | null;
      const regime = regimeRes.data as RegimeState | null;
      const triggers = (triggersRes.data as (Trigger & { speed?: string; direction?: string })[] | null) ?? [];
      const openPosition = openPositionRes.data as OpenShadowPosition | null;
      const tracked = trackedRes.data as TrackedPosition | null;
      const live = liveRes.data as Record<string, number | boolean | null> | null;

      setFactorState(factor);
      if (!triggers.length) {
        setProfileTriggers([]);
        setLoading(false);
        return;
      }

      const lastFiredById = new Map<number, string>();
      for (const r of (firedRes.data as { trigger_id: number; ts: string }[] | null) ?? []) {
        if (!lastFiredById.has(r.trigger_id)) lastFiredById.set(r.trigger_id, r.ts);
      }

      const { data: statsData } = await supabase
        .from("trigger_stats")
        .select("trigger_id, horizon_days, sample_size, win_rate, avg_return")
        .in("trigger_id", triggers.map((t) => t.id));
      if (cancelled) return;
      const statsByTrigger = new Map<number, TriggerStatRow[]>();
      for (const row of (statsData as TriggerStatRow[] | null) ?? []) {
        const existing = statsByTrigger.get(row.trigger_id) ?? [];
        existing.push(row);
        statsByTrigger.set(row.trigger_id, existing);
      }

      const closeInputs: TriggerInputs | null = factor ? { ...factor, risk_on: regime?.risk_on ?? null } : null;
      const results: ProfileTrigger[] = [];
      for (const t of triggers) {
        const stats = (statsByTrigger.get(t.id) ?? []).sort((a, b) => a.horizon_days - b.horizon_days);
        const lastFired = lastFiredById.get(t.id) ?? null;
        const category = String(t.category ?? "");

        if (category === "exit") {
          // Exits aren't factor conditions: they follow an open tracked position.
          if (t.name === "exit_warning" && tracked) {
            results.push({ trigger: t, satisfied: false, stats, proximity: null, variant: "exit", kind: "exit", timing: "live", noLiveData: false, lastFired, position: tracked });
          } else if (t.name === "momentum_exit" && openPosition && factor) {
            results.push({ trigger: t, satisfied: false, stats, proximity: momentumExitProximity(openPosition, factor), variant: "exit", kind: "exit", timing: "close", noLiveData: false, lastFired });
          }
          continue;
        }

        const timing: "live" | "close" = t.speed === "fast" ? "live" : "close";
        const inputs = timing === "live" ? (live as TriggerInputs | null) : closeInputs;
        const def = t.definition as unknown as TriggerDefinition;
        results.push({
          trigger: t,
          satisfied: inputs ? evaluateTrigger(def, inputs) : false,
          stats,
          proximity: inputs ? computeProximity(def, inputs) : null,
          variant: "entry",
          kind: category === "avoid" || t.direction === "short" ? "avoid" : "buy",
          timing,
          noLiveData: timing === "live" && !live,
          lastFired,
        });
      }

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

  const snapshotFields = Object.entries(factorState)
    .filter(([key, value]) => !HIDDEN_FIELDS.has(key) && key !== "as_of" && value !== null)
    .sort(([a], [b]) => factorOrder(a) - factorOrder(b));

  const factorSnapshot = (
    <div className="factor-snapshot">
      <h3 className="profile-subheading">
        Factor snapshot <span className="profile-asof">as of {factorState.as_of}</span>
      </h3>
      <div className="dossier-metrics">
        {snapshotFields.map(([key, value]) => {
          const meta = FIELD_META[key];
          const label = meta?.label ?? humanize(key);
          const formatted = formatField(key, value);
          return (
            <div className="dossier-metric" key={key}>
              <span className="dossier-metric-label">
                {meta?.description ? <InfoTooltip text={meta.description}>{label}</InfoTooltip> : label}
              </span>
              <span className="dossier-metric-value">{formatted}</span>
            </div>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="symbol-profile">
      {factorsTarget ? createPortal(factorSnapshot, factorsTarget) : factorSnapshot}

      <div className="symbol-profile-split">
        <div className="symbol-profile-triggers">
          <h3 className="profile-subheading">Trigger status</h3>
          {!profileTriggers || profileTriggers.length === 0 ? (
            <p className="empty-state">No enabled triggers to evaluate.</p>
          ) : (
            <div className="trigger-profile-list">
              {(
                [
                  ["buy", "Buy setups"],
                  ["avoid", "Avoid warnings"],
                  ["exit", "Exit"],
                ] as const
              ).map(([kind, title]) => {
                const rows = profileTriggers.filter((p) => p.kind === kind);
                if (!rows.length) return null;
                return (
                  <div key={kind} className="trigger-profile-group">
                    <h4 className="trigger-profile-group-title">{title}</h4>
                    {rows.map((row) => (
                      <TriggerStatusRow key={row.trigger.id} row={row} />
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {news ? <div className="symbol-profile-news">{news}</div> : null}
      </div>
    </div>
  );
}

// Top-to-bottom order for the factor snapshot column: returns (short to
// long), their ranks, trend, oscillators, then volume and volatility.
// Anything not listed (e.g. earnings fields) follows in its original order.
const FACTOR_ORDER = [
  "ret_1w",
  "ret_1m",
  "roc_20d",
  "ret_6m",
  "ret_12m_ex1m",
  "ret_1w_rank_pct",
  "roc_20d_rank_pct",
  "momentum_rank_pct",
  "dist_sma200",
  "dist_ema20",
  "is_20d_high",
  "macd_cross",
  "rsi14",
  "rsi2",
  "bb_pctb",
  "bb_width",
  "bb_width_percentile_126d",
  "volume_ratio_20d",
  "avg_volume_1w",
  "avg_volume_1m",
  "avg_volume_3m",
  "avg_volume_6m",
  "avg_volume_1y",
  "dollar_vol_20d",
  "realized_vol_20d",
  "vol_percentile_252d",
];

function factorOrder(key: string): number {
  const i = FACTOR_ORDER.indexOf(key);
  return i === -1 ? FACTOR_ORDER.length : i;
}

/** One trigger in the symbol page's Trigger status list. */
function TriggerStatusRow({ row }: { row: ProfileTrigger }) {
  const { trigger, satisfied, stats, proximity, variant, kind, timing, noLiveData, lastFired, position } = row;
  const info = TRIGGER_INFO[trigger.name];

  let statusText: string;
  let statusClass: string;
  let statusTip: string;
  if (kind === "exit") {
    statusText = "Tracking";
    statusClass = "tracking";
    statusTip = "A buy alert on this stock is being followed for its exit: stop, take profit, trailing stop or time limit.";
  } else if (noLiveData) {
    statusText = "No live data";
    statusClass = "unsatisfied";
    statusTip = "Checked every 5 minutes during the session; this stock has no live factors yet today (outside market hours, or below the monitoring floor).";
  } else if (kind === "avoid") {
    statusText = satisfied ? "Warning now" : "Clear";
    statusClass = satisfied ? "warning" : "unsatisfied";
    statusTip = satisfied ? "This avoid condition is true right now." : "This avoid condition is not true right now.";
  } else {
    statusText = satisfied ? "Setup now" : "Not now";
    statusClass = satisfied ? "satisfied" : "unsatisfied";
    statusTip = satisfied ? "This setup's conditions are all true right now." : "At least one of this setup's conditions is not true right now.";
  }

  // One evidence line: a backtest summary if there is one, else the tested evidence.
  const real = stats.filter((s) => s.sample_size > 0);
  const five = real.find((s) => s.horizon_days === 5) ?? real[real.length - 1];
  const evidence = five
    ? `Backtest ${five.horizon_days}-day: ${pct(five.win_rate ?? 0, 0)} win · avg ${pct(five.avg_return ?? 0, 2)} · ${five.sample_size.toLocaleString()} samples`
    : info?.evidence ?? null;

  const fmtTs = (ts: string) =>
    new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const usd = (v: number | null) => (v != null ? `$${Number(v).toFixed(2)}` : "—");

  return (
    <div className="trigger-profile-row">
      <div className="trigger-profile-header">
        <span className="trigger-profile-label">
          {info?.summary ? <InfoTooltip text={info.summary}>{triggerLabel(trigger.name)}</InfoTooltip> : triggerLabel(trigger.name)}
        </span>
        <span className={`trigger-profile-timing ${timing}`}>{timing === "live" ? "Live" : "At close"}</span>
        <span className={`trigger-profile-status ${statusClass}`}>
          <InfoTooltip underline={false} text={statusTip}>
            {statusText}
          </InfoTooltip>
        </span>
      </div>
      {kind === "exit" && position ? (
        <p className="trigger-profile-meta">
          Since {fmtTs(position.entry_ts ?? `${position.entry_date}T12:00:00Z`)} · entry {usd(position.entry_price)} · stop{" "}
          {usd(position.stop_price)}
          {position.entry_price != null && position.rules?.profit_target_pct != null
            ? ` · target ${usd(position.entry_price * (1 + position.rules.profit_target_pct))}`
            : ""}
          {position.rules?.trail_pct != null ? ` · ${Math.round(position.rules.trail_pct * 100)}% trail` : ""}
          {position.rules?.time_stop_days != null ? ` · ${position.rules.time_stop_days}-day limit` : ""}
        </p>
      ) : (
        !noLiveData && <ProximityBar proximity={proximity} variant={variant} />
      )}
      {evidence && <p className="trigger-profile-note">{evidence}</p>}
      {lastFired && <p className="trigger-profile-meta">Last fired here: {fmtTs(lastFired)}</p>}
    </div>
  );
}
