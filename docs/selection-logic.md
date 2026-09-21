# Selection logic — the daily target list

Written 2026-09-21. Specifies Stage 1 of the architecture in
`docs/overhaul-plan.md`: the logic that picks the **X symbols** that go
into the pre-open report.

**Goal.** Produce a *ranked* list of ~20 target symbols for the next
session, each carrying the reasons it was selected, so the report layer
has something to describe and the reader has an ordering to work down.

**Non-goal.** Predicting returns. Every component below is either
evidenced on this universe or excluded from the score entirely.

---

## Why the current logic can't do this

Three structural problems, all measured:

1. **It produces booleans, not a ranking.** Triggers fire or don't. A
   filter yields 3 names one day and 60 the next; a report that asks for
   "the top 20" needs an ordering. `bigmove_score` is 0–4 and most fires
   land on 3, so it cannot break ties either.
2. **It terminates in an empty set.** 21 of 27 `bigmove_watchlist` fires
   (78%) and **2 of 2** `earnings_release` fires carry a red flag. Under
   the Buy/Watch rule every red-flagged buy setup becomes Watch — so the
   only Buy trigger produced zero Buys.
3. **Its filters describe the universe rather than discriminating within
   it.** The three dominant red flags — nano-cap <$50M (~27 symbols),
   ≤2 quarters cash (~23), shares +50% YoY (~20) — are structural
   properties of sub-$10 micro-caps. A flag that fires on 78% of
   candidates is a description, not a filter.

There is also a mechanism-independence finding that constrains the
design: across both sessions with clean data, `bigmove_watchlist` and
`earnings_release` overlapped on **zero** symbols (6+1, 20+1). This
matches `promotionGate.ts`'s recorded reason for removing the confluence
gate — *"at this price band, genuine multi-trigger confluence is
near-zero."* **Any tier requiring two mechanisms to agree will be empty.**

---

## Prerequisites — two flag bugs (~1h)

Both corrupt the signal any calibration would measure against, so they go
first.

### P.1 `Fresh news` is marked red

Two dossiers carry `Fresh news (2h ago)` at level **red**. The documented
rule is *"News and earnings are always amber"*, and red means a proven
negative. Fresh news is the opposite of a negative for a catalyst
strategy — this actively demotes the names most likely to belong on the
list.

**Done when.** No news- or earnings-derived flag can be red.

### P.2 `Nano-cap ($0M)` from missing data

12 occurrences across 7 symbols. A $0M market cap is *missing data*
rendered as a red flag: absent treated as zero, zero treated as damning.

**Done when.** A null market cap produces an `unknown` flag, never
`nano-cap`, and the distinction is visible in the report.

---

## The design

### Output contract

```
getShortlist(date, limit = 20) → {
  ticker, rank, score, tier,
  mechanisms: ["attention" | "catalyst", ...],
  components: { ...each contributing value, with status },
  exclusions: [],            // always empty in output; see below
  unknowns: ["float", ...]   // fields we could not determine
}[]
```

`buildReport(ticker, date)` consumes a row. Nothing downstream references
a trigger by name — the list-agnostic boundary from `overhaul-plan.md`
B.1, which also means a hand-picked list can be substituted for
development.

### Step 1 — Hard exclusions

Applied before scoring. Only rules with **directional evidence in both
periods** qualify for exclusion; everything else is context, not a veto.

| exclusion | evidence |
|---|---|
| Reverse-split window | −17% to −22% over 20 sessions, both periods |
| Offering filed ≤30d (S-3, 424B4/B5, F-3) | −17% (2022+, priced offerings) |
| Volume ≥25× normal | −10.0% mean / −16.2% median over 18 sessions, PF 0.489 |
| Below `scan_config.min_dollar_vol_20d` | tradeability, not prediction |

Deliberately **not** exclusions: nano-cap, low cash runway, high
dilution. Their evidence is one-regime only (excluding red flags cut
2022+ losses ~90%/75% but *did not help* in 2016–21) and they fire on
most of the universe. They move to Step 4 as relative rankings.

An excluded symbol never reaches the list. The report states what was
excluded and why, so the count is auditable.

### Step 2 — Candidate pool (two independent mechanisms)

Union, not intersection — they do not co-occur.

**Attention path:** `bigmove_score >= 3`.
The threshold is the qualifier and **its definition must not change** —
the 3–9× next-session lift is tied to exactly these four points (volume
≥3× 20-day average, close-to-close move ≥10%, day range ≥2× ATR14, 8-K
since the previous session). Redefining it invalidates the evidence.

**Catalyst path:** 8-K item 2.02 (earnings release).
The only signal positive in both periods: +4.2% / +0.4% at 20 days
against a random in-band day's +1.8% / −3.2%.

### Step 3 — Continuous score (ranking within the pool)

`bigmove_score` qualifies; magnitudes rank. This preserves the evidence
while producing a real ordering.

| component | source | direction |
|---|---|---|
| Volume ratio vs 20-day median | `volume_ratio_20d`, capped below the 25× exclusion | higher better |
| Close-to-close move | `bars_daily` | larger better |
| Range expansion | day range ÷ ATR14 | higher better |
| Catalyst weight | 8-K 2.02 = full; other material 8-K = context only | — |
| Spread estimate | Abdi-Ranaldo (`symbol_spread_estimates`) | **wider is worse** |

