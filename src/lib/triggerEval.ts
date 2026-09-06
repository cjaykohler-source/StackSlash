/**
 * Client-side port of netlify/functions/lib/triggers.ts's declarative
 * trigger evaluator — ported rather than imported because the frontend
 * (src/) and Netlify Functions are separate build targets with their own
 * tsconfigs/bundlers. Used only for SymbolProfile.tsx's live "does this
 * symbol currently satisfy this trigger" display — this project's actual
 * trigger-firing decisions still only ever happen server-side in
 * eod-scan/intraday-scan/the worker, never here. Keep this in sync with
 * the canonical version by hand; a drift here is a display bug, not a
 * correctness bug in the real pipeline.
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
