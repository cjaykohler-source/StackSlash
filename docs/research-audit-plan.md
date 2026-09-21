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

---

## Layer 2.1 — `bigmove_study.py` negative controls: RESULT

Run 2026-09-21, all at `--max-price 5` so the $5-$10 holdout stays
untouched. Two complementary controls:

- **within-symbol** — permute each symbol's outcomes across its own days.
  Breaks t → t+1, keeps symbol identity. The floor is lift from simply
  selecting volatile names.
- **within-date** — permute outcomes across the symbols trading that
  session. Breaks symbol identity, keeps the calendar day. The floor is
  lift from candidates clustering on volatile market days.

### 1. The study exactly reproduces its published numbers

| claim (README) | reproduced |
|---|---|
| random in-band day ≥10% move: 6.7% / 9.3% | **6.7% / 9.3%** |
| `score>=3`: 35.4% (5.3x) / 42.8% (4.6x) | **35.4% (5.3x) / 42.9% (4.6x)** |
| `score>=2`: 27.6% (4.1x) / 34.8% (3.8x) | **27.6% (4.1x) / 34.9% (3.8x)** |
| `score>=3` touch ±20%: 26.5% (7.6x) / 36.4% (7.7x) | **26.5% (7.6x) / 36.4% (7.8x)** |

The README is faithful to its own code. This rules out the failure mode
that produced the PF 1.78 artifact — numbers transcribed from a different
or since-broken run.

### 2. The controls, and what survives them

| candidate | period | real | within-symbol | within-date | residual |
|---|---|---|---|---|---|
| `score>=3` | 2016-21 | 5.3x | 1.3x | 1.1x | **~4.1x** |
| `score>=3` | 2022+ | 4.6x | 1.3x | 1.0x | **~3.5x** |
| `8k_2.02` | 2016-21 | 3.0x | 1.1x | 1.1x | **~2.7x** |
| `8k_2.02` | 2022+ | 3.2x | **0.9x** | 1.1x | **~2.9x** |
| `vr25` | 2016-21 | 6.5x | 1.3x | 0.9x | ~5.0x |
| `vr25` | 2022+ | 5.9x | 1.5x | 1.0x | ~3.9x |

**The within-date control passes cleanly (1.0–1.1x).** That is the
decisive check that the harness is not broken: break symbol identity
while holding the session fixed and the lift vanishes, exactly as it
should. Candidates are not merely clustering on volatile market days.

**The within-symbol floor is 1.3x** — a real but modest confound. Roughly
a quarter of the headline lift is "these are names that move a lot on any
day"; the remaining **~3.5–4.1x is genuine day-level signal**.

### 3. `8k_2.02` is the cleanest candidate

Its within-symbol floor is **0.9x in 2022+** — below one. Essentially
none of its lift comes from symbol selection, where every
volatility-based candidate carries 1.3–1.5x.

The catalyst mechanism is materially cleaner than the attention
mechanism. `docs/selection-logic.md` should weight it above the attention
path rather than treating the two as equivalent.

`vr25` at 6.5x/5.9x with a **27%/30% up share** independently
corroborates the blow-off exclusion: enormous movement, mostly downward.

### 4. Verdict

`bigmove_study.py` **passes Layer 2.** Its numbers reproduce, its harness
survives the decisive control, and its headline lift is overstated by
about 1.3x rather than fabricated. Phase A's threshold should be rebased
against the residual (~3.5–4.1x at ≤$5), not the headline 4.6–5.3x.

The static-audit findings F1 (5-day vs 1-session 8-K window) and F2
(`dollar20` includes the current day) are unaffected by this and still
need resolving before Phase A.

### Corrections to the audit's own method

1. **An earlier within-symbol run was done at $0.10–$10 and reported a
   1.5–1.6x floor.** That run touched the $5–$10 holdout, which should
   not have happened, and its floor is not comparable to the ≤$5 figures
   above. `--max-price` now exists and audit runs must pass
   `--max-price 5`. The ≤$5 floor is **1.3x**; the $10-band figure is
   superseded and should not be quoted.
