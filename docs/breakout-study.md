# The breakout-event study — what precedes a >=75% single-session gain

Written 2026-09-28. Exploratory research, not a shipped trigger or a
claimed edge — see README.md's 2026-09-24/28 session section for how this
fits the rest of the project, and `docs/research-audit-plan.md` for the
audit method this study tries to follow.

## The question

Every instance since 2016 of a stock in the $0.10-$5 band gaining >=75% in
a single session — what, if anything, precedes one? Not a new trigger:
this is discovery-and-validation research, several steps before anything
here could be considered for `docs/selection-logic.md`.

## Part 1 — Defining the event list is the hard part

A naive filter (split-adjusted close-to-close return >= 75%, prior day's
raw close in band) returns thousands of "matches" dominated by data
artifacts, not real breakouts. The top of an unguarded list:

| symbol | date | prior close | close | "gain" |
|---|---|---|---|---|
| GPOR | 2021-05-18 | $0.1383 | $72.95 | +52,648% |
| LINE | 2024-07-25 | $0.18 | $80.78 | +44,778% |
| SD | 2016-10-04 | $0.15 | $19.50 | +12,900% |

These are reverse-split / bankruptcy-reorg equity-cancellation events
(GPOR's 2021 Chapter 11 emergence cancelled the old shares entirely — not
even a stock split), **not trades**. The local `corporate_actions`
parquet (loaded from Alpaca, `load_corporate_actions.py`) does **not**
catch any of these, even with a +/-3 day matching window, despite its own
docstring claiming "worthless removals" / merger coverage — those action
types don't actually appear in the loaded data (see README open item #28).

### The guard that actually works

Cross-checking volume: every one of the known-bad candidates above has
**zero or near-zero trading volume in the 20 sessions before the
"gain"** — there was no real market in the stock. Requiring genuine
liquidity is what separates artifacts from real breakouts, not the
corporate-actions join.

**Final guards, applied in order** (`research/breakout_events.py`):

1. **Raw/split-adjusted agreement** (tolerance 5%) — rules out a silently
   un-adjusted or partially-adjusted split.
2. **`corporate_actions` exclusion**, any type, +/- 3 days — belt and
   suspenders, kept despite its known gaps.
3. **Liquidity/volume-surge floor** — the guard that actually works: at
   least 15 of the prior 20 sessions must have traded at all, prior
   20-day average volume must be positive, and the event day's volume
   must be >= 2x that average.

**Result**: 1,876 raw candidates -> **1,465 validated events, 974
symbols** (349 in 2016-21, 1,116 in 2022+). Rejected breakdown: 222 thin
prior trading, 105 no volume surge, 65 no prior volume at all, 19 a
nearby corporate action. Spot-checked a random sample of the survivors —
all read as plausible, explainable events (ENTX, MBOT, XTNT, FTSI, etc.),
none of the reorg-artifact signature.

**Scope, stated plainly**: no dollar-volume floor applied (unlike
`bigmove_study.py`/`catalyst_study.py`'s $800k/$2.5M gates) — this
includes thin, illiquid names, only gated by the event-day liquidity
guard above. Survivorship is claimed by the warehouse, not independently
reverified here (same caveat as `research-audit-plan.md` F6).

**Outputs** (git-ignored, regenerate via the script):
`research/data/study_outputs/breakout_events_<timestamp>.csv` (the
validated list) and `breakout_events_rejected_<timestamp>.csv` (every
rejected candidate with its reason, for the audit trail).

```
research/.venv/bin/python research/breakout_events.py [--sample 15]
```

## Part 2 — The wide per-event feature dataset

`research/breakout_window_dataset.py` reads a `breakout_events.py` output
CSV and builds one row per (event, trading-session offset -45..0) —
**66,907 rows, all 1,465 events covered**. Point-in-time throughout
(every rolling stat is prior-session-only).

Columns: raw + split-adjusted OHLCV, `adv20`/`dollar20`, `ret_1d/5d/20d`
(artifact-guarded), `dist_sma20/50/200`, `atr14_pct`,
`pct_of_52w_high`/`hi252`, `gap_pct`, `spread_est` (Abdi-Ranaldo, matching
`bigmove_study.py`), `vol_ratio_20d`, `has_8k_since_prev` /
`has_8k_202_since_prev`, `in_reverse_split_window`, `is_event_day`,
`event_gain_pct`.

```
research/.venv/bin/python research/breakout_window_dataset.py \
    research/data/study_outputs/breakout_events_<timestamp>.csv [--lookback 45]
```

## Part 3 — Findings so far

### Volume run-up: backward view vs. forward view disagree

This project's own recurring lesson (a metric optimized for the wrong
target inverts) showed up again, in a new shape.

