import { supabase } from "./supabaseClient";

/**
 * Client for the Charter API (research/charter_api/server.py), a read-only
 * query service over the local research warehouse. Every request carries
 * the signed-in user's Supabase access token; the API verifies it and only
 * serves allow-listed accounts.
 *
 * The API runs on the research Mac. Locally it's http://127.0.0.1:8787;
 * the live site reaches it through a tunnel (VITE_CHARTER_API_URL).
 */
export const CHARTER_API_URL: string =
  (import.meta.env.VITE_CHARTER_API_URL as string | undefined) ?? "http://127.0.0.1:8787";

export interface Columnar {
  columns: string[];
  data: Record<string, (number | string | null)[]>;
  rows: number;
}

export interface MetricDef {
  id: string;
  label: string;
  group: string;
  unit: "price" | "pct" | "ratio" | "count" | "shares" | "usd" | "index";
  kind: "daily" | "series";
  source: string;
  since: string;
  desc: string;
}

export class CharterApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function authHeader(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new CharterApiError(401, "Sign in to use Charter.");
  return { Authorization: `Bearer ${token}` };
}

function url(path: string, params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") q.set(k, v);
  return `${CHARTER_API_URL}${path}?${q.toString()}`;
}

export async function charterGet<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url(path, params), { headers: await authHeader() });
  } catch {
    throw new CharterApiError(
      0,
      `Can't reach the Charter API at ${CHARTER_API_URL}. It runs on the research Mac — start it with scripts/run-charter-api.sh (or check the launchd job on the Ops page).`,
    );
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new CharterApiError(res.status, body.error ?? `HTTP ${res.status}`);
  return body as T;
}

/** Download an endpoint's CSV export as a file. */
export async function charterDownloadCsv(path: string, params: Record<string, string | undefined>, filename: string) {
  const res = await fetch(url(path, { ...params, format: "csv" }), { headers: await authHeader() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new CharterApiError(res.status, body.error ?? `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Rows of a columnar result as objects. */
export function rowsOf(c: Columnar): Record<string, number | string | null>[] {
  const out: Record<string, number | string | null>[] = [];
  for (let i = 0; i < c.rows; i++) {
    const r: Record<string, number | string | null> = {};
    for (const col of c.columns) r[col] = c.data[col][i];
    out.push(r);
  }
  return out;
}

export function fmtValue(v: number | null | undefined, unit: MetricDef["unit"] | undefined): string {
  if (v == null || Number.isNaN(v)) return "—";
  switch (unit) {
    case "pct":
      return `${(v * 100).toFixed(2)}%`;
    case "price":
      return v >= 1 ? v.toFixed(2) : v.toFixed(4);
    case "usd":
      return Math.abs(v) >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${Math.round(v).toLocaleString()}`;
    case "shares":
    case "count":
      return Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : Math.round(v).toLocaleString();
    default:
      return v.toFixed(3);
  }
}
