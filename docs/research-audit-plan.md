# Research audit — verifying the numbers everything rests on

Written 2026-09-21.

**Why.** Every strategy decision in this project — which triggers are
enabled, which are disabled, the "no edge" verdict, and the selection
logic in `docs/selection-logic.md` — rests on numbers produced by a
single implementation of each study. Those implementations have never
been independently verified, and this project has documented **six**
silent-corruption bugs in its own measurement. Four changed a headline
result; two were reported as findings before being caught. "Silent" means
six is a floor, not a total.

A seventh was found on 2026-09-21 by accident: `eod-scan` runs 17:45 ET
while `sec-filings-sync` lands that session's filings at 22:30, so
production's `bigmove_score` has never included its 8-K point — while
`bigmove_study.py` computes that point from EDGAR acceptance times. The
study and production have been measuring different scorers.

**Method.** Three layers, in order. Layer 2 is the highest yield per hour
and is the thing this project has never had.

---

## Layer 1 — Static audit (~4h)

Read each study against the bug families that have already bitten:
silent row-cap truncation, forward-return misalignment, lookahead in
rolling denominators, split/gap handling, point-in-time violations,
survivorship, and definitional drift from production.

| study | status | carries |
|---|---|---|
| `bigmove_study.py` | **done — see below** | the 3–9× lift; Phase A depends on it |
| `catalyst_study.py` | pending | 8-K 2.02, the only positive direction signal |
| `daily_trigger_study.py` | pending | the 2026-09-17 disable decisions |
| `schema_lab.py` | pending | the minute-level results |
| `tradingCosts.ts` + `sim-flip-exits.ts` | pending | the cost model that settled the verdict |
| `backtest-triggers.ts` | pending | `trigger_stats`, the PF table |

### 1.1 `bigmove_study.py` — findings

**The code is better than expected.** It is materially more rigorous than
any of the external sources reviewed this week, and several things it
does are correct in ways that are easy to get wrong:

- **No lookahead in rolling windows.** `adv_prior` (20 preceding → 1
  preceding), `atr_prior` (14 → 1) and `ar_s2` (20 → 1) all exclude the
  current day. The Abdi-Ranaldo estimator carries an explicit comment
  about lagging because it uses η of t and t+1.
- **Split handling is deliberate and correct.** `sip_bars_daily_split`
  for returns and ranges, `sip_bars_daily_raw` for the price band and
  volume ratios — as-traded price for band membership, split-adjusted for
  returns.
- **Forward returns are guarded.** `nc / c between 0.1 and 10` catches
  unadjusted splits; `date_diff('day', date, nd) <= 7` catches halts and
  stale next-sessions.
- **Filing timing is point-in-time.** Acceptances after 17:45 ET roll to
  the next session. The study does not peek at filings that were not
  public.
- **Costs are charged** — `greatest(tick/price, 0.01, spread_est)`.
- The 1,000-row-cap family does not apply: this is DuckDB SQL, not
  PostgREST.

**Findings, in order of consequence:**

**F1 — The 8-K window is 5 days in the study, 1 session in production.**

```sql
from fl asof join (select symbol, date from d) d
  on fl.symbol = d.symbol and fl.adate <= d.date
where d.date - fl.adate <= 5
```

`f_8k` is true if a filing was accepted within **5 calendar days**. The
documented `bigmove_score` point is *"an 8-K filed since the previous
session"* — roughly 1 session. These are different features, and the
study's is substantially looser.

Combined with the 22:30 timing defect, the 8-K point differs from
production in **two independent ways**. The published 3–9× lift is a
property of a scorer that has never run.

*Consequence:* Phase A cannot be interpreted against production until the
definitions are reconciled. Decide which window is intended, make study
and production agree, and re-derive the ≤$5 baseline before spending the
$5–$10 holdout on it.

**F2 — `dollar20` includes the current day, which biases the floor
filter toward candidates.**

```sql
avg(cr * rv) over (... rows between 19 preceding and current row) dollar20
```

This is point-in-time legitimate — day t's volume is known at t's close —
but it creates a selection asymmetry. A `vol_ratio >= 3` day inflates its
own `dollar20`, so candidate days clear `dollar20 >= floor` more easily
than ordinary days of the same name. Baseline and candidate sets are
therefore filtered by a criterion correlated with the candidate
condition, which can inflate lift.

*Test:* recompute with a prior-only `dollar20` (20 preceding → 1
preceding) and compare lift. If it moves materially, the prior-only
version is the honest one.

**F3 — `f_offer` lumps registration with pricing.** `bool_or(form <> '8-K')`
merges S-1, S-3, F-1, F-3, 424B4 and 424B5. A shelf registration is not a
priced offering, and `catalyst_study.py` reports them separately (424B4
−17%). This matters beyond this study: `docs/selection-logic.md` uses
"offering filed ≤30d" as a **hard exclusion**, and that rule inherits the
conflation.