2. A residual computed as a ratio of lifts is a rough decomposition, not
   an exact one. It is adequate for rebasing a threshold; it is not a
   precise effect size.

---

## Layer 2.2 — Construct validity: is the target the right target?

Run 2026-09-21 at `--max-price 5`. Measurement validity asks whether the
study measures what it claims. **Construct validity asks whether the
claim is the right question.** `bigmove_score` is optimised against
`abs10` — a 10% move in *either* direction — while the goal is a
**buy-candidate list**.

New section `run_q3` splits the tails and charges costs. `U:D` is the
ratio of upside-reachable to downside-reachable next sessions
(`MFE+10 / MAE-10`). A selector with no directional edge leaves it at the
baseline value.

| candidate | period | up lift | down lift | **U:D** | win_net lift | r1 net |
|---|---|---|---|---|---|---|
| **BASELINE** | 2016-21 | — | — | **1.32** | — | −3.50% |
| **BASELINE** | 2022+ | — | — | **1.06** | — | −4.52% |
| `score>=3` | 2016-21 | 3.2x | **8.1x** | **0.65** | 1.2x | −5.33% |
| `score>=3` | 2022+ | 3.2x | **6.2x** | **0.66** | 1.4x | −6.29% |
| `vr25` | 2016-21 | 3.0x | **11.6x** | **0.42** | 1.1x | −7.07% |
| `up10_fade_vr3` | 2016-21 | 2.6x | **10.6x** | **0.41** | 1.0x | −7.93% |
| `offering_filed` | 2022+ | 1.5x | **4.1x** | **0.55** | **0.8x** | −8.96% |
| `8k_2.02` | 2016-21 | 2.4x | 3.7x | **0.90** | **1.4x** | −3.85% |
| `8k_2.02` | 2022+ | 2.9x | 3.4x | **0.91** | **1.5x** | −3.81% |
| `8k_any_quiet` | 2016-21 | 1.5x | 1.8x | **1.12** | 1.0x | −4.54% |

### 1. The concern was founded

**`score>=3` has a U:D of 0.65/0.66 against a baseline of 1.32/1.06 —
roughly half.** Its downside lift (8.1x/6.2x) is two to two-and-a-half
times its upside lift (3.2x/3.2x).

The trigger does not merely fail to find upside. **It selects for
downside**, and it does so more strongly than it selects for upside. A
5.3x lift on `abs10` is real, and most of what it is lifting is falls.

For a Watch list this is defensible — the README already says Watch,
never Buy. **For the candidate pool of a buy-oriented report it is
inverted**, and `docs/selection-logic.md` makes it exactly that.

### 2. The 8-K is the right signal — now on a third independent basis

