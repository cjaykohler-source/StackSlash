# Catalyst rules — the 2022+ holdout, pre-registered

**Status: RUN 2026-10-01** — approved at commit `a4af9b3` (decisions in section 6), run once the same day; results at the end, unedited.
Written 2026-10-01 (README item 37). Once this document is approved and
merged, `research/catalysts/holdout_2022.py --run --approved-commit <sha>`
runs the test **once**; the script refuses to run if this file,
`holdout_2022.py` or `harness.py` changed after that commit. Every rule,
setting and pass/fail criterion is fixed here, before any 2022+ number
exists. Whatever comes out is reported as is, failures included.

## 1. Is 2022+ still sealed?

- The harness registry (`research/data/catalysts/registry.duckdb`) has
  **0 rows for period 2022+** (checked 2026-10-01: 8 runs, 582 rows, all
  2016-21, including the in-band run made for this document). `--holdout`
  has never been run.
- No other study has measured returns after these catalyst types on
  2022+. The dilution study (`docs/filing-state-study.md`) used 2022+ for
  S-1/S-3/424B and share-growth rules only, a different set of types. The
  Charter event studies built this week ran on the default 2016-21 range.
- 2022+ prices have been visible in charts (the symbol pages, Charter's
  deep dive, the phase-4 market-wide series), but never as event returns
  for these types.

## 2. What is tested

Discovery: full harness run `20260930T094900` (65 types, $0.10-$15, the
harness defaults), 2016-21. Gap = mean 20-session excess minus the
rotated-date null median (the catalyst vs the same names at random dates).

**Primary family — four rules** (the README item-37 list minus the two
earnings-reporting rules; see section 6):

| rule | type | direction | n | gap (20d) | p | q (65 types) |
|---|---|---|---|---|---|---|
| Trading halt (headline) | `news_halt` | avoid | 1,306 | −3.73% | 0.001 | 0.022 |
| Partnership / licensing PR | `news_partnership` | avoid | 1,345 | −1.36% | 0.005 | 0.054 |
| 10-K filed | `10k` | avoid | 2,950 | −0.82% | 0.011 | 0.089 |
| Earnings beat | `earn_beat` | positive | 3,569 | +0.88% | 0.002 | 0.032 |

**Secondary — reported, never counted as a pass:**

| rule | type | why secondary | n | gap | q |
|---|---|---|---|---|---|
| Going-concern 10-K | `gc_10k` | README item 37 asks for it; not a discovery candidate (q 0.25, n 223) | 223 | −2.62% | 0.25 |
| Earnings big beat | `earn_big_beat` | a subset of earnings beat | 1,950 | +0.93% | 0.10 |
| 8-K 2.02 earnings release | `8k_2.02` | discovery candidate; flips sign in-band (below) and largely duplicates earnings beat | 11,628 | +0.45% | 0.054 |
| 10-Q filed | `10q` | discovery candidate; +0.37% in-band, largely the same reporting events | 9,071 | +0.50% | 0.089 |

**Not tested:** price-target cut (`news_pt_cut`, discovery q 0.022). It
flips sign in-band, has no explained mechanism, and would not be adopted
whatever 2022+ showed, so its one clean test is kept for a better-specified
version (e.g. conditioned on the size of the cut).

### The same rules in the traded band ($0.10-$5), 2016-21

Discovery was run at $0.10-$15; the system trades $0.10-$5. Run
`20261001T091744` (2016-21 only, made for this document) shows the band
is a quarter of the sample and **nothing clears the 44-type
multiple-testing bar there** (every q 0.46):

| type | n | gap (20d) | one-sided p |
|---|---|---|---|
| `news_halt` | 496 | −4.88% | 0.015 |
| `news_partnership` | 394 | −2.66% | 0.071 |
| `10k` | 664 | −1.25% | 0.21 |
| `earn_beat` | 600 | +1.88% | 0.077 |
| `8k_2.02` | 2,542 | **−0.16%** (sign flips) | — |
| `10q` | 1,975 | +0.37% | 0.34 |
| `news_pt_cut` | 672 | **−0.64%** (sign flips) | — |

