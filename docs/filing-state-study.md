# Filing-state study — dilution as an avoid rule

Written 2026-09-29. The first result in the agentic-trader effort to clear
a sealed holdout. It is an **avoid rule, not a return source**.

## Why this family

Every price/volume signal tried in the $0.10-$5 band has come out even with
or worse than a random entry: the daily and intraday triggers (README),
the breakout precursors (`docs/breakout-study.md`, including the
2026-09-29 noise floor), and trading the volume spike itself
(`research/swing_backtest.py`, below). SEC filing state is causally
separate from chart mechanics and is not what retail scanners watch.

## Method

`research/filing_state_study.py`. Every in-band symbol-day with 20-day
dollar volume >= $250k, 2016 onward (1.65M rows). EDGAR facts joined on
`filed` (point in time); filings on `filing_date <= date`. Outcome: 20- and
60-session split-adjusted return, artifact-guarded, winsorized 1/99 within
each period, minus the same day's in-band average. Symbol-clustered
bootstrap 90% intervals. Rules chosen on 2016-21; 2022+ run once
(`--holdout`) after the EDGAR bulk refresh of 2026-09-29.

## Result — 60-session excess return

| rule | 2016-21 | 2022+ holdout | P(20d <= -30%), 2022+ |
|---|---|---|---|
| S-1/S-3/F-1/F-3 filed, last 30 days | -7.9% [-10.8, -5.3] | **-11.3%** [-13.1, -9.5] | 21% (vs 11%) |
| 424B4/424B5 priced offering, last 30 days | -3.9% [-6.3, -1.5] | **-9.4%** [-11.2, -7.7] | 19% |
| shares 1-3x more than a year ago | -5.5% [-8.4, -2.0] | **-6.7%** [-9.0, -4.4] | 15% |
| shares 3x+ more (context) | -4.8% | -11.7% [-14.3, -9.3] | 20% |
| market cap < $10M (not pre-named) | -5.3% | -12.7% [-14.6, -10.7] | 22% |

All three pre-named rules hold with the same sign and a larger magnitude
out of sample. Cash runway buckets, 8-K 1.01 and 8-K 3.02 were weak or
inconsistent in 2016-21 and were not carried to the holdout. Symbols with
no EDGAR data outperform in 2016-21 (+2.3%) — likely foreign/non-XBRL
filers; compare buckets to each other, not to zero.

**Not a short**: borrow on exactly these names is scarce and often costs
50-300%/yr, more than the edge.

## What the filter adds to a strategy (2016-21 only)

`swing_backtest.py`'s `excl_dilution` variant (offering form in 30 days,
shares >= 2x YoY, or market cap < $10M), applied to both the signal and
its random-entry control:

- **Volume spike >= 5x** (entry next open, 2 ATR stop, 3 ATR trail, 20
  sessions): +1.67%/trade vs control +1.99%. No edge with or without the
  filter. Positive means are carried by the top 1% of trades in both.
- **Trend** (new 50-session closing high, close > SMA200, SMA50 > SMA200,
  60-session hold): avg R 0.26 vs control 0.13 at a $250k floor, 0.51 vs
  0.20 at $2.5M — but the 90% intervals ([0.02, 0.58], [0.01, 1.29]) are
  wide because a few tight-ATR trades produce huge R multiples. Not yet
  distinguished from the control. 83% of trades exit on the stop within a
  median 9 sessions: the stop is too tight for the intended hold.

The filter barely changes either result: the signals rarely select
diluting names in the first place. Its value is as a hard guardrail in the
agent's risk layer, not as an edge.

## Trend follow-up (2026-09-29) — closed

Capped R (<= 10R per trade) removed the band-trend "edge" entirely (0.11
vs control 0.19): it was a few tight-ATR outliers. Moved to liquid names
(price >= $5, 20-day dollar volume >= $10M, 0.2% cost), 2016-21, capped R:

| exits (stop / trail ATR, max hold) | trend | random entries |
|---|---|---|
| 2 / 3, 60 | -0.04 | 0.04 |
| 3 / 5, 60 | 0.09 | 0.13 |
| 3 / 5, 120 | 0.12 | 0.18 |
| 4 / 6, 250 | 0.21 | 0.27 |
| 5 / 8, 120 | 0.21 | 0.23 |

Wider exits help both equally: the exit structure plus a rising market
did the work, not the entry. Portfolio replay (`research/trend_portfolio.py`,
0.5% risk/trade, 20 positions, no leverage, daily mark-to-market),
3/5 ATR, 120 sessions: trend +7.3%/yr, Sharpe 0.54, max DD -20%; random
+8.6%, 0.60, -26%; SPY +15.4%, 0.90, -34%.

## Withdrawals (`research/withdrawal_sim.py`)

4%/yr of trailing-12-month average value, paid monthly, total return
(dividends from the corporate-actions feed). From 2017-02 / 2020-01 /
2022-01, SPY ended at $269k / $202k / $143k per $100k while paying
$60k / $35k / $19k. A 200-day trend rule on SPY cost ~40% of ending value
(sold after each crash, bought after each rebound: 2018, 2020, 2025).
Top-20 momentum alone: more return from 2022, but a -57% drawdown. 50/50
SPY + momentum ≈ SPY with a slightly deeper drawdown. A 12-month cash
buffer didn't help in V-shaped crashes; the data (2016+) contains no
long bear market, so these are optimistic.

## Next

1. Encode the rule as a non-overridable pre-trade check for the agentic
   trader; consider extending the live `Offering filed` red flag with the
   share-growth and market-cap conditions.
2. Catalysts: see `docs/catalyst-harness.md`.
