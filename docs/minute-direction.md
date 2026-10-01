# Minute-bar direction on lead-up days (README item 39)

Written 2026-10-01. `research/minute_direction.py`; output
`research/data/study_outputs/minute_direction_20261001T102109.txt`.

## Question

Volume builds for ~2 weeks before big moves in either direction, and the
daily bars carry no direction (`leadup_profile.py`). Does the **first big
day's intraday action** — opening-range break, VWAP, when the high and low
print, late volume — say which way the next 5 sessions go?

## Design (fixed in the script header before running)

First day with volume ≥ 5x its 20-day mean after a lead-up (median volume of
the prior 10 sessions ≥ 1.5x its median over sessions −40..−11), band and
liquidity judged at the previous close, 2016-03 to 2021-12-22 (outcomes
close inside 2021; 2022+ untouched). Winner = +30% within 5 sessions without
−20%; loser = the reverse. Eight minute-bar features from the SIP minute
warehouse. Stage A (2016-19): AUC, 2,000-shuffle p, BH across the eight;
carried if q ≤ 0.10 and |AUC − 0.5| ≥ 0.03. Stage B (2020-21, once): AUC,
Holm, and a favourable-tercile trade vs all events.

## Result — inconclusive (too few events)

| | |
|---|---|
| first big days after a lead-up, 2016-21 | 1,016 (1,006 with usable minute data) |
| labelled (winner or loser), stage A 2016-19 | **86** (29 winners) |
| labelled, stage B 2020-21 | 251 |

Stage A: no feature carried (best: late-volume share AUC 0.355, p 0.032;
time of the high 0.370, p 0.043; both q 0.17 after correcting for eight).
Stage B was never reached.

**Why so few.** The lead-up condition is rare on the days that matter:
of 5,937 first big-volume days in the band (2016-03 to 2021-12), only
1,022 had a lead-up — the median first big day's lead-up ratio is 0.95,
i.e. no build at all. With 86 labelled events the test could only have
seen a very large effect. This is a failure to detect, not evidence of no
effect.

## Possible follow-up (not run)

The same eight features on **all first big-volume days** (≈5,900, ~6x the
sample), dropping the lead-up condition — the direction question doesn't
need it. It would need its own pre-registration; note that the 86 stage-A
lead-up events above (a subset) have now been looked at.
