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

## Follow-up: all first big-volume days (run 2026-10-01, approved before running)

`research/minute_direction_wide.py` — the same design with the lead-up
condition dropped; output `minute_direction_wide_20261001T141034.txt`.
The 86 lead-up events from the first run are a ~1/6 subset of this sample.

| | |
|---|---|
| first big-volume days, 2016-21 | 5,917 (5,876 with minute data) |
| labelled, stage A 2016-19 | 537 (203 winners) |
| labelled, stage B 2020-21 | 1,058 |

Stage A carried two features: **share of minutes above the running VWAP**
(AUC 0.592, q 0.012) and **close vs session VWAP** (0.569, q 0.048).
Opening-range break (0.543, q 0.16) and time of the low (0.456, q 0.17)
missed.

Stage B (2020-21, once):

| feature | AUC A → B | Holm p | favourable tercile trade | all events | 90% CI of difference | verdict |
|---|---|---|---|---|---|---|
| above VWAP | 0.592 → **0.554** | **0.009** | −1.54% | −2.84% | [−0.03%, +2.56%] | FAIL (trade) |
| close vs VWAP | 0.569 → 0.481 | 0.28 | −3.47% | −2.84% | [−1.65%, +0.38%] | FAIL (flips) |

**Reading.** Time spent above VWAP on the first big day is the first
intraday feature in this project whose *direction* holds out of sample:
days that spent most of the session above VWAP were more often followed by
+30% than by −20%. It does not make a trade: buying first big-volume days
loses −2.84% over five sessions after costs on average, and the better
tercile only loses less (−1.54%). The useful reading is the other way
round — first big days that spent the session **below** VWAP are the worse
ones — which would be an avoid rule, and would need its own pre-registered
test (2022+ untouched) before it is used. Close vs VWAP alone flips.

## Below-VWAP as an avoid rule — not pursued (discovery, 2026-10-01)

`research/below_vwap.py --discovery` (output
`below_vwap_discovery_20261001T141932.txt`), 2016-21 only. Flag = share of
the session above the running VWAP ≤ 0.2474 (the lower tercile of 2016-19
first big days); outcome = 5 sessions from t+1's open, net.

| | flagged | rest | difference |
|---|---|---|---|
| 2016-19 | −1.36% | −1.74% | **+0.38%** (wrong way), p 0.63 |
| 2020-21 | −3.53% | −2.51% | −1.02%, 90% CI [−2.29%, +0.21%], p 0.12 |
| 2016-21 | −2.51% | −2.15% | −0.36%, CI [−1.53%, +0.74%], p 0.35 |
| P(−20% in 5) | 17.6% | 17.6% | none |
| P(+30% in 5) | 8.4% | 13.8% | −5.4 points |

The direction signal is entirely in the upside: below-VWAP first big days
produce fewer big winners, not more big losers, and their average return is
not meaningfully worse. As an avoid rule it fails on discovery data, so it
was **not pre-registered and 2022+ was not spent on it**. The script keeps
its frozen `--holdout` mode (CUT unset) only in case a better-specified
version is ever proposed.
