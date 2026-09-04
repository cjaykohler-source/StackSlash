import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Alert delivery, kept as one abstraction so a new channel (email, SMS)
 * only needs a new branch here — nothing upstream changes.
 */

async function sendTelegram(text: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return false;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
  });
  if (!res.ok) {
    throw new Error(`Telegram send failed: ${res.status} ${await res.text()}`);
  }
  return true;
}

async function sendDiscord(text: string) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return false;

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: text }),
  });
  if (!res.ok) {
    throw new Error(`Discord send failed: ${res.status} ${await res.text()}`);
  }
  return true;
}

function channelFromEnv(): "telegram" | "discord" | null {
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) return "telegram";
  if (process.env.DISCORD_WEBHOOK_URL) return "discord";
  return null;
}

/**
 * Sends an alert for a dossier, respecting the dedup/cooldown window.
 * `dedupKey` should be stable per (trigger, symbol) — e.g. `${triggerId}:${symbolId}`.
 * The unique index on alerts(dedup_key, channel) is the hard backstop;
 * this also checks cooldown_minutes so re-fires within the window are
 * skipped even before hitting the DB constraint.
 */
export async function dispatchAlert(
  db: SupabaseClient,
  params: {
    dossierId: number;
    dedupKey: string;
    cooldownMinutes: number;
    message: string;
  },
): Promise<{ status: "sent" | "skipped" | "failed"; reason?: string }> {
  const channel = channelFromEnv();
  if (!channel) {
    return { status: "skipped", reason: "no alert channel configured" };
  }

  const cutoff = new Date(Date.now() - params.cooldownMinutes * 60 * 1000).toISOString();
  const { data: recent } = await db
    .from("alerts")
    .select("id")
    .eq("dedup_key", params.dedupKey)
    .eq("channel", channel)
    .gte("created_at", cutoff)
    .limit(1);

  if (recent && recent.length > 0) {
    return { status: "skipped", reason: "within cooldown window" };
  }

  const { data: alertRow, error: insertError } = await db
    .from("alerts")
    .insert({
      dossier_id: params.dossierId,
      channel,
      dedup_key: params.dedupKey,
      status: "pending",
    })
    .select("id")
    .single();

  if (insertError) {
    // Unique constraint violation on (dedup_key, channel) means another
    // process already sent this — treat as a skip, not an error.
    if (insertError.code === "23505") {
      return { status: "skipped", reason: "duplicate dedup_key" };
    }
    throw insertError;
  }

  try {
    if (channel === "telegram") await sendTelegram(params.message);
    if (channel === "discord") await sendDiscord(params.message);
    await db
      .from("alerts")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", alertRow.id);
    return { status: "sent" };
  } catch (err) {
    await db
      .from("alerts")
      .update({ status: "failed" })
      .eq("id", alertRow.id);
    throw err;
  }
}
