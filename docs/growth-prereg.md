# Pre-registration — does revenue growth rank catalyst candidates?

Written 2026-09-22, **before any return was computed**. This is
`docs/selection-logic.md` **M.1** ("Does relative quality beat absolute
flagging?") with a better input than cash runway.

Nothing in this document may be changed after the run. Results go in a
separate section below the line, added afterwards.

---

## Why this question

Every study this project has run tests **price, volume or filing
events**. Verified 2026-09-22: the only occurrences of `revenue` across
`research/*.py` are in `load_edgar.py`'s concept whitelist. `Revenues`
and `RevenueFromContractWithCustomerExcludingAssessedTax` are loaded into
`research/data/edgar/edgar_facts.parquet` — 7,669,806 facts, 16,973 CIKs,
`filed` 2009-04-15 to 2026-09-10 — and **no study has ever read them**.

It is therefore the only genuinely untested direction that does not
require new data, and it is backtestable point-in-time by `filed` with
machinery `catalyst_study.py` already has.

## What this is not

**Not a new candidate source, and not a new trigger.** The architecture
is catalyst-primary (`docs/selection-logic.md` Step 2). Growth is tested
as a **ranking input inside the existing 8-K pool** — Step 4 — never as a
reason for a name to appear. A standalone growth screen would be a new
mechanism and is out of scope here.

---

## Population

Identical to `catalyst_study.py`'s `8k_earnings` event, so the result is
directly comparable to the audited catalyst numbers:

- **Event:** 8-K item 2.02 (results of operations), 2016-01-01 onward.
- **Entry:** the close of the session *after* the first session on/after
  the filing date. The filing is public by then whatever time it was
  accepted.
- **Gates at entry:** raw close **$0.10–$5.00**, 20-day SIP dollar volume
  **≥ $2,500,000**.
- **Costs:** `max(1%, one tick, Abdi-Ranaldo spread)`, the spread-aware
  model (finding C1).
- **Periods 2016–21 and 2022+ always reported separately, never merged.**

## The feature — point-in-time revenue growth YoY

Constructed only from facts whose EDGAR `filed` date is on or before the
event date.

1. **Quarterly facts only:** `end − start` between 80 and 100 days,
   `unit = 'USD'`.
2. **First-reported value** per `(cik, concept, period end)` —
   `arg_min(val, filed)`. A later restatement cannot leak backwards.
3. **Q0** = the fact with the latest period end among those filed on or
   before the event date.
4. **Q−4** = a fact of the **same concept** whose period end is within
   **±45 days** of `Q0.end − 365 days`, also filed on or before the event.
   Requiring the same concept prevents a tag switch (`Revenues` →
   `RevenueFromContractWithCustomerExcludingAssessedTax`, common at the
   2018–19 ASC 606 transition) from manufacturing growth.
5. **Concept preference** when both are present for one event (1,494
   cases): `RevenueFromContractWithCustomerExcludingAssessedTax`.
6. `growth = (Q0.val − Q−4.val) / abs(Q−4.val)`.

**Two gates, both fixed now:**

- **`Q−4.val > 0`.** Growth off a zero or negative base is undefined.
- **Staleness: `Q0.end` within 180 days of the event.** This is the
  consequential one. Measured before pre-registering: across events with
  a computable YoY, the gap from Q0's period end to the event has median
  136 days, **75th percentile 412 days and 95th 2,317 days**. Delinquent
  and near-dead filers carry a "latest" quarter that is years old, and
  growth computed off a six-year-old statement is not growth. 180 days is
  one quarter plus a filing lag.

**Note on what Q0 is.** An 8-K 2.02 *is* an earnings release, so the
quarter being announced is not yet in XBRL at the event date. Q0 is
therefore the **previously filed** quarter. That is deliberate and
correct: it is what a reader could know before the open, and it is the
only version that is point-in-time honest.

## Sizes, measured before pre-registering (counts only, no returns)

| stage | total | 2016–21 | 2022+ |
|---|---|---|---|
| 8-K 2.02, in-band near the filing | 23,565 | 7,992 | 15,573 |
| with a computable YoY | 18,739 | — | — |
| with `Q−4 > 0` | 17,659 | 5,474 | 12,185 |
| **+ staleness ≤ 180d (the population)** | **13,917** | **4,305** | **9,612** |

Before the $2.5M dollar-volume floor, which will cut this further. About
**1,000–1,100 per quartile in 2016–21** and **2,400 in 2022+**.

---

## Primary analysis

**Quartiles of `growth` within the pool, computed per period.** Q4 =
fastest growth, Q1 = slowest (most negative).

**Primary metric: 20-day signed net return**, reported as mean, median,
`mean_ex_top1` (this project's own tail discipline) and **net win rate**
— the share of events closing up enough to clear the modelled round trip.
1- and 5-day are reported alongside but are not the primary.

**Also reported: U:D** — upside-reachable over downside-reachable within
the 20-day window, from daily highs and lows, against the pool's own
baseline. Required by `selection-logic.md` rule 1: no component may be
justified by a direction-blind metric.

### Pass threshold

Growth earns a ranking slot in Step 4 only if **all** hold:

1. **Q4 − Q1 net win rate ≥ 5 percentage points**, **same sign in both
   periods**.
2. **Q4 U:D ≥ Q1 U:D** in both periods.
3. The effect **vanishes under the negative control** (below).

**Power, stated honestly.** At ~1,050 per quartile in the thinner period
and a net win rate near 20%, the standard error of a single cell is
~1.2pp and of the Q4−Q1 difference ~1.8pp. A 5pp bar is ~2.8 SE there.
It is deliberately a *high* bar: with four quartiles, two periods and
three horizons the family is large, and both-period agreement is the main
correction being relied on.

**Monotonicity is not required** and will not be claimed. Q2/Q3 are
reported for shape only.

## Negative control — built in from the start, not added later

`--negative-control within-date`: permute `growth` across the events
sharing an entry date, leaving every return untouched. The Q4−Q1
difference must collapse to ~0. **A result that survives the shuffle is a
harness bug and the run is withdrawn**, per `research-audit-plan.md`
Layer 2.

This study has the control from its first run. Both existing studies had
to have one retrofitted.

## Coverage-bias check — mandatory, reported with the result

The population is a subset: symbols filing detailed quarterly XBRL. That
is **not random** — shells, trusts, 20-F foreign filers and the most
distressed names are missing. Of in-band symbols 2022+, 3,134 of 3,734
map to a CIK and only 2,109 have any revenue fact.

So the run reports the **no-YoY events as their own cell**, on the same
metrics. If the has-data and no-data cells differ materially at baseline,
the quartile comparison is confounded by filing quality and **must be
reported as such rather than as a growth effect**. This is finding C2's
failure mode ("unknown treated as clean") and is the most likely way this
study produces a wrong answer.

## Secondary analyses — declared now, not after

Reported, clearly labelled secondary, no bearing on the pass decision:

- **S1.** `Q−4 ≥ $1,000,000`. A micro-cap growing revenue from $10k to
  $110k is +1000% and means nothing.
- **S2.** The same test over *all material 8-K* events (tier C), not just
  2.02.
- **S3.** `op_cash_flow_ttm` sign as an alternative quality input.

## Number of passes: one

One run, one report. No threshold sweeps, no re-cuts after seeing the
answer, no "what if terciles". Any further question against this pool is
a new, explicitly non-holdout question and is labelled as such.

## What a pass and a fail each mean

| result | consequence |
|---|---|
| all three conditions hold | growth becomes a Step 4 ranking term at low weight, marked single-study; the green flag on `revenue_growth_yoy` is re-earned |
| win-rate bar met in one period only | period-specific; reported, not adopted |
| Q4 ≈ Q1 | growth does not rank catalyst candidates. Record it and stop — this is a real answer and closes the last untested direction |
| effect survives the shuffle | harness bug; withdraw and fix before reporting anything |

**A null is a publishable result here** and must be written into the
README with the same prominence as a pass.

---

## RESULTS

*Empty until the run. Added below this line, never above it.*
