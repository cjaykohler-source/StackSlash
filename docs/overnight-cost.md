# Overnight cost check (README item 40)

Written 2026-10-01. `research/overnight_cost.py` (+ `--minute-cost`),
`research/overnight_minute_spread.py`; outputs `overnight_cost_*`,
`overnight_minute_spread_20261001.txt` in `research/data/study_outputs/`.
2016-21 only; 2022+ untouched.

## Question

`overnight_cycle.py` found a ~+0.6-0.9% gross close → next-open return that
a flat 1% round trip erased. With each stock's **own** spread as the cost,
does any price × liquidity bucket keep a net overnight edge?

## Pre-set test — FAIL, but on an invalid cost

Design fixed in the script header: buy at t's close, sell at t+1's open;
cost = a 20-session daily Abdi-Ranaldo spread (as the production
`refresh-spread-estimates` job), floored at a tick; buckets price × 20-day
dollar volume; carried if net > 0 with the 90% lower bound > 0 on 2016-19.
**No bucket was carried** — every one −2% to −8% net.

But the daily estimator is not credible here: it put the median round-trip
spread of $2-5 names trading $25M+/day at 2.0%. Applied to **1-minute bars**
(far less volatility per bar) on a 2019 sample, the same estimator gives:

| price | minute-bar spread (mean, by liquidity) | daily estimate |
|---|---|---|
| $0.10-0.50 | 0.59-0.78% | 4.9-7.7% |
| $0.50-1 | 0.26-0.61% | 3.9-6.7% |
| $1-2 | 0.42-0.49% (one-tick floor ~0.5-1%) | 3.4-5.4% |
| $2-5 | 0.18-0.38% | 2.6-3.0% |

The daily version overstates spreads 5-15x on these stocks. The production
`symbol_spread_estimates` table uses the daily version too (noted below).

## Exploratory re-score with minute-bar spreads (not pre-set)

| 2016-19, all eligible nights | gross | cost | net |
|---|---|---|---|
| $0.10-0.50 | +1.1-1.4% | 0.6-0.8% | **+0.35-0.61%** |
| $0.50-1 | +0.2-0.7% | 0.6% | −0.4 to +0.1% |
| $1-2 | +0.3-0.6% | 0.6-0.7% (tick floor) | −0.1 to −0.3% |
| $2-5 | +0.15-0.2% | 0.3-0.4% | −0.06 to −0.21% |

2020-21 shows the same shape (sub-$0.50 +0.24 to +0.93%).

Sub-$0.50 by year (net, mean / median): 2016 +0.66 / +0.23%, 2017
+0.25 / −0.35%, 2018 +0.47 / −0.11%, 2019 +0.37 / −0.31%, 2020
+0.71 / −0.40%, 2021 −0.39 / −0.75%.

## Reading

Only the sub-$0.50 names show a positive *average* night after realistic
spreads, and **the median night loses in 5 of 6 years** — the average is
the occasional large gap. Three things make even that optimistic:

1. The cost is a lower bound: minute-bar spreads are an intraday average;
   spreads at the open and around the closing auction are wider.
2. The gross return partly reflects bid-ask bounce: the next session's
   open → close gives back about half of it (sub-$0.50: +1.22% overnight,
   −0.57% next intraday; $2-5: +0.24% / −0.15%).
3. Capacity: most sub-$0.50 nights trade $0.25-1M a day.

**No tradable overnight edge is demonstrated.** The one route left would be
a test on actual auction prints and quotes at the open and close (paid
NBBO/auction data), and given the profile above it is not recommended.

**Side finding:** the production `symbol_spread_estimates` (daily
Abdi-Ranaldo) likely overstates spreads by the same 5-15x on this universe;
anything that reads it as a cost should be treated with caution.