So the earnings-*reporting* rules (2.02, 10-Q) and the price-target cut do
not hold in the band even on discovery data — the reason they are not in
the primary family. That is why the decision
rule below asks for an in-band check before anything is "validated for use".

## 3. Fixed settings

Exactly the discovery harness (`research/catalysts/harness.py`):

- Entry at the close of the first session **strictly after** the event
  date. Gates at entry: raw close $0.10-$15 (primary) / $0.10-$5
  (in-band check), 20-day dollar volume ≥ $250k.
- Outcome: split-adjusted 20-session return (5-session reported), net of
  max(1%, one tick), artifact-guarded (windows with a ≥10x or ≤0.1x day
  dropped), winsorized 1/99, minus the same day's mean over all gated
  rows. The 5-session result is reported, not tested.
- Null: each symbol's events rotated to random points ≥ 60 sessions away
  within its own 2022+ history, **5,000 rotations** (discovery used 1,000;
  more rotations only sharpen the p-value, smallest p 0.0002), seed 7.
- 90% CI: symbol-clustered bootstrap, 300 resamples.
- Period: 2022-01-01 to the end of the warehouse at run time (SIP daily
  through 2026-09-30 now); events need 20 forward sessions, so events
  after early September 2026 drop out. Minimum 200 events per rule, the
  harness default; a primary rule with fewer counts as a FAIL.
- Data as it stands at run time: EDGAR, Alpaca/Benzinga news and the
  DoltHub earnings table, refreshed nightly by `research-publish`. The
  news regexes, the earnings dating (first 8-K 2.02 within 120 days of
  period end) and the source adapters are unchanged since discovery.

## 4. Decision rules

For each of the four **primary** rules, on 2022+ at $0.10-$15, 20 sessions:

1. **One-sided p** in the discovery direction (the share of rotations at
   least as extreme as observed, that way).
2. **Holm** step-down across the four at **α = 0.05** (family-wise; valid
   when the tests are correlated). The strongest needs p ≤ 0.0125, then
   0.0167, 0.025, 0.05.
3. **PASS** = the 2022+ gap points the discovery way **and** Holm-adjusted
   p ≤ 0.05 **and** the 90% CI of the mean excess excludes the null
   median on that side (the harness's own candidate test).
4. **VALIDATED FOR USE** = PASS **and**, at $0.10-$5 on 2022+, the gap
   points the same way with its 90% CI clear of the null median (no extra
   correction). A PASS that fails this is reported as "passes, not in the
   traded band".
5. Everything else is **FAIL**. A FAIL is final for that rule; it isn't
   re-tested with other settings.

Secondary rules get the same statistics in a separate table, never a verdict.

**Money check (positive rules, reported, not pass/fail).** The mean
20-session return net of costs for the events vs the gated universe's
mean over the same period. Absolute returns in this warehouse are
inflated: a random in-band stock shows **+2.3% per 20 sessions after
costs in 2016-21**, which the falling equal-weight index (Charter
aggregates) contradicts — most likely the artifact guard dropping
reverse-split windows (mostly losers) and delisted names missing from the
ticker map. The gap and excess measures cancel that bias; the absolute
number does not, so it is only ever read against the universe's.

## 5. What each outcome leads to

- **Avoid rule validated** → added to the live red flags (README item 45)
  as a proven negative, next to "Offering filed".
- **Avoid rule passes but not in-band** → amber note at most, not a red flag.
- **Positive rule validated** → a candidate for the rules-based sleeve
  (README item 36), which still needs a cost-realistic money test
  (spreads by price bucket, item 40) before any capital.
- **FAIL** → dropped from the candidate list, recorded on `/research` as
  failed out of sample, not revisited with new settings.

Rough power: if each rule's 2022+ effect were as large as discovery's, at
similar n the p-values would be about 0.001-0.011, enough to pass Holm
for all four. In-band samples are smaller (roughly 400-600 events per
rule), so "passes, not in the traded band" is a likely outcome and means
the evidence is too thin there, not that the rule failed. Discovery winners usually shrink out of sample, so several
failures are the expected outcome, not a sign the test is broken.

## 6. Decisions (made 2026-10-01, before approval)

1. **Family: four rules.** 8-K 2.02 and 10-Q moved to secondary: they
   fail in-band on discovery data (so could never be validated for use)
   and largely duplicate earnings beat. Decided on 2016-21 data only. It
   eases the Holm bar for the rest (strongest p ≤ 0.0125, not 0.0083).
2. **Price-target cut: not tested** (section 2).
3. **α = 0.05 family-wise with Holm, plus the in-band requirement** for
   "validated for use": accepted.

Approved by merging this document. The run:

```
research/.venv/bin/python research/catalysts/holdout_2022.py --run --approved-commit <merge sha>
```

It runs the harness twice (primary band, then $0.10-$5), takes a few
minutes (a 65-type discovery run took ~30 s), writes `research/data/catalysts/runs/holdout_2022_<run>.md`,
and the results go into this document's RESULTS section unedited.

## RESULTS

Run once on 2026-10-01 against commit `a4af9b3`: `holdout_2022.py --run`,
harness runs `20261001T092244` ($0.10-$15) and `20261001T092357`
($0.10-$5), 5,000 rotations. The script's output, unedited apart from heading levels (its "gap
2016-21" column is the discovery period recomputed in the same run with
5,000 rotations):