**Backward** (given a breakout happened, what did volume look like
before it): a real ramp. Median `vol_ratio_20d` sits ~0.50-0.55 for weeks
-20 to -8 (quieter than the population's own 0.63 unconditional
baseline), rises through the final week, and hits 1.18 on the session
immediately before the breakout.

**Forward** (given a stock is currently quiet, does it break out) — the
test that actually matters, run on the **whole in-band universe**, not
just the 974 symbols that eventually broke out (that would be circular):

| streak (consecutive days under 1.0x adv20) | n | hit rate, next 20 sessions | vs. baseline (0.47%) |
|---|---|---|---|
| 1-10 days | ~3.17M | ~0.41-0.47% | at or below baseline |
| 11-15 | 398,018 | 0.581% | 1.24x |
| 16-20 | 198,121 | 0.723% | 1.54x |
| 20+ | 122,575 | 0.829% | 1.76x |

**Short streaks show no lift at all.** The backward-conditioned view made
"quiet" look predictive from day one; forward, it only starts mattering
past ~15 sessions, and even the best bucket has a ~1-in-120 hit rate.

### Pairing quiet-streak with price trend — the one finding that cleared the bar

Requiring a trailing 20-day return <= -20% **in addition to** the volume
streak, checked in both periods independently:

| period | baseline | streak 1-10 + down>=20% | streak 11-20 + down>=20% | streak 20+ + down>=20% |
|---|---|---|---|---|
| 2016-21 | 0.269% | 0.677% (2.52x) | 0.691% (2.57x) | 0.874% (3.25x) |
| 2022+ | 0.625% | 1.172% (1.88x) | 1.316% (2.11x) | 1.634% (2.61x) |

Same shape in both periods independently, lift growing monotonically
with streak length in both — this project's own bar for trusting a
result. **Still not a trigger**: best absolute hit rate is 1.63% (~1 in
61), and this has **not yet been checked against a permutation-based
noise floor** (`growth_study.py`'s `--control-reps` is the established
instrument for that) — the 2-3x lift is not yet distinguished from what a
shuffle would produce by chance at this sample size.

### The 15-metric universe-wide scan (`research/breakout_scan.py`)

Ran vol_ratio, streak length, ret_5d/10d/20d/45d, dist_sma20/50/200,
atr14_pct, range compression/expansion, pct_of_52w_high/low, dollar-vol
tier, price level, and has_8k_7d, each bucketed, both periods, forward 20
sessions. Full output is reproducible, not reproduced in full here.

**Most of what "cleared the bar" is one archetype, not several**:
`ret_5d/10d/20d/45d down>=20-30%`, `dist_sma20/50/200 far below`,
`pct_of_52w_high <25%`, `price <$1`, `dollar_vol <100K`, `atr14 very
wide` are all highly collinear — a stock that crashed 45 sessions is
almost automatically also down 20/10/5 sessions, far below its 200-day
SMA, near its 52-week low, cheap, and illiquid. Reporting each as a
separate finding would repeat `research-audit-plan.md`'s own F5 mistake
("`score>=3` is the best of 17 correlated candidates, uncorrected").

**A second caution**: `dist_sma20 far above` also cleared the bar, and
`ret_5d/10d up>=20%` cleared too (weaker than their down-side
counterparts). Extreme moves in *either* direction predicting more
extreme moves is closer to generic volatility clustering (a well-known
market fact) than a specific, exploitable precursor.

**The one metric that stood apart as a genuinely distinct family**:
`vol_ratio_20d >= 5x` cleared the bar on its own (2.52x / 2.61x) —
participation/liquidity, not price state. This is the same signal behind
the streak+price-trend combination above, now confirmed as independent
of the price-collinearity cluster rather than a proxy for it.

```
research/.venv/bin/python research/breakout_scan.py \
    research/data/study_outputs/breakout_events_<timestamp>.csv [--forward 20] [--min-lift 1.5]
```

### Noise floor (2026-09-29) — the streak finding mostly fails

`research/breakout_noise_floor.py`, 500 reps: each symbol's flag series is
circularly shifted (>= 60 sessions), which keeps *which* names get flagged
and breaks only *when*. Also a symbol-clustered bootstrap and four dedupe
variants (all events / first event per symbol / repeat symbols dropped /
one flag per 20-session episode). Bar: observed lift > null p95, both
periods.

