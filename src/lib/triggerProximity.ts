import type { Condition, TriggerDefinition, TriggerInputs } from "./triggerEval";

/**
 * Natural [lo, hi] bounds for fields that have one — used to normalize a
 * condition's current value into a 0-100%+ "how close to the threshold"
 * reading. A field not listed here falls back to lo=0 for a gte/gt
 * condition (true for every ratio/ percentile-style field actually used
 * that way today — sue, volume_ratio_20d) and, for an lt/lte condition,
 * hi = 2x the threshold (no unbounded-above field is used with lt/lte in
 * the current trigger set, so this branch is a defensive fallback rather
 * than something real data exercises).
 */
const FIELD_RANGE: Record<string, [number, number]> = {
  momentum_rank_pct: [0, 1],
  roc_20d_rank_pct: [0, 1],
  ret_1w_rank_pct: [0, 1],
  vol_percentile_252d: [0, 1],
  bb_width_percentile_126d: [0, 1],
  bb_pctb: [0, 1],
  rsi14: [0, 100],
  rsi2: [0, 100],
};

/**
 * A single condition's progress toward being true, as a fraction: 0 = as
 * far as the field's natural range allows, 1 = exactly at the threshold,
 * >1 = already past it. Null when the field has no current value.
 */
export function conditionProximity(cond: Condition, inputs: TriggerInputs): number | null {
  const cur = inputs[cond.field];
  if (cur === null || cur === undefined) return null;

  if (cond.op === "eq" || cond.op === "neq") {
    const matches = cond.op === "eq" ? cur === cond.value : cur !== cond.value;
    return matches ? 1 : 0;
  }

  const value = Number(cond.value);
  const actual = Number(cur);
  if (Number.isNaN(value) || Number.isNaN(actual)) return null;

  const range = FIELD_RANGE[cond.field];
  if (cond.op === "gte" || cond.op === "gt") {
    const lo = range?.[0] ?? 0;
    if (value === lo) return actual >= lo ? 1 : 0;
    return (actual - lo) / (value - lo);
  }
  // lt / lte
  const hi = range?.[1] ?? value * 2;
  if (hi === value) return actual <= value ? 1 : 0;
  return (hi - actual) / (hi - value);
}

/**
 * Overall proximity for a whole trigger: the weakest (lowest) proximity
 * among its AND-combined conditions, since that's the one actually
 * gating whether it fires — the same all()-must-be-true semantics
 * evaluateTrigger() uses, just continuous instead of boolean. Null when
 * any condition's field has no data yet (rather than guessing).
 */
export function computeProximity(definition: TriggerDefinition, inputs: TriggerInputs): number | null {
  if (!definition?.all?.length) return null;
  let min: number | null = null;
  for (const cond of definition.all) {
    const p = conditionProximity(cond, inputs);
    if (p === null) return null;
    if (min === null || p < min) min = p;
  }
  return min;
}