### 2022+ holdout — run 20261001T092244 (+ $0.10-$5 run 20261001T092357)

#### Primary (Holm across 4 rules, alpha 0.05)

| rule | n | gap 2016-21 | gap 2022+ | 90% CI vs null | one-sided p | Holm p | verdict | $0.10-$5 2022+ gap | net 20d vs universe |
|---|---|---|---|---|---|---|---|---|---|
| news_halt | 1,865 | -3.65% | -9.46% | [-11.99, -9.36] vs -1.26% | 0.0002 | 0.0008 | **VALIDATED FOR USE** | -9.68% | — |
| news_partnership | 2,833 | -1.33% | -1.60% | [-2.33, -0.87] vs 0.09% | 0.0008 | 0.0016 | **VALIDATED FOR USE** | -2.15% | — |
| 10k | 5,172 | -0.83% | -1.03% | [-0.92, -0.12] vs 0.55% | 0.0004 | 0.0012 | **PASS, not in the traded band** | -1.04% | — |
| earn_beat | 6,941 | +0.87% | +0.34% | [0.79, 1.42] vs 0.76% | 0.1022 | 0.1022 | **FAIL** | +0.45% | +0.76% vs -0.88% |

#### Secondary (reported only, never PASS)

| rule | n | gap 2016-21 | gap 2022+ | 90% CI vs null | one-sided p |
|---|---|---|---|---|---|
| gc_10k | 781 | -2.77% | -1.01% | [-3.06, -0.30] vs -0.66% | 0.1800 |
| earn_big_beat | 3,627 | +0.93% | +1.16% | [1.41, 2.32] vs 0.74% | 0.0014 |
| 8k_2.02 | 18,957 | +0.45% | -0.19% | [0.19, 0.65] vs 0.63% | 0.8922 |
| 10q | 15,077 | +0.51% | +0.07% | [0.29, 0.79] vs 0.49% | 0.3521 |

**Reading.** Two avoid rules are validated for use: **trading halts**
(-9.5% vs the same names at random dates over 20 sessions, more than
double the 2016-21 effect, and -9.7% in the $0.10-$5 band) and
**partnership / licensing PRs** (-1.6%, -2.2% in-band). **10-Ks** pass but
their in-band range overlaps the random-date null, so they are not a red
flag. **Earnings beats fail** (+0.34%, p 0.10), as do the earnings-reporting
secondaries (2.02 -0.19%, 10-Q +0.07%). The earnings *big* beat secondary
(+1.2%, p 0.001) is not a pass — it is a subset of a failed rule and would
need its own pre-registered test.