**F4 — No negative control anywhere.** The script computes lift but never
validates its own harness. A date-shuffle would have caught the
forward-return misalignment bug immediately. See Layer 2.

**F5 — `score>=3` is the best of 17 candidates, uncorrected.** 17
conditions × 2 periods × 3 metrics × 3 spread tiers. The reported lift is
a maximum over a family, with no multiple-comparison correction, and the
README already flags 2022+ as "seen, not a sealed holdout." The true
expected lift is below the published figure by an unknown amount.

**F6 — Survivorship unverified.** The `band` CTE requires ≥60 in-band
sessions since 2016. Whether `sip_bars_daily_raw` contains delisted
symbols is *claimed* (README: the SIP reload is survivorship-free) but
not verified here. Needs a runtime check, not an assumption.

**F7 — ASOF join direction needs runtime confirmation.** The intent —
map each filing to the first session on/after its `adate` — is stated and
looks right, but ASOF inequality semantics are exactly the kind of thing
that silently does the opposite. Verify with a hand-checked example
rather than by reading.

---

## Layer 2 — Negative controls (~3h)

The highest-yield layer, and the one this project has never had. Run each
existing study against inputs where the correct answer is known in
advance.

| control | expected result | catches |
|---|---|---|
| Shuffle outcome dates within symbol | lift → ~1.0× | forward-return misalignment, lookahead |
| Randomise the candidate label | all effects vanish | leakage, harness bugs |
| Random in-band days as the "signal" | matches baseline exactly | base-rate/control construction errors |
| Assert row counts at every join | no silent drops | the truncation family |
| Duplicate the input, halve nothing | identical rates, doubled n | grouping/aggregation errors |

A date-shuffle test would have caught bug #6 (forward-return
misalignment). A row-count assertion would have caught the 1,000-row-cap
family. Both are cheap, and both target the failure mode this project
actually exhibits — quietly optimistic numbers rather than crashes.

**Done when.** Every study has a `--negative-control` mode, and the
controls produce the expected null result. Any study that shows lift on
shuffled data is broken and its published numbers are withdrawn until
fixed.

---

## Layer 3 — Independent reimplementation (~10h)

Differential testing: a second implementation written from the **README's
claims**, not from the existing code, then compared.

**Anti-anchoring rule.** The second implementation is specified from the
published claim — e.g. *"score ≥3 produces a 10%+ next-session move at
35.4%/42.8% against a 6.7%/9.3% base rate"* — which is a complete
specification. It is written without consulting the first implementation,
and only compared afterwards.

**Different data path where possible.** Source from production Supabase
`bars_daily` rather than the DuckDB warehouse. Not fully independent —
both trace to Alpaca — so this catches transformation bugs but not
ingestion bugs. For ingestion, use data invariants instead: splits
reconcile against corporate actions, a sampled re-fetch from Alpaca
matches stored bars, no zero-volume rows survive, no `close` outside
`[low, high]`.

**Priority, by consequence:**

1. **`bigmove_score` lift** — Phase A depends on it; it is the whole
   selection mechanism.
2. **8-K 2.02 catalyst** — the only positive directional signal and the
   only enabled Buy.
3. **The cost model** — it settled the entire strategy verdict.
4. The disable decisions — **lowest priority.** The documented failure
   mode is optimistic bugs, which do not explain negative results. The
   disabled triggers are probably safely disabled.

### The disagreement protocol — agreed before any number exists

On disagreement between implementations, **neither number is used** until
the discrepancy is explained and the explanation is demonstrated with a
minimal reproducing case. No splitting the difference, no preferring the
implementation that matches the README.

---

## Consequence for Phase A

`docs/overhaul-plan.md` Phase A spends the $5–$10 holdout — the only
unexamined data this project owns — on one pre-registered run of
`bigmove_study.py`.

**Do not run it until Layers 1 and 2 are clear for that script.** If the
instrument has a defect, the holdout is burned for a number that cannot
be trusted, which is exactly how the PF 1.78 artifact happened.

F1 also forces a decision before Phase A: the study's 5-day 8-K window
and production's 1-session window must be reconciled, and the ≤$5
baseline re-derived under whichever is chosen. **Phase A's 2.5× pass
threshold was set against the published 3–9×; if the audited baseline
moves, the threshold must be rebased before the run, not after.**

## What this audit does not assume

That the README is wrong. Most of `bigmove_study.py` is careful,
well-documented work, and its explicit point-in-time discipline is better
than the external literature reviewed this week. The purpose is to find
out which numbers survive independent checking — not to assume they
won't.
