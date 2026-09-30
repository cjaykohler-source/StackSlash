import { supabase } from "./supabaseClient";

/**
 * Research results published nightly from the local research warehouse
 * (research/publish_research.py). Read-only here.
 */

export type Verdict = "avoid" | "positive" | "none" | "untested" | "watch";

export interface CatalystType {
  type: string;
  source: string;
  label: string;
  description: string | null;
  verdict: Verdict;
  verdict_note: string | null;
}

export interface CatalystTest {
  type: string;
  period: string;
  horizon: number;
  n: number | null;
  syms: number | null;
  mean_x: number | null;
  ci_lo: number | null;
  ci_hi: number | null;
  null_med: number | null;
  p: number | null;
  q: number | null;
  candidate: boolean | null;
}

export interface CatalystEvent {
  id: number;
  symbol: string;
  event_date: string;
  event_ts: string | null;
  source: string;
  type: string;
  detail: string | null;
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  avoid: "Avoid",
  positive: "Positive",
  watch: "Watch",
  none: "No effect",
  untested: "Untested",
};

export const SOURCE_LABEL: Record<string, string> = {
  edgar: "SEC filing",
  earnings: "Earnings",
  going_concern: "Going concern",
  news: "News",
  corporate_actions: "Corp. action",
  form4: "Insider",
};

export async function fetchCatalystTypes(): Promise<Map<string, CatalystType>> {
  const { data } = await supabase.from("research_catalyst_types").select("*");
  return new Map((data ?? []).map((t: CatalystType) => [t.type, t]));
}

export async function fetchCatalystTests(): Promise<CatalystTest[]> {
  const { data } = await supabase.from("research_catalyst_tests").select("*");
  return (data ?? []) as CatalystTest[];
}

export function pct(v: number | null | undefined, digits = 2): string {
  if (v == null || Number.isNaN(v)) return "—";
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`;
}
