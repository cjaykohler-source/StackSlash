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

_Filled in after the run._