`8k_2.02` is the only candidate that is close to direction-neutral
(U:D 0.90/0.91), has the **best profitable-next-session lift**
(1.4x/1.5x), and the **least negative net return** of any candidate
(−3.85%/−3.81% against `score>=3`'s −5.33%/−6.29%).

That is now three independent findings pointing the same way: both-period
positive in the original catalyst study, the lowest symbol-selection
floor under the negative controls (0.9x), and the only direction-neutral,
cost-surviving candidate here.

### 3. Volume is what brings the downside

`8k_any_quiet` — an 8-K with volume *below* 1.5x — has **U:D 1.12 in
2016-21, the only candidate above baseline in either period.** Adding a
volume spike to the same catalyst (`8k_any_vr3`) drops U:D to 0.65.

This matches the existing finding that volume conditions *subtract* from
the 8-K signal. It now appears they subtract specifically by adding
downside.

### 4. Everything is net negative

Every `r1 net` is negative, baseline included (−3.50%/−4.52%). Baseline
`win_net` is ~20%: only a fifth of in-band days close up enough to clear
the modelled cost. The best candidate reaches 30.5%.

Consistent with the project's standing verdict. A watchlist does not need
positive expectancy to be useful — it needs to point attention. But a
report framed around buy candidates must not present these as setups.

### Implication for `docs/selection-logic.md`

The spec's Step 2 pools the attention path (`bigmove_score >= 3`) and the
catalyst path (8-K 2.02) as equal mechanisms. **That is wrong on this
evidence.** The catalyst path should be primary; the attention path
belongs as a *de-prioritiser* or a risk annotation, not as a source of
buy candidates.

`vr25` (U:D 0.42) and `offering_filed` (win_net lift 0.8x — the only
candidate below baseline) are both strongly corroborated as exclusions.

### Caveat

MFE and MAE come from daily highs and lows, which cannot be ordered
within a session. They bound what was *reachable*, not what a path-
dependent strategy would have captured. U:D is a directional-asymmetry
measure, not a backtest.

---

## Layer 1.2 — The *production* scorers (not the studies)

Audited 2026-09-21 after noticing that F1 had been derived by comparing
`bigmove_study.py` against the README's *description* of production,
rather than against production code. Reading `eod-scan.ts` directly
confirms F1 and finds two more.

### P1 — Production's 8-K point is structurally always zero

`filed8kIds` selects 8-Ks with `filing_date > prevSession and
filing_date <= today`. On a Monday that is effectively `filing_date =
today`. **Those filings do not load until `sec-filings-sync` runs at
22:30 ET; `eod-scan` runs at 17:45.** The set is empty every session.

So production's `bigmove_score` is not "3 of 4 points." It is
**3 of 3 volatility points**:

```
vol_ratio >= 3  AND  |close-to-close| >= 10%  AND  day range >= 2x ATR14
```

The catalyst input has never contributed. This is worse than C.1
suggested — it is not a stale 8-K point, it is **no 8-K point at all**,
and `bigmove_watchlist` in production is a pure volatility triple.

Given §2.2, that matters directionally: the pure-volatility candidates
have the worst U:D of anything tested. Production's version of the
trigger is very likely *more* downside-skewed than the study's 0.65.

By contrast `earningsIds` looks at `(prevPrevSession, prevSession]` —
the *prior* session's filings, which **are** loaded by scan time. Same
table, two windows, and only one of them can ever return rows. That is
why `earnings_release` fires and the bigmove 8-K point does not.

### P2 — The only Buy trigger has an unpaginated query

`filed8kIds` paginates correctly, with `.order("accession")` and
`.range()`. The `earningsIds` query immediately below it does not:

```ts
const { data: ek } = await db.from("sec_filings")
  .select("symbol_id, items").eq("form", "8-K")
  .gt("filing_date", prevPrevSession).lte("filing_date", prevSession);
```

No `.order()`, no `.range()` — the 1,000-row-cap family, on the input to
`earnings_release`, which is the system's **only enabled Buy**. Current
volumes are safe (137 filings on 09-18, 113 of them 8-Ks), but the
failure mode is silent under-selection of Buy candidates.

### P3 — F1 confirmed from both sides

Production's window is one session (`> prevSession`). The study's is five
calendar days (`d.date - fl.adate <= 5`). The mismatch is real, now
verified against code rather than documentation.

The three volatility points match the study exactly: `vol_ratio >= 3`,
`abs(dret) >= 0.10`, and range over a prior-14-day ATR computed from
`bars[n-15 .. n-2]` — correctly excluding the current day.

### Status of the two studies

| | Layer 1 | Layer 2 |
|---|---|---|
| `bigmove_study.py` | done — 7 findings | done — passes |
| production `bigMoveScore` | done — P1–P3 | n/a |
| **`catalyst_study.py`** | **not started** | **not started** |

`catalyst_study.py` has not been read. Its result (+4.2% / +0.4% at 20
days) has been quoted from the README throughout and is **not** relied on
by `docs/selection-logic.md`, which cites only audited
`bigmove_study.py` rows. It is the next target, and now the most
important one: the catalyst path is the whole selection pool.

---

## Layer 1.3 — `catalyst_study.py`

Audited 2026-09-21. Full read. This study is **better constructed than
`bigmove_study.py` in the respect that matters most for the goal**, and
weaker in one that partly offsets it.

### What it gets right

- **Its metric is already direction-aware.** It reports signed 1/5/20-day
  returns, win rate, median, profit factor and mean-excluding-top-1% —
  not a direction-blind `abs10`. The construct-validity failure that
  inverted the first selection spec **does not apply here.** The 8-K
  result is a signed-return comparison against a random in-band day,
  which is exactly the comparison the goal needs.
- **Entry timing is deliberately conservative.** Filing events enter at
  the close of the session *after* the first session on/after the filing
  date, so the filing is public whatever time of day it was accepted. No
  intraday-timing assumption at all.
- **Point-in-time fundamentals.** Shares, cash and burn are asof-joined
  on their EDGAR `filed` date, so no restated figure leaks backwards.
  Offerings are checked in a 30-day window ending at the event.
- **Prior-only rolling windows.** 20-day volume excludes the current day;
  the 252-session high uses `c[:-1]`.
- **Split and staleness guards** on every horizon: returns are voided if
  any daily ratio in the holding window is ≥10x or ≤0.1x, or if the span
  exceeds `h*2 + 7` days.
- **Placeholder bars filtered** at load (`volume <= 0 and o = h = l = c`).
- **Tail reporting** — `mean_net_ex_top1` is computed and published, the
  project's own hard-won lesson applied.
- No truncation family: DuckDB + numpy throughout, no PostgREST.

### Findings

**C1 — The cost model is materially weaker than the project's headline
one.** This study charges `greatest(tick/price, 0.01)` — max of 1% and
one tick. `bigmove_study.py` charges
`greatest(tick/price, 0.01, spread_est)`, including the Abdi-Ranaldo
estimate, and the README's verdict rests on a modelled round trip
averaging **1.22%**.

So wide-spread names are **undercharged here**, and those are precisely
the names most likely to produce large moves. The published
+4.2% / +0.4% at 20 days is net of a weaker cost model than the one used
to kill `catalyst_momentum` (gross PF 1.32 → net 0.779). **Re-running
with the spread term is the single highest-value check on this study.**

**C2 — Unknown fundamentals are treated as clean.** Every component of
`flagged` is wrapped in `coalesce(..., false)`, and `offer30` comes from
a LEFT JOIN whose miss also reads as false. A symbol with no EDGAR shares
or cash data is therefore **not** nano-cap, **not** diluting and **not**
low-runway — it passes `excl_flags` as though verified clean. Given how
patchy XBRL coverage is on micro-caps, the `excl_flags` variant may be
substantially populated by unknowns. Same class as the live
`Nano-cap ($0M)` bug (P.2).

**C3 — It is not comparable to `bigmove_study.py`, and the selection
spec was treating both as one evidence base.** Three divergences:

| | `catalyst_study.py` | `bigmove_study.py` |
|---|---|---|
| filing timestamp | `filing_date` | `acceptance_datetime`, 17:45 ET rollover |
| default floor | $2.5M/day | $800k/day |
| cost model | max(1%, tick) | max(1%, tick, spread) |

Note `catalyst_study` uses `filing_date`, which is what **production**
uses — so on filing timing it is the closer of the two to the live
system.

**C4 — Multiple comparisons.** 8 events × 2 variants × 2 periods × 3
horizons ≈ 96 cells. "8-K 2.02 beats a random day in both periods" is a
selection from that family, uncorrected. Same issue as bigmove's F5.

**C5 — Mixed entry conventions in one table.** Filing events enter at
E+1's close; `high52w_vol` enters at the signal day's close. Documented,
but the rows sit side by side in one output and invite direct comparison
that is not valid.

**C6 — No negative control.** Layer 2 not yet built for this study.

**C7 — Docstring said $0.10–$5 while the code said $0.10–$10.** My own
error from the band standardisation (#176); corrected in this commit,
with a note that every published result predates the widening.

### Effect on the selection spec

`docs/selection-logic.md` does **not** cite this study, so nothing there
needs retracting. But the spec's central claim — that the catalyst path
is the right primary mechanism — would be **strengthened** by this
study's direction-aware construction and **weakened** if C1 turns out to
matter. Charging the spread term is the deciding test.

### Next

1. Add the spread term to this study's cost model and re-run (C1).
2. Add `--max-price` and the two negative controls, as `bigmove_study.py`
   now has (C6).
3. Resolve unknown-vs-clean in `flagged` (C2), and report how many rows
   in `excl_flags` are unknowns rather than verified-clean.
