# Layer 3 audit: `catalyst_study.py`, 8-K 2.02 (pre-registered)

Written 2026-11-17, merged before any run. Implements Layer 3 of
`docs/research-audit-plan.md` (independent reimplementation) for the study
behind the only enabled Buy trigger.

## What is tested

The `8k_earnings` / `all` rows and the `BASELINE (random in-band day)` rows of
`research/data/study_outputs/catalyst_study_2500000_20260922T102136.csv`
(the run that reproduces the published figures; cost model max(1%, one tick)),
horizons 1 / 5 / 20, periods 2016-21 and 2022+, at the default floor $2.5M and
max price $5. The `excl_flags` variant is out of scope (it needs the
fundamentals flags, a separate spec).

## Method

Two `auditor` subagents (`.claude/agents/auditor.md`) run in parallel, each
from the spec below only, never seeing the original code, its outputs, or each
other's work. Scripts: `research/audit/catalyst_l3_a.py`, `catalyst_l3_b.py`.

### Spec handed to both agents

> Event: an SEC 8-K whose items include 2.02 (results of operations), mapped
> from CIK to ticker. Filing events: entry at the CLOSE of the session AFTER the
> first trading session on/after the filing date. Gates at entry: as-traded
> close $0.10 to $5.00 and 20-day SIP dollar volume >= $2,500,000. Returns: 1, 5
> and 20 sessions from the entry close on split-adjusted closes, net of a
> round-trip cost of max(1%, one tick) where one tick is $0.01 relative to the
> entry price. Baseline: every gated in-band day, same returns and cost. Periods
> by entry date: 2016-2021 and 2022 onward. Report per (event or baseline,
> period, horizon): n, win rate (net > 0), mean net, median net, profit factor
> (sum of positive net / |sum of negative net|).

## Pass / fail, fixed now

Per cell (12 for the event, 12 for the baseline):

- **Agree:** n within 2%, and mean net within 0.30 percentage points.
- **Disagree:** anything else.

The claim survives Layer 3 if all 12 event cells and all 12 baseline cells
agree between the original and at least one independent implementation, and
the two independent implementations' own differences are explained.

**Disagreement protocol** (from the audit plan): on any disagreement neither
number is used until the discrepancy is explained by a minimal reproducing
case. No splitting the difference; no preferring the implementation that
matches the README.

## Result

Run 2026-11-17. **Verdict: does not pass as pre-registered. 10 of 12 cells
disagree; neither set of numbers is used until the gaps are explained.**

### The two independent implementations agree with each other

Auditor A (numpy-free Python + DuckDB) and auditor B (SQL-first) never saw the
original code, its outputs, or each other's files (checked in their
transcripts). They match on every cell to within 5e-7. Scripts:
`research/audit/catalyst_l3_a.py`, `catalyst_l3_b.py`.

### Amendment before scoring (data window)

The pre-registration compared against the 2026-09-22 output, but the warehouse
has changed since (bars to 2026-11-16, the 10-31 backfill, a newer EDGAR ticker
file). The original was re-run on today's data with its published settings
(`--no-spread-cost`; `catalyst_study_2500000_20261117T141858.csv`) so all three
implementations see the same bars. Thresholds unchanged.

### Scored against the original on matched data

| kind | period | h | n original | n auditors | n diff | mean original | mean auditors | diff (pp) | verdict |
|---|---|---|---|---|---|---|---|---|---|
| event | 2016-21 | 1 | 1,575 | 1,661 | +5.5% | -0.88% | -0.73% | +0.14 | disagree (n) |
| event | 2016-21 | 5 | 1,575 | 1,661 | +5.5% | -0.13% | -0.29% | -0.16 | disagree (n) |
| event | 2016-21 | 20 | 1,575 | 1,661 | +5.5% | +2.95% | +2.77% | -0.18 | disagree (n) |
| event | 2022+ | 1 | 3,665 | 3,811 | +4.0% | -1.06% | -1.19% | -0.13 | disagree (n) |
| event | 2022+ | 5 | 3,582 | 3,721 | +3.9% | -1.34% | -1.44% | -0.10 | disagree (n) |
| event | 2022+ | 20 | 3,456 | 3,588 | +3.8% | -0.82% | -0.96% | -0.14 | disagree (n) |
| baseline | 2016-21 | 1 | 209,064 | 214,781 | +2.7% | -0.88% | -0.84% | +0.04 | disagree (n) |
| baseline | 2016-21 | 5 | 208,873 | 214,638 | +2.8% | -0.30% | -0.20% | +0.11 | disagree (n) |
| baseline | 2016-21 | 20 | 208,176 | 214,183 | +2.9% | +1.87% | +2.49% | +0.62 | disagree (n, mean) |
| baseline | 2022+ | 1 | 375,816 | 382,126 | +1.7% | -1.20% | -1.37% | -0.17 | agree |
| baseline | 2022+ | 5 | 373,963 | 380,234 | +1.7% | -1.84% | -2.00% | -0.16 | agree |
| baseline | 2022+ | 20 | 366,936 | 373,193 | +1.7% | -3.68% | -3.30% | +0.39 | disagree (mean) |

Event means agree within 0.18 pp everywhere; the counts and the 20-session
baseline do not. What the claim rests on, the 20-session edge over the
baseline:

| | 2016-21 | 2022+ |
|---|---|---|
| original | +1.08 pp | +2.86 pp |
| auditors | +0.28 pp | +2.33 pp |

The 2022+ edge holds in both; the 2016-21 edge mostly disappears in the
auditors' build, through the baseline, not the events.

### Candidate explanations (from reading the original after scoring)

Choices in `catalyst_study.py` that its published description does not state:

1. Universe limited to symbols with >= 60 in-band days since 2016.
2. Zero-volume flat placeholder bars dropped.
3. A return is voided if its window holds a >= 10x or <= 0.1x daily move or
   spans more than 2h+7 calendar days (bad-print guard). Likely the main cause
   of the 20-session baseline gap: the auditors keep bad prints.
4. Tick = $0.0001 below $1, so cost is effectively a flat 1%; the auditors
   charged $0.01 / price (above 1% below $1).
5. Entry on the symbol's own next bar, not the market's next session.
6. Ticker map from two EDGAR files, one CIK per ticker.

### Also found

- **Survivorship in the ticker map.** EDGAR's ticker file is a current
  snapshot. The original's own 2016-21 event count fell from 1,617 (09-22) to
  1,575 (today) as companies left the file. Pre-2022 event results are
  survivor-biased in every implementation; the baseline is not.

### Next (not yet run)

Attribution ladder: add choices 1-6 to one auditor script one at a time and
show which closes each gap (the protocol's minimal reproducing case). Then
decide whether each choice belongs in the spec.
