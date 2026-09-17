/**
 * Discord embeds for alerts: each alert is its own colored card instead
 * of a line of text in one long run. Only Discord uses these; Telegram
 * keeps the plain-text message.
 * https://discord.com/developers/docs/resources/message#embed-object
 */

export interface DiscordEmbed {
  title?: string;
  url?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  footer?: { text: string };
  timestamp?: string;
}

export const SITE_URL = "https://stackslash.netlify.app";

// Display names for triggers. Mirrors the labels in src/lib/triggerInfo.ts
// (the functions bundle can't import from src/); keep the two in step.
const LABELS: Record<string, string> = {
  realtime_outlier_zscore: "Unusual Price Move",
  bb_rsi_confluence_long: "Oversold Bounce Setup",
  bb_rsi_confluence_short: "Overbought Pullback Setup",
  macd_bullish_cross: "Trend Turning Up",
  macd_bearish_cross: "Trend Turning Down",
  volatility_squeeze_breakout_long: "Breakout After Quiet Period (Up)",
  volatility_squeeze_breakout_short: "Breakout After Quiet Period (Down)",
  earnings_surprise_drift: "Earnings Beat Follow-Through",
  momentum_exit: "Exit Signal: Momentum Fading",
  momentum_rank_entry: "Top Performer",
  momentum_breakout: "New High Breakout",
  catalyst_momentum: "News Catalyst Move",
  rvol_breakout: "Heavy Volume Breakout",
  vwap_reclaim: "VWAP Reclaim",
  gap_and_go: "Gap and Go",
  squeeze_release_intraday: "Squeeze Release (Intraday)",
  exit_warning: "Exit Warning",
  avoid_volume_blowoff: "Avoid: Volume Blow-off",
  avoid_chase_extended: "Avoid: Don't Chase",
  earnings_release: "Earnings Release",
  avoid_reverse_split: "Avoid: Reverse Split",
  bigmove_watchlist: "Big-Move Watchlist",
};

const SELL_TRIGGERS = new Set([
  "bb_rsi_confluence_short",
  "macd_bearish_cross",
  "volatility_squeeze_breakout_short",
  "momentum_exit",
  "exit_warning",
  "avoid_volume_blowoff",
  "avoid_chase_extended",
  "avoid_reverse_split",
]);

const COLOR = { buy: 0x2ecc71, watch: 0x3498db, sell: 0xe74c3c, high: 0xff6b00, ops: 0xf1c40f };

export function triggerDisplayName(name: string): string {
  return LABELS[name] ?? name.replace(/_/g, " ");
}

/** Card color: orange for high priority, red for sell-side triggers, green otherwise. */
export function alertColor(triggerName: string, highPriority: boolean): number {
  if (highPriority) return COLOR.high;
  return SELL_TRIGGERS.has(triggerName) ? COLOR.sell : COLOR.buy;
}

export function symbolUrl(ticker: string): string {
  return `${SITE_URL}/symbol/${encodeURIComponent(ticker)}`;
}

export interface AlertCard {
  ticker: string;
  triggerName: string;
  highPriority: boolean;
  /** Watch, not buy: a watch trigger, or a buy setup carrying a red flag. */
  watch?: boolean;
  price: number | null;
  /** Every trigger in confluence; listed only when there are 2+. */
  confluence: string[];
  flags: { level: string; label: string }[];
  /** Label/value rows for the aligned block (size, stop, fundamentals, score). */
  rows: [string, string][];
  news?: { headline: string; url?: string; ageHours?: number | null };
  /** Marks a formatting test so it can't be mistaken for a live signal. */
  sample?: boolean;
}

// Same-size markers: the colored circles render at one size on every
// platform; the 🟥🟨🟩 squares didn't on iOS Discord.
const FLAG_ICON: Record<string, string> = { red: "🔴", amber: "🟡", green: "🟢" };

/**
 * One alert card. The numbers sit in a monospace block, the only way
 * Discord keeps columns aligned (it has no tables, and it stacks inline
 * fields on phones). Kept under ~32 characters wide to fit a phone.
 */
export function buildAlertEmbed(a: AlertCard): DiscordEmbed {
  const order = { red: 0, amber: 1, green: 2 } as Record<string, number>;
  const flags = [...a.flags].sort((x, y) => (order[x.level] ?? 3) - (order[y.level] ?? 3));
  const width = Math.max(0, ...a.rows.map(([k]) => k.length)) + 2;
  const table = a.rows.length ? "```\n" + a.rows.map(([k, v]) => k.padEnd(width) + v).join("\n") + "\n```" : null;
  const age = a.news?.ageHours;
  const ageText = age != null ? ` · ${age < 1 ? "<1h" : `${Math.round(age)}h`} ago` : "";
  const headline = a.news?.headline.slice(0, 200);
  return {
    title: `${a.sample ? "SAMPLE · " : ""}${a.highPriority ? "🔴 HIGH PRIORITY · " : ""}${a.watch ? "👀 WATCH · " : ""}${a.ticker} · ${triggerDisplayName(a.triggerName)}`,
    url: symbolUrl(a.ticker),
    color: a.watch && !a.highPriority ? COLOR.watch : alertColor(a.triggerName, a.highPriority),
    description: [
      a.price != null ? `**$${a.price.toFixed(2)}**` : null,
      a.confluence.length > 1
        ? `**${a.confluence.length} signals:** ${a.confluence.map(triggerDisplayName).join(", ")}`
        : null,
      flags.length ? flags.map((f) => `${FLAG_ICON[f.level] ?? "⚪"} ${f.label}`).join("\n") : null,
      table,
      headline ? `📰 ${a.news?.url ? `[${headline}](${a.news.url})` : headline}${ageText}` : null,
    ]
      .filter(Boolean)
      .join("\n\n"),
    footer: {
      text: `RIOT · research alert, not investment advice${a.sample ? " · SAMPLE (formatting test, not a live signal)" : ""}`,
    },
    timestamp: new Date().toISOString(),
  };
}

/** Operational (infrastructure) alert as an amber card: first line is the title, the rest the body. */
export function opsEmbed(text: string): DiscordEmbed {
  const [first, ...rest] = text.split("\n");
  return {
    title: first.replace(/\*\*/g, "").slice(0, 256),
    description: rest.join("\n").slice(0, 4000) || undefined,
    color: COLOR.ops,
    timestamp: new Date().toISOString(),
  };
}

/** Enforce Discord's size limits so an oversized field never fails the send. */
export function clampEmbed(e: DiscordEmbed): DiscordEmbed {
  return {
    ...e,
    title: e.title?.slice(0, 256),
    description: e.description?.slice(0, 4000),
    fields: e.fields?.slice(0, 25).map((f) => ({ ...f, name: f.name.slice(0, 256), value: f.value.slice(0, 1024) || "—" })),
  };
}