On the last row, note the project's own finding: the top spread tier has
both the highest big-move rate *and* the worst net returns (−6.4% /
−7.5% at 1 day). Wide spread is not a bonus for volatility — it is a
cost.

### Step 4 — Relative quality (percentile within today's pool)

The change that makes the fundamentals useful. Instead of *"≤2 quarters
cash → red → excluded"*, rank candidates against **each other**:

- Cash-runway percentile
- Share-count growth (dilution) percentile
- Market-cap percentile

Being the best-capitalised name among today's candidates is informative.
Being under an absolute threshold that 78% of the universe trips is not.

**Weight this rung low and mark it regime-dependent** — its supporting
evidence holds in 2022+ and not in 2016–21.

### Step 5 — Tier, then cut to X

**Tiers describe evidence strength, not rank.** They exist so the reader
knows how much to trust a name, and they are assigned per-mechanism
because mechanisms do not co-occur:

- **Tier A — catalyst.** 8-K 2.02, no exclusions. The only both-period
  positive directional signal.
- **Tier B — attention, strong.** `bigmove_score ≥ 3` with top-quartile
  magnitude within the pool.
- **Tier C — attention.** `bigmove_score ≥ 3`, ordinary magnitude.

**The report always shows the top X by continuous score, annotated with
tier.** That decouples "give me 20 names to look at" from "how confident
should I be" — you get a full list every day, and the tier column tells
you whether any of it is high-conviction.

Tier A being empty on most days is **an honest output, not a failure**.
It matches the project's existing stance: *"Targets now holds only
Earnings Release — the honest state of the evidence, not a gap to fill."*

---

## Rules that govern the score

**1. Only evidenced inputs may move the ranking.** Float rotation,
short interest, borrow availability, news-crawler catalysts and other 8-K
item types are all *shown in the report* and none of them touch the score
until measured on this universe. This is the difference between a report
that informs and one that manufactures confirmation.

**2. Unknown is never zero.** Every component carries
`value | unknown | not_applicable`. A missing market cap is not a $0M
nano-cap (P.2); a symbol with no balance sheet is not a symbol with no
cash. Unknowns are listed per row and surfaced in the report, because a
report that silently omits a filed offering is worse than no report —
you would act on its absence.

**3. The pool qualifier is frozen.** `bigmove_score >= 3` keeps its exact
definition. Tuning it is a new research question requiring new evidence,
not a scoring adjustment.

---

## Must be measured before the weights are fixed

Three unknowns. Until they are answered, ship with equal weights inside
each rung and say so.

**M.1 Does relative quality beat absolute flagging?** Among historical
`bigmove_score ≥ 3` candidates, did top-quartile-runway names outperform
bottom-quartile at 1 and 5 days? If not, drop Step 4 entirely and rank on
attention and catalyst alone. Runs against the local warehouse.

**M.2 Does the catalyst path hold at $5–$10?** `overhaul-plan.md` A.3.
The 8-K is the only positive directional signal, so if it does not
generalise above $5 the catalyst path is ≤$5-only and Tier A narrows.

**M.3 What is the natural pool size?** How many names clear Step 2 on a
typical session, at $0.10–$5 and $5–$10 separately? If it is reliably
under 20, X is not a cut — it is the whole pool, and the ranking only
orders the report. If it is 200, the ranking is doing real work.

M.3 is cheap and should be run first; it determines whether any of the
rest matters.

---

## Build order

| step | work | effort |
|---|---|---|
| P.1, P.2 | Fix the two flag bugs | ~1h |
| M.3 | Measure natural pool size | ~1h |
| 1 | `getShortlist()` skeleton — exclusions + pool, unranked | ~2h |
| M.1 | Relative-vs-absolute study | ~3h |
| 3–5 | Scoring, tiers, cut to X | ~3h |
| M.2 | Catalyst path at $5–$10 (plan A.3) | ~2h |

~12 hours, and the first three (~4h) already produce a usable unranked
candidate list that `buildReport` can consume.

## What this deliberately does not do

**No technical-indicator confirmation ladder.** RSI, MACD, moving-average
crosses and 20-day-high breakouts were each backtested on this universe
and disabled: `momentum_breakout` (coin-flip), `macd_bullish_cross`
(−0.1% / −3.3%, indistinguishable from random), `bb_rsi_confluence_long`
(worse than random in one period, no better in the other),
`volatility_squeeze_breakout_long` (does not survive 2022+). The
multi-indicator ladder is also the confluence gate, removed 2026-09-17
because the rungs do not co-occur at this band.

The *tiering structure* from that approach is kept — it is a good answer
to the ranking problem. The rungs are replaced with components that have
evidence here.

**No RSI momentum confirmation specifically.** It contradicts two live
findings: `avoid_chase_extended` (early extended moves −2.3% vs −1.0%
random over 2h) and `scan_config.max_rsi14 = 85`, which already refuses
longs above that at the promotion gate.

**No new trigger variants.** Steps 2–5 re-rank and re-present signals
that already exist. Nothing here is a 36th variant.

**No prediction of returns.** The list orders *where to look*. The report
supplies the facts. The reader decides.
