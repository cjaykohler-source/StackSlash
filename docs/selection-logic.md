# Selection logic — the daily target list

Written 2026-09-21. Rewritten the same day after the construct-validity
work in `docs/research-audit-plan.md` §2.2.

Specifies Stage 1 of `docs/overhaul-plan.md`: the logic that picks the
**X symbols** that go into the pre-open report.

**Goal.** A *ranked* list of ~20 target symbols for the next session,
each carrying the reasons it was selected, so the report layer has
something to describe and the reader has an ordering to work down.

**Non-goal.** Predicting returns. Every component is either evidenced on
this universe or excluded from the score.

---

## What changed, and why the first draft was wrong

The first draft pooled two mechanisms as equals: an **attention** path
(`bigmove_score >= 3`) and a **catalyst** path (8-K 2.02). The
direction-aware analysis says that is wrong.

`U:D` is the ratio of upside-reachable to downside-reachable next
sessions. A selector with no directional edge leaves it at the baseline.

| | period | up lift | down lift | **U:D** | win_net lift | r1 net |
|---|---|---|---|---|---|---|
| **BASELINE** | 2016-21 | — | — | **1.32** | — | −3.50% |
| **BASELINE** | 2022+ | — | — | **1.06** | — | −4.52% |
| `score>=3` | 2016-21 | 3.2x | 8.1x | **0.65** | 1.2x | −5.33% |
| `score>=3` | 2022+ | 3.2x | 6.2x | **0.66** | 1.4x | −6.29% |
| `8k_2.02` | 2022+ | 2.9x | 3.4x | **0.91** | **1.5x** | −3.81% |
| `8k_any_quiet` | 2016-21 | 1.5x | 1.8x | **1.12** | 1.0x | −4.54% |
| `vr25` | 2016-21 | 3.0x | 11.6x | **0.42** | 1.1x | −7.07% |
| `offering_filed` | 2022+ | 1.5x | 4.1x | **0.55** | **0.8x** | −8.96% |

Three conclusions drive this rewrite:

1. **`bigmove_score >= 3` selects for downside.** U:D 0.65/0.66 against a
   baseline of 1.32/1.06, with downside lift 2–2.5x its upside lift. Its
   5.3x headline is a lift on `abs10`, which sums both tails; most of
   what it lifts is falls. Correct as a Watch list, **inverted as a
   buy-candidate pool.**
2. **The catalyst path is the only direction-neutral, cost-surviving
   signal.** `8k_2.02` at U:D 0.90/0.91, the best profitable-next-session
   lift (1.4x/1.5x) and the least negative net return of any candidate.
3. **Volume subtracts by adding downside.** `8k_any_quiet` (8-K with
   volume < 1.5x) is the only candidate above baseline U:D in either
   period. The same catalyst *with* a volume spike drops to 0.65. This
   inverts the standard "breakouts need volume confirmation" intuition —
   on this universe volume confirms the fall as often as the rise.

## Evidence provenance

Everything above comes from `bigmove_study.py`, which has passed **Layer
1** (static audit, seven findings) and **Layer 2** (both negative
controls; within-date 1.0–1.1x, within-symbol floor 1.3x) in
`docs/research-audit-plan.md`.

**It does not rest on `catalyst_study.py`, which is unaudited.** That
study's separate 8-K result (+4.2% / +0.4% at 20 days) would corroborate
this if it survives audit, and is the next Layer 1 target. Until then it
is not cited here.

---

## Prerequisites — two flag bugs (~1h)

Both corrupt the signal any calibration would measure against.

**P.1 — `Fresh news` is marked red.** Two dossiers carry
`Fresh news (2h ago)` at level red, against the documented rule that news
and earnings are always amber. Red means proven negative; fresh news is
the opposite for a catalyst strategy, and this demotes exactly the names
that now belong at the top of the list.

**P.2 — `Nano-cap ($0M)` from missing data.** 12 occurrences across 7
symbols: a null market cap rendered as a red flag. Absent treated as
zero, zero treated as damning.

---

## The design

### Output contract

```
getShortlist(date, limit = 20) → {
  ticker, rank, score, tier,
  basis: "catalyst" | "catalyst+quiet" | "fill",
  components: { ...each contributing value, with status },
  annotations: ["elevated-attention", "wide-spread", ...],
  unknowns: ["float", ...]
}[]
```

Nothing downstream references a trigger by name — the list-agnostic
boundary from `overhaul-plan.md` B.1, which also lets a hand-picked list
substitute for development.

### Step 1 — Hard exclusions

Only rules with directional evidence in both periods. Each is now
corroborated by U:D as well as by the original studies.

| exclusion | evidence |
|---|---|
| Volume ≥25× normal | **U:D 0.42/0.47**, down-lift 11.6x vs up-lift 3.0x; −16.2% median over 18 sessions |
| Offering filed ≤30d | **U:D 0.55/0.64**, and **win_net lift 0.8x — the only candidate below baseline** |
| Reverse-split window | −17% to −22% over 20 sessions, both periods |
| Below `scan_config.min_dollar_vol_20d` | tradeability, not prediction |

Still **not** exclusions: nano-cap, low runway, high dilution. One-regime
evidence, and they fire on ~78% of candidates.

### Step 2 — Candidate pool: catalyst-primary

The pool is **filings-driven**. Attention is no longer a source of
candidates.

| tier | definition | approx. per session (≤$5) |
|---|---|---|
| **A** | 8-K item 2.02 (earnings), volume < 1.5x | ~2–3 |
| **B** | 8-K item 2.02, any volume | ~7 |
| **C** | other material 8-K, volume < 1.5x | ~6–20 |
| **fill** | other material 8-K, any volume | to `limit` |

