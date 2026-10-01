# Size-conditioned insider buying — the 2022+ holdout, pre-registered

**Status: DRAFT for review. Nothing below has been run on 2022+ data.**
Written 2026-10-01 (follow-up to README item 43). Once approved and merged,
`research/catalysts/holdout_insider.py --run --approved-commit <sha>` runs
the test **once**; it refuses if this file, `holdout_insider.py` or
`harness.py` changed after that commit. Same machinery and decision rules
as the item-37 holdout (`docs/catalyst-2022-prereg.md`).

## 1. Is 2022+ still sealed for these types?

- The harness registry has **0 rows for 2022+ for any Form 4 type**
  (checked 2026-10-01; 69 types ever tested on 2016-21). The item-37 holdout
  covered news, filing and earnings types only.
- The types were created today; no study, page or chart has shown their
  2022+ returns.

## 2. What is tested

**Primary (one rule):** `f4_buy_mcap_0.1pct` — the company's open-market
insider buys on a filing date total **≥ 0.1% of its market cap** (SEC shares
outstanding, filed ≤ 400 days before and restated to that date's split
basis, × that date's raw close). Direction: positive.

Discovery, full run `20261001T151849` (69 types, $0.10-$15, 2016-21):

| type | n | gap vs random dates (20d) | one-sided p | q (69 types) |
|---|---|---|---|---|
| **buys ≥ 0.1% of market cap** | 1,325 | **+2.46%** | 0.003 | 0.057 |
| buys ≥ 0.5% of market cap (secondary) | 422 | +2.54% | 0.035 | 0.17 |
| any open-market buy (secondary, reference) | 10,567 | +0.57% | 0.022 | 0.12 |

Supporting checks on discovery data: the return-matched null keeps the gap
(+2.40%, run `20261001T152057`), so it is not mean reversion; the
$0.10-$5 band keeps the sign (+2.13%, n 454, p 0.20, run `20261001T152013`).
By year the advantage over each year's universe leans on 2019.

Not tested: CEO/CFO buys and first-buy-in-a-year (no separation in
discovery, q 0.27), and the older role/cluster types.

## 3. Fixed settings

Exactly the discovery harness, as in the item-37 document: entry at the
close of the first session strictly after the filing date; gates raw close
$0.10-$15 (primary) / $0.10-$5 (in-band check) and 20-day dollar volume
≥ $250k; 20-session split-adjusted return net of max(1%, a tick),
artifact-guarded, winsorized 1/99, minus the same day's gated mean; null =
each symbol's events rotated ≥ 60 sessions within its own 2022+ history,
**5,000 rotations**, seed 7; symbol-clustered bootstrap 90% CI (300);
minimum 200 events. Period 2022-01-01 to the end of the warehouse at run
time. Form 4 data, the market-cap construction and the type definition are
unchanged since discovery.

## 4. Decision rules

For the primary rule, 2022+, $0.10-$15, 20 sessions:

- **PASS** = gap in the discovery direction (positive) **and** one-sided
  p ≤ 0.05 (one rule, so no correction) **and** the 90% CI of the mean
  excess lies above the null median.
- **VALIDATED FOR USE** = PASS **and**, at $0.10-$5 on 2022+, the gap is
  positive with its 90% CI above the null median. If the in-band run has
  fewer than 200 events the in-band check is reported as not computable,
  and the rule is not validated for use.
- Anything else is **FAIL**, final for this definition.
- Secondaries: same statistics, reported, never a verdict.
- Money check (reported, not pass/fail): the events' mean 20-session net
  return vs the gated universe's over the same period. Per
  `docs/return-inflation.md`, it is read only against the universe, and a
  descriptive by-year / median table is added after the run.

**Realistic expectation:** the discovery data itself would score "PASS,
not in the traded band" — its in-band 90% CI ([0.69%, 5.53%]) does not
clear the in-band null (0.83%). Validation for use needs a stronger or
larger in-band effect in 2022+ than in 2016-21.

## 5. What each outcome leads to

- **Validated for use** → a positive tilt for the rules-based sleeve
  (README item 36), still subject to a cost-realistic money test before any
  capital; an amber, labelled "measured" note on the feed at most — never
  green until a money test passes.
- **PASS, not in the traded band** → recorded as a positive effect at
  $0.10-$15 only; no use in the $0.10-$5 system.
- **FAIL** → the Form 4 buy family is dropped (README item 43's original
  condition), recorded on /research.

## 6. Decisions for you before approving

1. One primary rule (≥ 0.1%), with ≥ 0.5% and any-buy as secondaries.
2. The in-band requirement for "validated for use", knowing discovery
   alone would not meet it.
3. Approve by merging this PR; the run is

```
research/.venv/bin/python research/catalysts/holdout_insider.py --run --approved-commit <merge sha>
```

## RESULTS

*(empty until the run)*