| cell | variants passing (of 8) | observed lift | null median |
|---|---|---|---|
| `vol_ratio_20d >= 5x` | **8** | 1.6-2.4x | ~1.2x |
| streak 1-10 + down>=20% | 5 | 1.1-2.0x | 1.1-1.3x |
| streak 11-20 + down>=20% | 3 | 1.4-1.9x | 0.9-1.4x |
| streak 20+ + down>=20% | **0** | 1.4-2.1x | 0.6-1.8x |

Most of the streak+decline lift above is **name selection, not timing**:
shifted flags on the same symbols reproduce 1.3-1.8x. The 20+ bucket
(the 3.25x/2.61x headline) never beats its null in 2022+. Repeat
offenders were not the inflation source. The volume spike is the one
signal that carries timing information; it is the lead for the swing
backtest, with streak+decline at most a secondary filter. Baselines here
(0.55% / 0.99%) differ from the table above because the population is
slightly broader; null comparisons are like-for-like.

## Part 4 — Data audit for expanding this (2026-09-28)

Before adding more metrics derived from the same OHLCV source (which is
exactly how Part 3 collapsed into one archetype), audited what's
available for genuinely independent signal families.

**Already paid for, already loaded, still untouched by this study**:

- `research/data/edgar/edgar_facts.parquet` (60MB, `filed`-dated
  point-in-time, full 2016-2026 universe): shares outstanding (3
  variants), cash, public float, revenue, stockholders' equity, net
  income, operating cash flow. The dilution/cash-runway family —
  causally unrelated to price/volume mechanics.
- `research/data/minute/` (85GB, full SIP minute bars, 2016-2026, full
  universe): intraday microstructure — opening-range behavior, VWAP
  reclaim/rejection, close-near-high vs close-near-low each day. Nothing
  in this study has used minute-level data yet; everything so far is
  daily bars.
- SPY daily bars (already in `sip_bars_daily_raw`/`split`, `symbol='SPY'`
  — the same source `schema_lab.py`'s `spy_prior_ret_1d`/`spy_above_sma200`
  fields already read from): market-regime context, untested here.
- `edgar_filings.parquet` item codes beyond a generic "any 8-K in 7
  days" (already tested, weak): 8-K 3.02 (unregistered equity sales —
  dilution events), 1.01 (material agreements), 5.02 (officer
  departures), and registration/offering forms (S-1/S-3/424B*) as
  distinct catalyst sub-types, not lumped together.

**Real gaps needing new access, not just unused data**:

- Historical short interest beyond ~2026 (Supabase's `short_interest`
  only has 12 recent FINRA settlements) — feasibility of a free bulk
  historical pull is unverified; may require a paid vendor (Ortex, S3
  Partners).
- Historical borrow-fee/squeeze-pressure data — IBKR only ever gives
  current snapshots, no history; a paid vendor is the only path.
- Retail-attention proxies (Google Trends search interest — free but an
  unofficial API; social/Reddit mention volume — needs a paid vendor,
  Pushshift's free archive access has been restricted).
- Full order-book (Level 2/L3) depth — discussed at length 2026-09-28.
  Genuinely richer in principle (a direct measurement of supply/demand
  imbalance, not an OHLCV-derived proxy for it), but: (a) a large share
  of this universe trades OTC, where there often isn't a rich
  multi-participant book to read; (b) Alpaca's current plan doesn't
  include it at all — a new vendor relationship (Polygon.io, Databento,
  algoseek); (c) real engineering cost (point-in-time book reconstruction
  from add/cancel/execute messages is a harder, more artifact-prone
  problem than anything built so far — weeks, not days). Vendor pricing
  lookup was offered, not yet done — a budget decision for the user.

## Open items for this study specifically

1. Permutation-based noise floor for the volume+price-decline finding
   (the actual next step before trusting its 2-3x magnitude).
2. Check whether the scan's flagged cells are inflated by repeat-offender
   symbols (322 of 974 symbols have 2+ events, one has 7) sitting close
   together in time — dedupe and re-check.
3. Build out the dilution/fundamentals family from `edgar_facts.parquet`
   (zero new access needed).
4. Build out intraday-microstructure features from the minute warehouse
   (zero new access needed, real engineering effort).
5. Investigate `load_corporate_actions.py`'s coverage gap (README #28) —
   affects this study's exclusion filter and potentially
   `avoid_reverse_split`'s own evidence base.
6. If pursued: vendor pricing/coverage lookup for L2/L3 historical data,
   and a feasibility check on historical FINRA short-interest bulk
   access — both are budget/access decisions, not research tasks to
   start unprompted.
