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
};

const SELL_TRIGGERS = new Set([
  "bb_rsi_confluence_short",
  "macd_bearish_cross",
  "volatility_squeeze_breakout_short",
  "momentum_exit",
]);

const COLOR = { buy: 0x2ecc71, sell: 0xe74c3c, high: 0xff6b00, ops: 0xf1c40f };

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
