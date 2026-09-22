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

Run 2026-09-22. `research/growth_study.py`. Nothing above this line was
changed after the run.

### Headline: the primary question is a clean null

**Revenue growth does not rank catalyst candidates.**

| | 2016–21 | 2022+ |
|---|---|---|
| Q4 − Q1 net win rate | **−0.2pp** | **+1.0pp** |
| ≥ 5pp bar | no | no |
| U:D Q4 ≥ Q1 (both thresholds) | no | no |
| same sign both periods | **no** | |

Population after the $2.5M floor: 5,251 events; 1,062 / 2,486 with a
computable point-in-time YoY (64% / 69% coverage).

| cell | period | n | med growth | 20d win | 20d net | ex-top1% | PF | U:D10 | U:D20 |
|---|---|---|---|---|---|---|---|---|---|
| Q1 | 2016–21 | 266 | −50% | 44% | +4.42% | +2.69% | 1.43 | 1.07 | 1.46 |
| Q2 | 2016–21 | 266 | −10% | 46% | +1.38% | −0.56% | 1.14 | 1.07 | 1.42 |
| Q3 | 2016–21 | 265 | +11% | 43% | −1.15% | −2.97% | 0.89 | 1.06 | 1.08 |
| Q4 | 2016–21 | 265 | +120% | 44% | −1.36% | −2.95% | 0.86 | 0.93 | 1.21 |
| Q1 | 2022+ | 622 | −39% | 35% | −4.71% | −7.02% | 0.64 | 0.97 | 1.06 |
| Q2 | 2022+ | 622 | −5% | 37% | −2.43% | −5.06% | 0.77 | 0.85 | 1.04 |
| Q3 | 2022+ | 621 | +11% | 39% | −2.20% | −3.86% | 0.78 | 1.00 | 1.24 |
| Q4 | 2022+ | 621 | +101% | 36% | −4.15% | −5.91% | 0.68 | 0.90 | 0.98 |
| no-data | 2016–21 | 607 | — | 41% | −1.34% | −2.76% | 0.87 | 0.97 | 1.14 |
| no-data | 2022+ | 1,096 | — | 37% | −4.48% | −6.24% | 0.67 | 0.90 | 1.02 |
| POOL | 2016–21 | 1,669 | −0% | 43% | +0.04% | −1.49% | 1.00 | 1.01 | 1.24 |
| POOL | 2022+ | 3,582 | +1% | 37% | −3.71% | −5.62% | 0.70 | 0.92 | 1.05 |

Win rate is flat across quartiles in both periods (44/46/43/44 and
35/37/39/36). There is no ordering to exploit.

### The most important result is the noise floor, and it indicts the bar

200 permutations of `growth` within period, returns untouched:

| | median | p05 | p95 | largest \|draw\| |
|---|---|---|---|---|
| 2016–21 | −0.6pp | −7.0pp | **+8.5pp** | 11.9pp |
| 2022+ | −0.1pp | −3.6pp | **+4.7pp** | 7.0pp |

**The pre-registered 5pp bar is inside the noise in 2016–21.** A pure
shuffle clears it roughly a fifth of the time there.

**The pre-registration's power statement was wrong.** It computed a
~1.8pp standard error from 1,050 per quartile — the count *before* the
$2.5M dollar-volume floor. The floor cut the population from 13,917 to
5,251, giving 266 per quartile in 2016–21, and the real SE is about 3pp.
The document did flag that the floor "will cut this further"; the SE line
was not recomputed. **The bar was not moved after the fact** — moving it
is exactly the discretion pre-registration exists to remove — so it
stands as registered, with the error recorded.

The conclusion is unaffected: the observed differences (−0.2pp, +1.0pp)
are near zero, not merely under the bar. The both-period same-sign
requirement was doing the real work.

### The control also found a bug in itself

The first control implementation ran `create or replace temp table ev as
… from ev` — reading a table while replacing it. It silently fanned the
rows out, doubling 2016–21 (POOL 2,731 against the primary's 1,669), and
one draw produced a **+5.0pp** Q4−Q1 on shuffled data, exactly on the
bar. Rebuilt against a pristine `ev_base` with a row-count assertion.
Counts now match the primary exactly.

### Coverage-bias check — present but mild (for growth)

The no-data cell is modestly worse than the pool (41% win / −1.34% vs
43% / +0.04%; 37% / −4.48% vs 37% / −3.71%), not dramatically so. Filing
quality does carry a little signal, but not enough to explain away a null
that has nothing to explain.

### Secondaries

| | 2016–21 | 2022+ | verdict |
|---|---|---|---|
| **S1** `Q−4 ≥ $1M` | −3.9pp | +2.6pp | null |
| **S2** all material 8-K (n up to 2,298/quartile) | −1.1pp | +4.4pp | null |
| **S3** operating cash flow ÷ revenue | **+3.7pp** | **+8.9pp** | see below |

S2 is the strongest test of the primary question — four times the n, same
answer. Growth is not a ranking input on this universe.

### S3 is a real lead, and is not established

Operating cash flow is the only thing in this study that moved. Q4 (least
cash-burning) beats Q1 (median burn ~10× revenue) with the **same sign in
both periods**, and **U:D Q4 ≥ Q1 at both thresholds in both periods** —
U:D10 1.05/1.04/1.24/1.17 and 0.97/0.90/1.19/1.19. Q3 in 2022+ is the
only positive-net cell anywhere in this study (+0.56%, PF 1.07).

**It is not established, on three grounds:**

1. **Its own noise floor, measured the same way:** 2016–21 p05/p95
   **−11.2 / +12.2pp**. The +3.7pp there is indistinguishable from zero.
   Only 2022+ (+8.9pp against a ±6.5pp floor) sits outside. One period
   out of two, which is this project's standing definition of
   not-a-result.
2. **Coverage is 23% / 33%**, far worse than revenue's 64% / 69%, and the
   no-data cell is clearly worse than the pool in both periods. Companies
   filing quarterly cash-flow detail are the better-governed ones. This
   is finding C2's failure mode and it is live here.
3. **It is a declared secondary**, which this document committed in
   advance has no bearing on the decision. Promoting it now would be the
   exact move pre-registration exists to prevent.

**Recommendation:** S3 earns its own pre-registration, with the coverage
problem addressed first (annual `NetCashProvidedByUsedInOperatingActivities`
would lift coverage materially) and quartile sizes chosen against a
measured noise floor rather than an assumed SE. It does **not** enter
`selection-logic.md` Step 4 on this evidence.

### Consequences

- **`selection-logic.md` M.1 is answered for growth: no.** Step 4.4
  ("relative quality") gains nothing from revenue growth and should not
  be built around it.
- **The `revenue_growth_yoy` display flag stays amber.** It was demoted
  from green on 2026-09-22 (#200) on the grounds that it was unmeasured.
  It is now measured, and it did not earn green back.
- **The last untested direction is closed for revenue growth**, and
  re-opened, narrowly, on cash flow.
- A directional hint worth one line: Q4 has the lowest U:D10 in 2016–21
  in all three growth variants (0.93, 0.91, 0.91). Fastest-growth names
  may be slightly *worse* directionally. **Not claimed as a finding** —
  no noise floor was computed for U:D.
