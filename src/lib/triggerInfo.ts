/**
 * Single source of truth for how triggers are presented to a non-technical
 * reader — label, category, and plain-English descriptions. Used by
 * DossierCard, TriggerFeed, SymbolProfile and the About page, so relabeling
 * a trigger or adding a new one only has to happen in one place.
 *
 * Deliberately separate from each trigger's `description` column in
 * Supabase: that text is written for the engineering/research audience —
 * this is written for "what does this mean for me." The `conditions` lists
 * mirror each trigger's `definition` in the triggers table (checked
 * 2026-09-14); keep them in step when a definition changes.
 */

export type TriggerTiming = "realtime" | "daily" | "intraday" | "exit";

export interface TriggerInfo {
  label: string;
  category: string;
  categoryLabel: string;
  /** When it is evaluated. */
  timing: TriggerTiming;
  /** One line — used in compact contexts (dossier header, feed tooltip). */
  summary: string;
  /** Every condition that must hold for it to fire, in plain English. */
  conditions: string[];
  /** Optional extra context — used on the About page. */
  detail?: string;
  /** Why a disabled trigger is off (About page). */
  offReason?: string;
}

const RISK_ON = "The overall market is risk-on (SPY above its 200-day average).";

export const TRIGGER_INFO: Record<string, TriggerInfo> = {
  realtime_outlier_zscore: {
    label: "Unusual Price Move",
    category: "outlier",
    categoryLabel: "Real-Time Alert",
    timing: "realtime",
    summary: "A single trade just moved the price far outside this stock's normal moment-to-moment behavior.",
    conditions: [
      "Watches every trade on the live feed as it happens.",
      "Fires when one trade's price change is 3 or more standard deviations away from that stock's recent normal.",
    ],
    detail:
      "\"Recent normal\" is a rolling, volatility-weighted average of the stock's own trade-to-trade moves, so a normally jumpy stock needs a bigger move to trip it than a quiet one. Built to catch sudden activity the instant it happens.",
  },
  bb_rsi_confluence_long: {
    label: "Oversold Bounce Setup",
    category: "technical",
    categoryLabel: "Technical Setup",
    timing: "daily",
    summary: "Price just dropped to the bottom of its normal range after a sharp two-day slide, a classic short-term bounce setup.",
    conditions: [
      "Price is at or below the lower Bollinger Band (the bottom 5% of its usual 20-day range).",
      "2-day RSI is 10 or lower, meaning the last two days were an unusually sharp drop.",
      RISK_ON,
    ],
    detail: "The intraday scan only checks this on stocks already in the top third for momentum.",
  },
  macd_bullish_cross: {
    label: "Trend Turning Up",
    category: "breakout",
    categoryLabel: "Breakout",
    timing: "daily",
    summary: "A widely used trend indicator just flipped from bearish to bullish.",
    conditions: [
      "The MACD line (12/26-day) crosses above its 9-day signal line.",
      RISK_ON,
    ],
    detail:
      "MACD compares a short-term and a longer-term average of price. When the short one overtakes the long one, it's read as an early sign the trend is turning up. Uses the textbook default settings.",
  },
  volatility_squeeze_breakout_long: {
    label: "Breakout After Quiet Period (Up)",
    category: "breakout",
    categoryLabel: "Breakout",
    timing: "daily",
    summary: "An unusually quiet stock just broke out upward on heavy volume.",
    conditions: [
      "Bollinger Band width is in the bottom 10% of its own last 6 months (a squeeze).",
      "Price closes at or above the upper band.",
      "Volume is at least 2× its 20-day average.",
      RISK_ON,
    ],
    detail: "A long stretch of unusually small moves often ends with a big one. This catches the first day of the break upward.",
  },
  volatility_squeeze_breakout_short: {
    label: "Breakout After Quiet Period (Down)",
    category: "breakout",
    categoryLabel: "Breakout",
    timing: "daily",
    summary: "An unusually quiet stock just broke down on heavy volume.",
    conditions: [
      "Bollinger Band width is in the bottom 10% of its own last 6 months (a squeeze).",
      "Price closes at or below the lower band.",
      "Volume is at least 2× its 20-day average.",
    ],
    detail: "The downside version of the squeeze breakout. Unlike the upside version, it has no market-regime filter.",
  },
  earnings_surprise_drift: {
    label: "Earnings Beat Follow-Through",
    category: "earnings",
    categoryLabel: "Earnings",
    timing: "daily",
    summary: "The company beat earnings estimates by a wide margin, and stocks like this tend to keep drifting up afterward.",
    conditions: [
      "The latest reported earnings per share beat analyst estimates by 10% or more.",
      "The report came out 1 to 60 days ago.",
      RISK_ON,
    ],
    detail:
      "Markets are often slow to fully price in a big surprise. There is no backtest record yet: historical earnings surprises aren't in the data, so this can only be judged on live fires.",
    offReason:
      "Turned off for this scanner: it fires about 22 times a day, but never on a stock inside the price band — the cheapest was $5.83 — so it has never produced a single alert.",
  },
  momentum_exit: {
    label: "Exit Signal: Momentum Fading",
    category: "exit",
    categoryLabel: "Exit Signal",
    timing: "exit",
    summary: "A stock that earlier triggered a momentum entry is showing signs its run is over.",
    conditions: [
      "Its momentum rank has dropped out of the top third, or",
      "it just had a bottom-10% week (a sharp reversal), or",
      "it has been held for more than 180 days.",
    ],
    detail:
      "Only follows positions opened by Top Performer or New High Breakout. Both of those are currently off, so this has nothing new to follow.",
  },
  exit_warning: {
    label: "Exit Warning",
    category: "exit",
    categoryLabel: "Exit Signal",
    timing: "exit",
    summary: "A stock you got a buy alert on just hit its exit: stop, take profit, trailing stop, or time limit.",
    conditions: [
      "It got a buy alert, and since then one of these happened:",
      "price fell 12% below the alert price (stop),",
      "price rose 10% above it (take profit),",
      "it rose at least 5% and then gave back 5% from its high (trailing stop), or",
      "10 days have passed (time limit).",
    ],
    detail:
      "Checked every 5 minutes during the session. The levels come from Settings: stop %, take-profit %, trail %, and the swing time limit.",
  },
  avoid_volume_blowoff: {
    label: "Avoid: Volume Blow-off",
    category: "avoid",
    categoryLabel: "Avoid",
    timing: "daily",
    summary: "Trading at 25x or more its normal volume, historically the setup that goes worst.",
    conditions: [
      "Priced between $0.10 and $5, with at least $50k of normal daily dollar volume.",
      "Today's volume is at least 25× its 20-day average.",
    ],
    detail:
      "In backtests, stocks at 25× normal volume averaged −10% (median −16%) over the next 18 sessions, while every lower volume bucket was roughly break-even. It's a warning to stay out or get out, not a short signal.",
  },
  bb_rsi_confluence_short: {
    label: "Overbought Pullback Setup",
    category: "technical",
    categoryLabel: "Technical Setup",
    timing: "daily",
    summary: "Price just pushed to the top of its normal range after a sharp two-day run, a classic short-term pullback setup.",
    conditions: [
      "Price is at or above the upper Bollinger Band (the top 5% of its usual 20-day range).",
      "2-day RSI is 90 or higher.",
    ],
    offReason: "Shorting \"overbought\" sub-$5 stocks tested as a net loser.",
  },
  macd_bearish_cross: {
    label: "Trend Turning Down",
    category: "breakout",
    categoryLabel: "Breakout",
    timing: "daily",
    summary: "A widely used trend indicator just flipped from bullish to bearish.",
    conditions: ["The MACD line (12/26-day) crosses below its 9-day signal line."],
    offReason: "Shorting on this signal tested as a net loser in this price band.",
  },
  momentum_rank_entry: {
    label: "Top Performer",
    category: "momentum",
    categoryLabel: "Momentum",
    timing: "daily",
    summary: "One of the strongest performers in the tracked group over the past year.",
    conditions: [
      "Ranks in the top 5% of all tracked stocks by 12-month return, leaving out the most recent month (very recent moves tend to reverse).",
      RISK_ON,
    ],
    offReason: "Lost money at every holding period tested, and the top-5% cutoff is rarely reachable in this universe.",
  },
  momentum_breakout: {
    label: "New High Breakout",
    category: "breakout",
    categoryLabel: "Breakout",
    timing: "daily",
    summary: "The stock just closed at a fresh 20-day high with unusually strong short-term momentum and volume.",
    conditions: [
      "Closes at a new 20-day high.",
      "Its 20-day return is in the top 10% of all tracked stocks.",
      "Volume is at least 1.5× its 20-day average.",
      RISK_ON,
    ],
    offReason: "Backtests came out coin-flip or worse.",
  },
  catalyst_momentum: {
    label: "News Catalyst Move",
    category: "intraday",
    categoryLabel: "Intraday",
    timing: "intraday",
    summary: "Fresh news hit and the stock is running on heavy volume while holding above its average price for the day.",
    conditions: [
      "A headline about the stock is less than 2 hours old.",
      "Up 3% or more on the day.",
      "Volume so far is at least 3× normal for this time of day.",
      "Trading above VWAP (the day's volume-weighted average price).",
    ],
    offReason:
      "The best of 8 intraday variants before costs (profit factor 1.32 over 49 simulated trades), but a net loser once spreads and costs are counted (0.78).",
  },
  rvol_breakout: {
    label: "Heavy Volume Breakout",
    category: "intraday",
    categoryLabel: "Intraday",
    timing: "intraday",
    summary: "Volume is running well above normal for the time of day and price just broke out of its opening range.",
    conditions: [
      "Volume so far is at least 2× normal for this time of day.",
      "Price is above the first 15 minutes' high.",
      "Trading above VWAP.",
      "Within 2% of the day's high, and at least 20 minutes into the session.",
    ],
    detail:
      "Checked live every 5 minutes across every $0.10–$5 stock trading $10k+ a day; fires at most once an hour per stock. Tested on 8,049 real breakouts: roughly break-even before costs and a little better than a random entry by the close, so treat it as where the action is right now, not a proven edge. Every alert is followed by an Exit Warning.",
  },
  avoid_chase_extended: {
    label: "Avoid: Don't Chase",
    category: "avoid",
    categoryLabel: "Avoid",
    timing: "intraday",
    summary: "Already up 10%+ in the first hour and pinned at the high — historically a bad moment to buy.",
    conditions: [
      "Up at least 10% from today's open.",
      "Trading above VWAP and within 2% of the day's high.",
      "Volume at least 2× normal for this time of day.",
      "Within the first hour of the session.",
    ],
    detail:
      "The strongest intraday finding in this project: across 513 real cases these stocks did worse than a random entry, −2.3% against −1.0% over the next two hours, with the whole confidence range below random. Fires once a day per stock.",
  },
  vwap_reclaim: {
    label: "VWAP Reclaim",
    category: "intraday",
    categoryLabel: "Intraday",
    timing: "intraday",
    summary: "After selling off, the stock bounced and just climbed back above the day's average price.",
    conditions: [
      "Bounced at least 3% off the day's low.",
      "Just moved back above VWAP (0–2% above it).",
      "Volume so far is at least 2× normal for this time of day.",
      "At least 15 minutes into the session.",
    ],
    offReason: "Lost money in simulation (profit factor 0.80). It tended to catch falling knives.",
  },
  gap_and_go: {
    label: "Gap and Go",
    category: "intraday",
    categoryLabel: "Intraday",
    timing: "intraday",
    summary: "The stock gapped up at the open and is pushing higher on heavy volume.",
    conditions: [
      "Opened at least 5% above the prior close.",
      "Broke above the opening range.",
      "Volume so far is at least 3× normal for this time of day.",
      "Trading above VWAP.",
    ],
    offReason:
      "Tested on 186 real gap-ups in this price band: a few big winners hide a mostly losing set — the typical trade is down about 3.8% by the close, and no holding period beats a random entry.",
  },
  squeeze_release_intraday: {
    label: "Squeeze Release (Intraday)",
    category: "intraday",
    categoryLabel: "Intraday",
    timing: "intraday",
    summary: "A stock that's been unusually quiet for months is suddenly moving hard today.",
    conditions: [
      "Bollinger Band width is in the bottom 10% of its last 6 months (a squeeze).",
      "Today's range is at least 2× its average daily range.",
      "Up 2% or more on the day.",
      "Volume so far is at least 3× normal for this time of day.",
    ],
    offReason:
      "Tested on 741 real range expansions in this price band, and it is worse than picking a random minute: −1.4% after two hours against −1.0% for a coin flip. Buying a quiet stock that suddenly moves is an active mistake here.",
  },
};

export const TIMING_LABEL: Record<TriggerTiming, string> = {
  realtime: "Real-time",
  daily: "Daily, after the close",
  intraday: "Intraday",
  exit: "Daily exit check",
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

// Which side of a trade a fire represents, for the feed's Buy / Sell split.
// "sell" = an exit signal (close a long) or a bearish/short trigger;
// everything else is a bullish entry.
const SELL_TRIGGERS = new Set([
  "bb_rsi_confluence_short",
  "macd_bearish_cross",
  "volatility_squeeze_breakout_short",
  "exit_warning",
  "avoid_volume_blowoff",
  "avoid_chase_extended",
]);

export function triggerSide(name: string | null): "buy" | "sell" {
  if (!name) return "buy";
  if (SELL_TRIGGERS.has(name)) return "sell";
  if (TRIGGER_INFO[name]?.category === "exit") return "sell";
  return "buy";
}
