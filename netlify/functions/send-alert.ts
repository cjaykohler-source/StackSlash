import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { dispatchAlert } from "./lib/notify";

/**
 * Manual/test alert dispatch: POST { dossier_id } to re-run delivery for
 * an existing dossier (e.g. while testing Telegram/Discord wiring, or to
 * retry a "failed" alert). deep-dive.ts calls dispatchAlert directly in
 * the normal flow — this endpoint exists so you can trigger a send
 * without going through the full pipeline.
 */
export default async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const db = getSupabaseAdmin();
  const { dossier_id: dossierId } = (await req.json()) as { dossier_id?: number };
  if (!dossierId) {
    return new Response("Missing dossier_id", { status: 400 });
  }

  const { data: dossier, error } = await db
    .from("dossiers")
    .select("id, score, analysis, symbol_id, trigger_event_id, symbols(ticker)")
    .eq("id", dossierId)
    .single();
  if (error || !dossier) {
    return new Response(`dossier not found: ${error?.message ?? dossierId}`, { status: 404 });
  }

  const { data: event } = await db
    .from("trigger_events")
    .select("trigger_id, triggers(name, cooldown_minutes)")
    .eq("id", dossier.trigger_event_id)
    .single();

  const ticker = (dossier as unknown as { symbols: { ticker: string } | null }).symbols?.ticker ?? "?";
  const triggerName =
    (event as unknown as { triggers: { name: string } } | null)?.triggers?.name ?? "unknown trigger";
  const cooldownMinutes =
    (event as unknown as { triggers: { cooldown_minutes: number } } | null)?.triggers?.cooldown_minutes ?? 1440;

  const result = await dispatchAlert(db, {
    dossierId: dossier.id,
    dedupKey: `${event?.trigger_id}:${dossier.symbol_id}`,
    cooldownMinutes,
    message: `*${ticker}* — ${triggerName}\nscore: ${dossier.score ?? "—"}`,
  });

  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
};