Tier A is the intersection of the two cleanest results — the catalyst
with the best win_net lift, and the volume condition with the only
above-baseline U:D. It is small by construction, which is correct: a
high-conviction tier that is often nearly empty is an honest output.

Pool sizes are estimates from study row counts over trading days and
**must be confirmed by M.3** before `limit` is fixed.

### Step 3 — Attention becomes an annotation, not a qualifier

`bigmove_score` and its components stay in the system, inverted in role:

- **Displayed** on every row, so the reader sees that a name is active.
- **A de-prioritiser**, not a promoter. A catalyst name also carrying
  `vol_ratio >= 3` ranks *below* an otherwise-equal quiet one, because
  quiet catalysts have the better U:D.
- **Never** a reason for a name to appear on the list.

### Step 4 — Ranking

Within tier, order by:

1. **Catalyst strength** — 2.02 above other material items; more recent
   acceptance above older.
2. **Quietness** — lower `vol_ratio` ranks higher (Step 3).
3. **Tradeability** — dollar volume up, estimated spread down. The
   widest spread tier has the highest move rates *and* the worst net
   returns, so spread is a cost, never a bonus.
4. **Relative quality** — percentile *within today's pool* on cash
   runway, dilution and size. Low weight, marked regime-dependent.

### Step 5 — Output

Always the top X by rank, annotated with tier. Tier A empty on most days
is an honest output, matching the project's existing stance on Targets.

---

## Rules that govern the score

**1. Direction- and cost-aware targets only.** No component may be
justified by a lift on `abs10` or any other direction-blind metric. The
qualifying tests are U:D against baseline, and profitable-next-session
lift net of the modelled round trip. **This rule exists because the first
draft was built on a direction-blind target and inverted as a result.**

**2. Only evidenced inputs may move the ranking.** Float rotation, short
interest, borrow, news-crawler catalysts and other 8-K item types are
*shown in the report* and none touch the score until measured here.

**3. Unknown is never zero.** Every component carries
`value | unknown | not_applicable`. A missing market cap is not a $0M
nano-cap (P.2); a symbol with no balance sheet is not one with no cash.

**4. The list points attention; it does not claim expectancy.** Every
candidate tested has a negative mean next-session return net of costs,
baseline included (−3.50%/−4.52%); only ~20% of in-band days clear the
cost at all, and the best candidate reaches 30.5%. The report must not
present these as setups. See `overhaul-plan.md` B.4.

---

## Must be measured before weights are fixed

**M.1 — Does relative quality beat absolute flagging?** Among catalyst
candidates, did top-quartile-runway names outperform bottom-quartile on a
*direction-aware* target? If not, drop Step 4.4.

**Answered for revenue growth on 2026-09-22: no.** Pre-registered in
`docs/growth-prereg.md`, run by `research/growth_study.py`. Q4-Q1 net win
rate **-0.2pp / +1.0pp**, win rate flat across quartiles, same null over
all material 8-Ks at 4x the n. Revenue growth does **not** enter Step 4.

Still open for the other quality inputs. **Operating cash flow is the
live lead** (+3.7pp / +8.9pp, same sign, U:D Q4 >= Q1 in both periods)
but is not established -- 23%/33% coverage, and only 2022+ clears its own
noise floor. It gets its own pre-registration before it touches Step 4.

The run also measured the thing this section most needed: **the noise
floor of a Q4-Q1 win-rate difference on this pool is +-8.5pp in 2016-21
and +-4.7pp in 2022+** (200 permutations). Any weight fixed here must be
justified against that, not against an assumed standard error.

**M.2 — Does the catalyst path hold at $5–$10?** `overhaul-plan.md` A.3,
now the single most important open question: the catalyst path is the
whole pool. **Phase A must be re-pre-registered around `8k_2.02` and U:D,
not `score>=3` and `abs10`.**

**M.3 — What is the real pool size per session?** Tier A/B/C counts at
≤$5, by period. Determines whether `limit` is a cut or the whole pool.

**M.4 — Is `8k_any_quiet` robust?** It is the only above-baseline U:D
result and carries the most design weight of any single finding here.
n = 9,622 / 19,249 is large, but it has not been independently confirmed.
`catalyst_study.py`'s audit should test it directly.

---

## Build order

| step | work | effort |
|---|---|---|
| P.1, P.2 | Fix the two flag bugs | ~1h |
| M.3 | Measure real pool size | ~1h |
| — | Audit `catalyst_study.py` (Layers 1–2) | ~3h |
| M.4 | Confirm the quiet-catalyst result | ~2h |
| 1–2 | `getShortlist()` — exclusions + catalyst pool | ~2h |
| 3–5 | Annotation, ranking, tiers | ~3h |
| M.1 | Relative-quality test, direction-aware | ~3h |

## What this deliberately does not do

**No technical-indicator confirmation ladder.** RSI, MACD, MA crosses and
20-day-high breakouts were each backtested here and disabled, and the
multi-indicator ladder is the confluence gate removed 2026-09-17. The
*tiering structure* is kept; the rungs are evidenced ones.

**No volume confirmation.** Directly contradicted: on this universe
volume confirms the fall as often as the rise (§ *What changed*).

**No new trigger variants.** Steps 1–5 re-rank and re-present signals
that already exist.

**No prediction of returns.** The list orders *where to look*. The report
supplies the facts. The reader decides.
