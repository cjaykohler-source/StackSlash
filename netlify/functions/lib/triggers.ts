/**
 * Declarative trigger evaluation. A trigger's `definition` column is a
 * small JSON rule; this file is the only place that interprets it, so
 * eod-scan, intraday-scan, and a future backtest script all evaluate
 * triggers identically.
 *
 * Definition shape:
 *   { "all": [ { "field": "momentum_rank_pct", "op": "gte", "value": 0.95 }, ... ] }
 *
 * `field` is looked up on the merged (factor_state + regime_state) input
 * object passed to evaluateTrigger.
 */

export type Op = "gt" | "gte" | "lt" | "lte" | "eq" | "neq";

export interface Condition {
  field: string;
  op: Op;
  value: number | boolean | string;
}

export interface TriggerDefinition {
  all: Condition[];
}

export type TriggerInputs = Record<string, number | boolean | string | null | undefined>;

function compare(op: Op, actual: unknown, expected: unknown): boolean {
  if (actual === null || actual === undefined) return false;
  switch (op) {
    case "gt":
      return (actual as number) > (expected as number);
    case "gte":
      return (actual as number) >= (expected as number);
    case "lt":
      return (actual as number) < (expected as number);
    case "lte":
      return (actual as number) <= (expected as number);
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    default:
      return false;
  }
}

export function evaluateTrigger(definition: TriggerDefinition, inputs: TriggerInputs): boolean {
  if (!definition?.all?.length) return false;
  return definition.all.every((cond) => compare(cond.op, inputs[cond.field], cond.value));
}
