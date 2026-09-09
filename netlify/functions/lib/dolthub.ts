/**
 * Read-only client for the DoltHub SQL API against
 * `post-no-preference/earnings` — a free, weekly-updated, Zacks-derived
 * set of US-stock financial statements, estimates, and analyst ranks
 * (CC BY-SA 4.0).
 *
 * Public repos need no auth for reads. A DOLTHUB_TOKEN env var, if set,
 * is sent as `authorization: token …` — identifies the traffic and gets
 * more rate-limit headroom, but nothing here requires it.
 *
 * The API caps every response at 1,000 rows (`query_execution_status:
 * "RowLimit"`), so `doltQueryAll` paginates with LIMIT/OFFSET.
 */

const BASE = "https://www.dolthub.com/api/v1alpha1/post-no-preference/earnings/master";
const PAGE = 1000;

interface DoltResponse {
  query_execution_status: string;
  query_execution_message?: string;
  rows: Record<string, string | null>[];
}

function headers(): HeadersInit {
  const h: Record<string, string> = { Accept: "application/json" };
  const token = process.env.DOLTHUB_TOKEN;
  if (token) h.authorization = `token ${token}`;
  return h;
}

export async function doltQuery(sql: string): Promise<Record<string, string | null>[]> {
  const url = `${BASE}?q=${encodeURIComponent(sql)}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: headers() });
    if (res.status === 429 || res.status === 503) {
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1500));
      continue;
    }
    if (!res.ok) throw new Error(`DoltHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as DoltResponse;
    if (body.query_execution_status === "Error") {
      throw new Error(`DoltHub query error: ${body.query_execution_message}`);
    }
    return body.rows ?? [];
  }
  throw new Error("DoltHub: exhausted retries");
}

/**
 * Run `sql` (must NOT already contain LIMIT/OFFSET) and page past the
 * 1,000-row cap. `politeMs` sleeps between pages so a full sync stays a
 * good citizen on a small provider.
 */
export async function doltQueryAll(
  sql: string,
  { politeMs = 250 }: { politeMs?: number } = {},
): Promise<Record<string, string | null>[]> {
  const all: Record<string, string | null>[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await doltQuery(`${sql} LIMIT ${PAGE} OFFSET ${offset}`);
    all.push(...page);
    if (page.length < PAGE) break;
    if (politeMs) await new Promise((r) => setTimeout(r, politeMs));
  }
  return all;
}

/** Parse a Dolt decimal string to a number (null / "" -> null). */
export function n(v: string | null | undefined): number | null {
  if (v == null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}
