import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { stageAndPromote, promotePending, type Direction } from "./lib/confluenceGate";

/**
 * HTTP entry point for the confluence gate, used by the realtime worker
 * (which runs outside Netlify and can't import the lib directly). eod-scan
 * and intraday-scan call lib/confluenceGate.ts in-process instead.
 *
 * POST with a single fire to stage + promote:
 *   { "symbol_id": 1, "trigger_id": 9, "direction": "long",
 *     "snapshot": {...}, "trade_date": "2026-09-08" }
 * POST with an empty body just runs a promotion sweep over whatever is
 * already pending (harmless no-op if nothing has reached confluence).
 *
 * Not scheduled. Like deep-dive.ts it accepts unauthenticated POSTs from
 * the Postgres webhook / the worker — it only ever reads/writes rows the
 * caller could already write with the service-role key, and promotion is
 * idempotent.
 */
export default async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const db = getSupabaseAdmin();

  let body: {
    symbol_id?: number;
    trigger_id?: number;
    direction?: Direction;
    snapshot?: unknown;
    trade_date?: string;
    source?: string;
  } = {};
  try {
    body = await req.json();
  } catch {
    // empty body -> promotion sweep only
  }

  let promoted;
  if (body.symbol_id && body.trigger_id && body.direction) {
    const tradeDate = body.trade_date ?? new Date().toISOString().slice(0, 10);
    promoted = await stageAndPromote(
      db,
      [
        {
          symbol_id: body.symbol_id,
          trigger_id: body.trigger_id,
          direction: body.direction,
          snapshot: body.snapshot ?? {},
        },
      ],
      { source: body.source ?? "worker", tradeDate },
    );
  } else {
    promoted = await promotePending(db);
  }

  return new Response(JSON.stringify({ promoted: promoted.length, events: promoted }), {
    headers: { "Content-Type": "application/json" },
  });
};
