import type { SupabaseClient } from "@supabase/supabase-js";
import { clampEmbed, opsEmbed, type DiscordEmbed } from "./discordEmbed";
import { describeError } from "./jobRun";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * With an embed, the alert posts as its own card; the plain text is only a
 * fallback. A webhook takes ~5 posts per 2 s, and the 09:00 ET scan and
 * eod-scan fire dozens of alerts at once: before this retried, 23 of them
 * were marked failed on 2026-09-14/15. A 429 now waits for Discord's
 * retry_after and tries again (up to 6 times, jittered so the parallel
 * deep-dive invocations don't retry in lockstep).
 */
async function sendDiscord(text: string, embed?: DiscordEmbed) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return false;

  const body = JSON.stringify(embed ? { embeds: [clampEmbed(embed)] } : { content: text });
  let lastNetworkErr: unknown = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    let res: Response;
    try {
      res = await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    } catch (err) {
      // A network-level failure (socket hang-up, reset, DNS) throws instead
      // of returning a status, and used to escape this loop on the first
      // try — one alert in the 2026-09-15 eod burst was marked failed
      // immediately (sent_at null) while its neighbours retried a 429 and
      // sent fine. Treat it like a 5xx: back off and try again.
      lastNetworkErr = err;
      await sleep(1000 * 2 ** attempt + Math.random() * 500);
      continue;
    }
    if (res.ok) return true;
    if (res.status !== 429 && res.status < 500) {
      throw new Error(`Discord send failed: ${res.status} ${await res.text()}`);
    }
    let waitMs = 1000 * 2 ** attempt;
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const payload = (await res.json().catch(() => null)) as { retry_after?: number } | null;
      const secs = payload?.retry_after ?? (Number.isFinite(retryAfter) ? retryAfter : null);
      if (secs != null) waitMs = secs * 1000;
    }
    await sleep(waitMs + Math.random() * 500);
  }
  throw new Error(
    lastNetworkErr
      ? `Discord send failed after 6 attempts, last error: ${lastNetworkErr}`
      : "Discord send failed: still rate-limited after 6 attempts",
  );
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
    /** Discord card; Telegram always gets `message`. */
    embed?: DiscordEmbed;
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
    if (channel === "discord") await sendDiscord(params.message, params.embed);
    await db
      .from("alerts")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", alertRow.id);
    return { status: "sent" };
  } catch (err) {
    // Record WHY. Without this a failed row carried no cause at all, so the
    // 2026-09-15 CYPH failure and the eight on 2026-09-16 09:41 ET had to be
    // inferred from timing alone (Discord's status + body is in the thrown
    // message, and describeError keeps PostgrestError legible too).
    await db
      .from("alerts")
      .update({ status: "failed", error: describeError(err).slice(0, 2000) })
      .eq("id", alertRow.id);
    throw err;
  }
}

/**
 * A digest card (the after-close next-day targets). Like operational
 * alerts it bypasses the per-dossier alerts table: it summarises many
 * dossiers in one post.
 */
export async function sendDigest(text: string, embed: DiscordEmbed): Promise<"sent" | "skipped"> {
  const channel = channelFromEnv();
  if (!channel) return "skipped";
  if (channel === "telegram") await sendTelegram(text);
  if (channel === "discord") await sendDiscord(text, embed);
  return "sent";
}

/**
 * Operational alerts — infrastructure problems, not trade signals.
 * Deliberately bypasses the `alerts` table and its dedup/cooldown
 * machinery, which is keyed to dossiers and would be meaningless here.
 * Used by data-integrity-check; keep the volume low enough that seeing
 * one always means something.
 */
export async function sendOperationalAlert(text: string): Promise<"sent" | "skipped"> {
  const channel = channelFromEnv();
  if (!channel) return "skipped";
  if (channel === "telegram") await sendTelegram(text);
  if (channel === "discord") await sendDiscord(text, opsEmbed(text));
  return "sent";
}
