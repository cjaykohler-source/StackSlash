import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { dispatchAlert } from "./lib/notify";

/**
 * Job C — deep-dive worker.
 *
 * HTTP-triggered (not scheduled) — wire this up as a Supabase Database
 * Webhook: Database > Webhooks > new webhook on `trigger_events`, event
 * "Insert", HTTP target = this function's deployed URL
 * (https://<site>.netlify.app/.netlify/functions/deep-dive). Supabase
 * posts the new row as { record: {...} } in the body.
 *
 * Given a trigger_event, this pulls context, scores conviction, writes a
 * dossier explaining *why* it fired, and dispatches an alert (dedup'd).
 *
 * The scoring here is intentionally simple to start — replace with the
 * real skew-adjusted-expectation / multi-signal-confirmation logic once
 * there's enough trigger_evaluations history to justify it. The point of
 * this scaffold is the plumbing (event -> context -> score -> dossier ->
 * dedup'd alert), not a finished model.
 */
export default async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const db = getSupabaseAdmin();
  const body = (await req.json()) as { record?: { id: number } } | { trigger_event_id?: number };
  const triggerEventId =
    "record" in body ? body.record?.id : (body as { trigger_event_id?: number }).trigger_event_id;

  if (!triggerEventId) {
    return new Response("Missing trigger_event id", { status: 400 });
  }

  const { data: event, error } = await db
    .from("trigger_events")
    .select("id, snapshot, symbol_id, trigger_id, symbols(ticker), triggers(name, cooldown_minutes)")
    .eq("id", triggerEventId)
    .single();
  if (error || !event) {
    return new Response(`trigger_event not found: ${error?.message ?? triggerEventId}`, { status: 404 });
  }

  const ticker = (event as unknown as { symbols: { ticker: string } | null }).symbols?.ticker ?? "?";
  const triggerName =
    (event as unknown as { triggers: { name: string; cooldown_minutes: number } | null }).triggers?.name ??
    "unknown trigger";
  const cooldownMinutes =
    (event as unknown as { triggers: { name: string; cooldown_minutes: number } | null }).triggers
      ?.cooldown_minutes ?? 1440;

  // Placeholder scoring: momentum_rank_pct as a stand-in conviction score
  // when present, else neutral. Replace with real logic per the design doc.
  const snapshot = event.snapshot as Record<string, unknown>;
  const score = typeof snapshot.momentum_rank_pct === "number" ? snapshot.momentum_rank_pct : 0.5;

  const analysis = {
    trigger: triggerName,
    ticker,
    fired_on: snapshot,
    note: "Placeholder analysis — replace with real multi-signal confirmation logic.",
  };

  const { data: dossier, error: dossierError } = await db
    .from("dossiers")
    .insert({
      trigger_event_id: event.id,
      symbol_id: event.symbol_id,
      analysis,
      score,
    })
    .select("id")
    .single();
  if (dossierError) throw dossierError;

  await db.from("trigger_events").update({ status: "dossier_ready" }).eq("id", event.id);

  const alertResult = await dispatchAlert(db, {
    dossierId: dossier.id,
    dedupKey: `${event.trigger_id}:${event.symbol_id}`,
    cooldownMinutes,
    message: `*${ticker}* — ${triggerName}\nscore: ${score.toFixed(2)}`,
  });

  if (alertResult.status === "sent") {
    await db.from("trigger_events").update({ status: "alerted" }).eq("id", event.id);
  }

  return new Response(JSON.stringify({ dossierId: dossier.id, alert: alertResult }), {
    headers: { "Content-Type": "application/json" },
  });
};
