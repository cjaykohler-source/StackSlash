# Two-sided points score (README item 38)

Written 2026-10-01. `research/score_two_sided.py`; output
`research/data/study_outputs/score_two_sided_20261001T095852.txt`.

## Question

`score_poc2.py` ranked stock-days by P(+30% within 5 sessions) and ranked
well (top 5% at 3.3x the base rate) but didn't monetize (+0.19% vs random
-0.15%): its top names were the most volatile in both directions. Does
ranking by **P(+30%) − P(−20%)** fix that?

## Design (fixed in the script header before running)

Everything from `score_poc2.py` (universe $0.10-$5 with $250k 20-day
dollar volume, signals, the validated vetoes, one-hot scorecard, L2
logistic, execution variants, top 5 per day, cost max(1%, tick)), plus a
second model for "min low within 5 sessions ≤ −20%". Each model's L2 and
confluence pairs chosen on 2019 (fit 2016-18); execution chosen on 2019;
refit 2016-19 and scored 2020-21 once — **the second use of 2020-21**
(the first was `score_poc2.py`'s test). 2022+ untouched.

Pass needed all four: (1) net hit rate (up-hits minus down-hits) rising
across score deciles in ≥ 8 of 9 steps; (2) top 5% net hit positive and
above the up-only score's; (3) the chosen execution's trade beats random
entries on the same days with the 90% interval of the difference above 0;
(4) it beats the up-only score's trade.

## Result — FAIL (3 of 4)

Chosen on 2019: L2 0.001 for both models, no confluence pairs, execution
E4 (next open, +30% limit, else day-5 close, skip opens gapping > +15%).

| 2020-21, E4 | |
|---|---|
| 1 net deciles | **FAIL** 7/9 (D1 −5.7%, D10 +7.0%) |
| 2 top 5% net hit | PASS +9.0% (up 19.8%, down 10.9%) vs up-only +4.4% |
| 3 trade vs random | PASS +0.71% vs −0.41% per trade, 90% CI of the difference [+0.50%, +1.69%] |
| 4 vs up-only score | PASS +0.71% vs +0.18% |

Diagnostics (not criteria):

- **Not a few trades:** without the top 1% of trades, +0.42% vs random
  −0.72% (up-only −0.11%).
- **Mostly one year:** 2019 (validation) −0.16% vs random −0.29% — no
  separation; 2020 **+1.40%** vs −0.23%; 2021 +0.02% vs −0.60%.
- Median trade −2.2%, win rate 43%: the edge is in the right tail.

## Reading

Adding the down model does what it was meant to do: the top of the ranking
now leans up instead of just being volatile (top-5% net hit +9.0% vs
+4.4%), and the trade beats random entries in every year, 2019 included.
But it only made money in absolute terms in 2020, it showed nothing on the
validation year, and the decile shape missed the bar. It is not a tradable
edge, and not worth spending the 2022+ holdout on in this form.

What would make it worth another look: a separation that holds in 2019 as
well as 2020-21, before any 2022+ test.
