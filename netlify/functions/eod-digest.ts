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

type DigestResult = { sent: boolean; reason?: string; targets?: number; qualified?: number; avoid?: number; watch?: number; catalysts?: number };

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

    // Upcoming catalysts within the next few sessions: earnings (FMP
    // calendar) and reverse splits (corporate_actions, synced daily from
    // Alpaca — see sync-corporate-actions.ts). Independent of whether any
    // trigger fired today, so it's fetched before the "nothing today"
    // bail below. Charter-filing (8-K 5.03/3.03) is deliberately left out
    // here: measured 2026-09-26 against full EDGAR history, it only
    // covers ~21% of splits and has a median 5-day lead when it leads at
    // all — too weak to post daily, still shown on the symbol page as a
    // low-confidence flag.
    const { data: upcoming } = await db
      .from("upcoming_catalysts")
      .select("ticker, close, days_to_earnings, days_to_reverse_split")
      .or("days_to_earnings.lte.5,days_to_reverse_split.lte.10")
      .order("days_to_earnings", { ascending: true, nullsFirst: false });
    const catalystLines = ((upcoming as { ticker: string; close: number | null; days_to_earnings: number | null; days_to_reverse_split: number | null }[] | null) ?? [])
      .map((r) => {
        const notes: string[] = [];
        if (r.days_to_earnings != null && r.days_to_earnings <= 5) notes.push(`earnings in ${r.days_to_earnings}d`);
        if (r.days_to_reverse_split != null && r.days_to_reverse_split <= 10) notes.push(`reverse split in ${r.days_to_reverse_split}d`);
        return `[**${r.ticker}**](${symbolUrl(r.ticker)})${r.close != null ? ` $${Number(r.close).toFixed(2)}` : ""} · ${notes.join(", ")}`;
      });

    if (!rows.length && !catalystLines.length) return { rowsProcessed: 0, result: { sent: false, reason: "no digest events or catalysts today" } };

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
    const watches = new Map<number, Line>();
    const avoids = new Map<number, Line>();
    for (const r of rows) {
      const ticker = r.symbols?.ticker;
      if (!ticker) continue;
      const isAvoid = r.triggers?.category === "avoid";
      const isBuy = !isAvoid && r.triggers?.direction !== "short" && r.triggers?.category !== "exit";
      if (!isAvoid && !isBuy) continue;
      // Buy / Watch / Sell: a watch trigger or a red-flagged buy goes to Watch.
      const flags = (r.dossiers?.[0]?.analysis?.risk_flags as { level: string }[] | undefined) ?? [];
      const isWatch = isBuy && (r.triggers?.category === "watch" || flags.some((f) => f.level === "red"));
      const target = isAvoid ? avoids : isWatch ? watches : buys;
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
    const watchLines = [...watches.values()].sort((a, b) => b.score - a.score).slice(0, TOP_N);
    if (watchLines.length) sections.push(`👀 **Watch** (setup, but a red flag or unproven direction)\n${watchLines.map(fmt).join("\n")}`);
    if (avoidLines.length) sections.push(`🔴 **Avoid**\n${avoidLines.map(fmt).join("\n")}`);
    if (catalystLines.length) sections.push(`📅 **Upcoming catalysts**\n${catalystLines.join("\n")}`);

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
      rowsProcessed: sent === "sent" ? top.length + avoidLines.length + watchLines.length + catalystLines.length : 0,
      result: { sent: sent === "sent", targets: top.length, qualified: ranked.length, avoid: avoidLines.length, watch: watchLines.length, catalysts: catalystLines.length },
    };
  });

  return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
};
