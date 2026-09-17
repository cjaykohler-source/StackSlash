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
  /** One-line tested evidence, shown when there is no daily backtest (symbol page). */
  evidence?: string;
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
    detail: "Evaluated after the close (it moved off the 09:40 intraday scan on 2026-09-17, since it reads only the prior close). Disabled 2026-09-17: on clean SIP data its 20-day net return (−1.0% in 2016-21, −2.6% in 2022+) is no better than a random day in this price band.",
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
      "MACD compares a short-term and a longer-term average of price. When the short one overtakes the long one, it's read as an early sign the trend is turning up. Uses the textbook default settings. Disabled 2026-09-17: on clean SIP data it is indistinguishable from a random day (20-day net −0.1% in 2016-21, −3.3% in 2022+).",
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
    detail: "A long stretch of unusually small moves often ends with a big one. This catches the first day of the break upward. Disabled 2026-09-17: only 160 clean-data cases and driven by a few outliers, with nothing left in 2022+.",
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
    detail: "The downside version of the squeeze breakout. Unlike the upside version, it has no market-regime filter. Disabled 2026-09-17: never tested on clean data, and in three live days it produced one in-band alert.",
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
  earnings_release: {
    label: "Earnings Release",
    category: "catalyst",
    categoryLabel: "Catalyst",
    timing: "daily",
    summary: "The company just released quarterly results (8-K item 2.02); stocks like this have done better than a random day over the next month.",
    conditions: [
      "An 8-K with item 2.02 (results of operations) was filed during the previous session.",
      "Priced $0.10-$5 with enough dollar volume; a red flag moves it to Watch.",
    ],
    detail:
      "Held 20 sessions with only a 25% disaster stop, matching how it was tested. The benefit shows up over a month, not a week.",
    evidence:
      "Event study, 2016-2026: 20-day net +4.2% (2016-21) and +0.4% (2022+) without red flags, vs +1.8% and -3.2% for a random day.",
  },
  exit_warning: {
    evidence: "Exit rules: −12% stop, +10% take profit, 5% trail once up 5%, 10-day limit.",
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
  bigmove_watchlist: {
    label: "Big-Move Watchlist",
    category: "watch",
    categoryLabel: "Watch",
    timing: "daily",
    summary: "Something happened today that makes a big move tomorrow several times more likely than usual — in either direction.",
    conditions: [
      "At least 3 of: volume 3x+ its 20-day average; a 10%+ move on the day; a day range 2x+ its normal range (ATR); an 8-K filed since the previous session.",
      "Priced $0.10-$5 with enough dollar volume.",
    ],
    detail:
      "A watchlist for the next session, not a buy: the moves that followed were down more often than up. Stays Watch whatever its flags.",
    evidence:
      "Study, 2016-2026 ($800k+ floor): next-session move of 10%+ 35% (2016-21) and 43% (2022+) of the time vs 7% and 9% for a random day; still 3-9x after controlling for how volatile the stock already was. Only ~36% of those moves were up.",
  },
  avoid_reverse_split: {
    label: "Avoid: Reverse Split",
    category: "avoid",
    categoryLabel: "Avoid",
    timing: "daily",
    summary: "A reverse split took effect recently or is scheduled — historically the most reliably bad event in this price band.",
    conditions: ["A reverse split with an ex-date in the last 4 weeks or the next 30 days."],
    detail: "Fires once per stock per 30 days.",
    evidence: "Event study, 2016-2026: -17% to -22% over the next 20 sessions, 15-21% winners, in both periods.",
  },
  avoid_volume_blowoff: {
    evidence: "Backtest: median −16% over the next 18 sessions at 25x+ volume; every lower bucket roughly break-even.",
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
    evidence: "Minute test, 8,049 cases: about break-even before costs; slightly better than a random entry by the close.",
    label: "Heavy Volume Breakout",
    category: "watch",
    categoryLabel: "Watch",
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
    evidence: "Minute test, 513 cases: −2.3% vs −1.0% random over 2 hours; 7.5x more likely to swing ±10% intraday.",
    label: "Avoid: Don't Chase",
    category: "avoid",
    categoryLabel: "Avoid",
    timing: "intraday",
    summary: "Already up 10%+ in the first hour and pinned at the high — historically a bad moment to buy.",
    conditions: [
      "Up at least 10% from today's open.",
      "Trading above VWAP and within 2% of the day's high.",
      "Volume at least 2× normal for this time of day.",
      "Within the first hour of the session (by the clock: 15-60 minutes in, and at least 10 minutes of it traded).",
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
  "avoid_reverse_split",
]);

/**
 * Buy / Watch / Sell. Watch = "something is happening, direction unproven"
 * (e.g. Heavy Volume Breakout: tested ~break-even). A buy setup that carries
 * a red flag is also shown as Watch — the feed applies that per row.
 */
export function triggerSide(name: string | null): "buy" | "watch" | "sell" {
  if (!name) return "buy";
  if (SELL_TRIGGERS.has(name)) return "sell";
  const category = TRIGGER_INFO[name]?.category;
  if (category === "exit") return "sell";
  if (category === "watch") return "watch";
  return "buy";
}
