/**
 * Turns a signal's context into plain-language risk flags + a
 * risk-defined trade suggestion. Pure — no I/O — so deep-dive.ts stays
 * readable and this is unit-testable.
 *
 * The scanner surfaces price action; it says nothing about *why* a stock
 * is moving or whether the move has legs. These flags don't fix that,
 * but they catch the categories most likely to reverse hard on a small
 * account: imminent earnings, parabolic runs, offering-sized volume,
 * sub-$1 manipulation, and binary-catalyst sectors (biotech / crypto-AI
 * sentiment).
 */

export interface RiskInput {
  price: number | null;
  vol_percentile_252d?: number | null;
  ret_1m?: number | null;
  dist_sma200?: number | null;
  volume_ratio_20d?: number | null;
  sector?: string | null;
  industry?: string | null;
  market_cap?: number | null;
  is_adr?: boolean | null;
  // days until (positive) or since (negative) the nearest earnings report
  earnings_days?: number | null;
  earnings_date?: string | null;
  // hours since the most recent news headline for this symbol
  news_age_hours?: number | null;
  // fundamentals (from the DoltHub sync)
  runway_quarters?: number | null; // cash ÷ quarterly cash burn
  share_change_yoy?: number | null; // shares outstanding vs ~1 year ago
  book_equity?: number | null; // total stockholders' equity
}

export interface RiskFlag {
  level: "red" | "amber";
  label: string;
  note: string;
}

const BIOTECH = /biotech|pharm|therapeut|oncolog|genomic|clinical|life scien|medicines|drug/i;
const SENTIMENT = /crypto|bitcoin|blockchain|digital asset|mining|quantum|artificial intelligence|\bai\b/i;

export function riskFlags(x: RiskInput): RiskFlag[] {
  const f: RiskFlag[] = [];
  const sec = `${x.sector ?? ""} ${x.industry ?? ""}`;

  if (typeof x.news_age_hours === "number" && x.news_age_hours >= 0 && x.news_age_hours <= 24) {
    f.push({
      level: x.news_age_hours <= 6 ? "red" : "amber",
      label: `Fresh news (${x.news_age_hours < 1 ? "<1h" : `${Math.round(x.news_age_hours)}h`} ago)`,
      note: "A headline this recent means the move is catalyst-driven — read it before assuming the technical setup is the whole story.",
    });
  }
  if (typeof x.earnings_days === "number" && x.earnings_days >= 0 && x.earnings_days <= 7) {
    f.push({
      level: x.earnings_days <= 2 ? "red" : "amber",
      label: `EARNINGS ${x.earnings_date ?? ""} (${x.earnings_days}d)`,
      note: "A report inside the hold window is a gap coin-flip regardless of the technical setup.",
    });
  }
  if ((x.vol_percentile_252d ?? 0) >= 0.9) {
    f.push({
      level: "amber",
      label: `Extreme volatility (${Math.round((x.vol_percentile_252d ?? 0) * 100)}th pct)`,
      note: "Realized vol in the top decile of this stock's own year — moves both ways are large.",
    });
  }
  if ((x.ret_1m ?? 0) >= 0.5) {
    f.push({
      level: "amber",
      label: `Up ${Math.round((x.ret_1m ?? 0) * 100)}% in a month`,
      note: "Already extended — you'd be chasing, with mean-reversion risk.",
    });
  }
  if ((x.dist_sma200 ?? 0) >= 1.0) {
    f.push({
      level: "amber",
      label: `${Math.round((x.dist_sma200 ?? 0) * 100)}% above its 200-day avg`,
      note: "Stretched far from any support.",
    });
  }
  if ((x.volume_ratio_20d ?? 0) >= 5) {
    f.push({
      level: "red",
      label: `Volume ${Math.round(x.volume_ratio_20d ?? 0)}x normal`,
      note: "Abnormal volume on a low-priced name often means an offering / ATM is being marketed into the move.",
    });
  }
  if (x.price != null && x.price < 1) {
    f.push({
      level: "amber",
      label: "Sub-$1",
      note: "Lowest-price tier — highest manipulation and delisting risk.",
    });
  }
  if (typeof x.market_cap === "number" && x.market_cap > 0 && x.market_cap < 50_000_000) {
    f.push({
      level: "red",
      label: `Nano-cap ($${(x.market_cap / 1e6).toFixed(0)}M)`,
      note: "Below ~$50M market cap — thin float, easily moved by a single order, and dilution/reverse-split prone.",
    });
  }
  if (x.is_adr) {
    f.push({
      level: "amber",
      label: "Foreign ADR",
      note: "Overseas issuer — lighter disclosure, wider overnight gaps, higher delisting/deregistration risk.",
    });
  }
  if (typeof x.runway_quarters === "number" && x.runway_quarters > 0 && x.runway_quarters <= 4) {
    f.push({
      level: x.runway_quarters <= 2 ? "red" : "amber",
      label: `~${x.runway_quarters < 1 ? "<1" : x.runway_quarters.toFixed(1)}Q cash left`,
      note: "Cash divided by recent quarterly burn. A raise is likely inside the hold window — an offering prices below market and dilutes.",
    });
  }
  if (typeof x.share_change_yoy === "number" && x.share_change_yoy >= 0.2) {
    f.push({
      level: x.share_change_yoy >= 0.5 ? "red" : "amber",
      label: `Shares +${Math.round(x.share_change_yoy * 100)}% YoY`,
      note: "Heavy dilution over the last year — the count keeps climbing, which caps upside and often precedes more of the same.",
    });
  }
  if (typeof x.book_equity === "number" && x.book_equity < 0) {
    f.push({
      level: "amber",
      label: "Negative book value",
      note: "Liabilities exceed assets — accumulated losses have wiped out equity. Common in distressed / pre-revenue names.",
    });
  }
  if (BIOTECH.test(sec)) {
    f.push({
      level: "amber",
      label: "Biotech",
      note: "One press release (data / FDA) from a 50%+ gap in either direction.",
    });
  }
  if (SENTIMENT.test(sec)) {
    f.push({
      level: "amber",
      label: "Sentiment-driven sector",
      note: "Crypto / AI sympathy moves reverse as fast as they appear.",
    });
  }
  return f;
}

export interface TradeSuggestion {
  stop: number;
  stop_pct: number;
  shares: number;
  position_cost: number;
  max_loss: number;
}

/** Risk-defined sizing for a small account: never risk more than
 *  `maxRiskPct` of the account on the stop, and never spend more than the
 *  account has. */
export function tradeSuggestion(
  price: number,
  cfg: { account_size: number; max_risk_pct: number; default_stop_pct: number },
): TradeSuggestion | null {
  if (!(price > 0)) return null;
  const stop = round2(price * (1 - cfg.default_stop_pct));
  const riskPerShare = price - stop;
  if (riskPerShare <= 0) return null;
  const maxLossBudget = cfg.account_size * cfg.max_risk_pct;
  let shares = Math.floor(maxLossBudget / riskPerShare);
  if (shares * price > cfg.account_size) shares = Math.floor(cfg.account_size / price);
  if (shares < 1) return null;
  return {
    stop,
    stop_pct: cfg.default_stop_pct,
    shares,
    position_cost: round2(shares * price),
    max_loss: round2(shares * riskPerShare),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
