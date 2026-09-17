import { getSupabaseAdmin } from "./lib/supabaseAdmin";
import { withJobRun } from "./lib/jobRun";
import { sendDigest } from "./lib/notify";
import { SITE_URL, symbolUrl, triggerDisplayName, type DiscordEmbed } from "./lib/discordEmbed";
import { etDateString, etWallClock } from "./lib/etTime";

/**
 * After-close "next-day targets" digest. eod-scan tags every event it
 * promotes with snapshot.delivery = "digest"; deep-dive still builds each
 * dossier (the site and this ranking use it) but sends no card. This job
 * then posts ONE ranked Discord card: the top buy setups by dossier score,
 * one line per stock with every setup it hit, plus every avoid warning.
 *
 * Runs on launchd at 18:10 ET weekdays, after eod-scan (17:45, ~3-4 min)
 * and its deep-dive webhooks have finished. Idempotent per day.
 */

const TOP_N = 15;
const BUY_COLOR = 0x2ecc71;

type DigestResult = { sent: boolean; reason?: string; targets?: number; qualified?: number; avoid?: number };

type Row = {
  id: number;
  symbol_id: number;
  snapshot: Record<string, unknown> | null;
  symbols: { ticker: string } | null;
  triggers: { name: string; category: string | null; direction: string | null } | null;
  dossiers: { score: number | null; analysis: Record<string, unknown> | null }[] | null;
};

export default async () => {
  const db = getSupabaseAdmin();

  const result = await withJobRun(db, "eod-digest", async (): Promise<{ rowsProcessed: number; result: DigestResult }> => {
    const today = etDateString(Date.now());
    const since = new Date(etWallClock(today, 0, 0)).toISOString();

    // Already sent today? (a manual re-run must not post a second digest)
    const { data: prior } = await db
      .from("job_runs")
      .select("id")
      .eq("job_name", "eod-digest")
      .eq("status", "ok")
      .gt("rows_processed", 0)
      .gte("started_at", since)
      .limit(1);
    if (prior?.length) return { rowsProcessed: 0, result: { sent: false, reason: "already sent today" } };

    const { data, error } = await db
      .from("trigger_events")
      .select(
        "id, symbol_id, snapshot, symbols(ticker), triggers(name, category, direction), dossiers(score, analysis)",
      )
      .gte("ts", since)
      .eq("snapshot->>delivery", "digest")
      .order("ts", { ascending: true });
    if (error) throw error;
    const rows = (data as unknown as Row[] | null) ?? [];
    if (!rows.length) return { rowsProcessed: 0, result: { sent: false, reason: "no digest events today" } };

    const priceOf = (r: Row): number | null => {
      const p = r.dossiers?.[0]?.analysis?.price as unknown;
      const v =
        p != null && typeof p === "object"
          ? ((p as Record<string, unknown>).last ?? (p as Record<string, unknown>).current)
          : (p ?? r.snapshot?.close ?? r.snapshot?.last_close);
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const setupsOf = (r: Row): string[] => {
      const conf = r.snapshot?.confluence as { triggers?: { name: string | null }[] } | undefined;
      const names = (conf?.triggers ?? []).map((t) => t.name).filter((n): n is string => !!n);
      return names.length ? names : r.triggers?.name ? [r.triggers.name] : [];
    };

    // One line per stock: merge its setups, keep its best score.
    type Line = { ticker: string; price: number | null; score: number; setups: Set<string> };
    const buys = new Map<number, Line>();
    const avoids = new Map<number, Line>();
    for (const r of rows) {
      const ticker = r.symbols?.ticker;
      if (!ticker) continue;
      const isAvoid = r.triggers?.category === "avoid";
      const isBuy = !isAvoid && r.triggers?.direction !== "short" && r.triggers?.category !== "exit";
      if (!isAvoid && !isBuy) continue;
      const target = isAvoid ? avoids : buys;
      const score = Number(r.dossiers?.[0]?.score ?? 0);
      const line = target.get(r.symbol_id) ?? { ticker, price: priceOf(r), score, setups: new Set<string>() };
      line.score = Math.max(line.score, score);
      for (const s of setupsOf(r)) line.setups.add(s);
      target.set(r.symbol_id, line);
    }

    const fmt = (l: Line) =>
      `[**${l.ticker}**](${symbolUrl(l.ticker)})${l.price != null ? ` $${l.price.toFixed(2)}` : ""} · ${[...l.setups]
        .map(triggerDisplayName)
        .join(", ")}${l.score ? ` · score ${l.score.toFixed(2)}` : ""}`;

    const ranked = [...buys.values()].sort((a, b) => b.score - a.score);
    const top = ranked.slice(0, TOP_N);
    const avoidLines = [...avoids.values()];

    const sections: string[] = [];
    sections.push(
      top.length
        ? `**Targets — top ${top.length} of ${ranked.length}**\n${top.map((l, i) => `${i + 1}. ${fmt(l)}`).join("\n")}`
        : "**Targets**\nNo buy setups qualified today.",
    );
    if (avoidLines.length) sections.push(`🔴 **Avoid**\n${avoidLines.map(fmt).join("\n")}`);

    const embed: DiscordEmbed = {
      title: `Next-day targets · ${today}`,
      url: SITE_URL,
      color: BUY_COLOR,
      description: sections.join("\n\n"),
      footer: { text: "RIOT · after-close digest · research alert, not investment advice" },
      timestamp: new Date().toISOString(),
    };
    const text = `Next-day targets ${today}\n${top.map((l) => l.ticker).join(", ")}`;
    const sent = await sendDigest(text, embed);

    return {
      rowsProcessed: sent === "sent" ? top.length + avoidLines.length : 0,
      result: { sent: sent === "sent", targets: top.length, qualified: ranked.length, avoid: avoidLines.length },
    };
  });

  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
};
