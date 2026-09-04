/**
 * Single source of truth for how triggers are presented to a non-technical
 * reader — label, category, and plain-English descriptions. Used by
 * DossierCard, TriggerFeed, and the About page, so relabeling a trigger or
 * adding a new one only has to happen in one place.
 *
 * Deliberately separate from each trigger's `description` column in
 * Supabase: that text is written for the engineering/research audience
 * (exact thresholds, why a threshold was chosen) — this is written for
 * "what does this mean for me."
 */

export interface TriggerInfo {
  label: string;
  category: string;
  categoryLabel: string;
  /** One line — used in compact contexts (dossier header, feed tooltip). */
  summary: string;
  /** A paragraph — used on the About page. */
  detail: string;
}

export const TRIGGER_INFO: Record<string, TriggerInfo> = {
  momentum_rank_entry: {
    label: "Top Performer",
    category: "momentum",
    categoryLabel: "Momentum",
    summary: "One of the strongest performers in the tracked group over the past year.",
    detail:
      "Ranks every tracked stock by its price gain over the last 12 months, excluding the most recent month — very recent moves tend to reverse, so they're set aside. Fires when a stock lands in the top 5% of that ranking, and only while the overall market is in a healthy uptrend.",
  },
  earnings_surprise_drift: {
    label: "Earnings Beat Follow-Through",
    category: "earnings",
    categoryLabel: "Earnings",
    summary: "Company beat earnings expectations by a wide margin, and stocks like this tend to keep drifting up for months afterward.",
    detail:
      "Looks for a large, unexpected earnings beat. Research shows the market is often slow to fully price in a surprise like this, so the stock tends to keep drifting in the same direction for months after the report. Currently inactive on this project — it needs an analyst-estimates data source that isn't connected yet.",
  },
  bb_rsi_confluence_long: {
    label: "Oversold Bounce Setup",
    category: "technical",
    categoryLabel: "Technical Setup",
    summary: "Price has dropped further and faster than usual — a classic setup for a short-term bounce back up.",
    detail:
      "Combines two measures of how stretched a price move is: how far price has strayed from its recent average, and how sharply it's fallen in just the last couple of days. When both point to an unusually oversold condition, this fires as a potential short-term bounce.",
  },
  bb_rsi_confluence_short: {
    label: "Overbought Pullback Setup",
    category: "technical",
    categoryLabel: "Technical Setup",
    summary: "Price has risen further and faster than usual — a classic setup for a short-term pullback.",
    detail: "The mirror image of the Oversold Bounce Setup: fires when a stock looks unusually overbought, a common precursor to at least a short-term pullback.",
  },
  realtime_outlier_zscore: {
    label: "Unusual Price Move",
    category: "outlier",
    categoryLabel: "Real-Time Alert",
    summary: "A single trade just printed a price move far outside this stock's normal moment-to-moment behavior.",
    detail:
      "Watches live trades as they happen, not on a delay, and flags any single trade that moves the price much more than that stock has typically been moving lately. Built to catch sudden, unusual activity the instant it happens rather than finding out about it later.",
  },
  volatility_squeeze_breakout_long: {
    label: "Breakout After Quiet Period (Up)",
    category: "breakout",
    categoryLabel: "Breakout",
    summary: "This stock has been unusually quiet for months, and just broke out to the upside on strong volume.",
    detail:
      "A stretch of unusually low price movement — a 'squeeze' — often precedes a big move once it ends. Fires when a stock's recent volatility is near its lowest point in six months, and it just broke upward out of that quiet range on well-above-average trading volume.",
  },
  volatility_squeeze_breakout_short: {
    label: "Breakout After Quiet Period (Down)",
    category: "breakout",
    categoryLabel: "Breakout",
    summary: "This stock has been unusually quiet for months, and just broke down on strong volume.",
    detail: "The downside version of the Breakout After Quiet Period setup — same squeeze condition, breaking out lower instead of higher.",
  },
  momentum_breakout: {
    label: "New High Breakout",
    category: "breakout",
    categoryLabel: "Breakout",
    summary: "Stock just hit a fresh 20-day high with unusually strong short-term momentum and volume.",
    detail:
      "A faster, shorter-horizon cousin of Top Performer. Instead of ranking 12 months of performance, this looks for a fresh price high over just the last 20 trading days, combined with strong recent momentum and above-average volume to help confirm it's a real move rather than noise.",
  },
  macd_bullish_cross: {
    label: "Trend Turning Up",
    category: "breakout",
    categoryLabel: "Breakout",
    summary: "A widely-used trend indicator just flipped from bearish to bullish.",
    detail:
      "Tracks the relationship between a stock's short-term and longer-term average price trend. When the short-term trend crosses above the longer-term one, it's historically read as an early signal the trend is turning upward.",
  },
  macd_bearish_cross: {
    label: "Trend Turning Down",
    category: "breakout",
    categoryLabel: "Breakout",
    summary: "A widely-used trend indicator just flipped from bullish to bearish.",
    detail: "The mirror image of Trend Turning Up — the short-term trend crossed below the longer-term one, an early signal the trend may be turning downward.",
  },
  momentum_exit: {
    label: "Exit Signal: Momentum Fading",
    category: "exit",
    categoryLabel: "Exit Signal",
    summary: "A stock that previously triggered a momentum entry is showing signs its run may be over.",
    detail:
      "Automatically tracks stocks after they trigger Top Performer or New High Breakout, and watches for signs the move has run its course: its momentum ranking has fallen out of the top third, it just had an unusually bad week, or it's been held for more than 180 days — research shows momentum trades tend to lose their edge beyond that window.",
  },
};

export function triggerLabel(name: string): string {
  return TRIGGER_INFO[name]?.label ?? humanize(name);
}

export function triggerCategoryLabel(name: string): string {
  return TRIGGER_INFO[name]?.categoryLabel ?? humanize(name);
}

export function humanize(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
