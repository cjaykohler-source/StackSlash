# Measurement rebuild — scoped plan

Written 2026-09-11, after the hold-duration sweep concluded that nothing
on the sub-$5 universe has an edge surviving its own transaction costs
(see README, "The hold-duration sweep").

**Premise.** The trigger logic isn't the weak part of this project — the
*measurement* is. Six silent-corruption bugs have been found here, all
the same shape: no error raised, just quietly optimistic numbers. Four
of them changed a headline result, and two of those were reported to the
user as findings before being caught. The work below doesn't try to find
an edge. It builds a system that could *detect* one if it existed, and
would fail loudly instead of flattering itself.

Rough total: **20-26 hours**. Items 1 and 3 are the cheap high-leverage
ones and should go first.

---

## 1. Tail-concentration reporting — ~1-2h

**Why.** `trigger_stats` reports `avg_return` and `median_return` but
nothing about *where the mean comes from*. That gap is exactly what hid
the last two sessions' bad conclusions: `bb_rsi_confluence_long` showed
"+2.42% mean" while 0.21% of trades supplied 85% of it. A column showing
mean-excluding-top-1% would have made that visible on sight.

**Changes.**
- Migration: add to `trigger_stats` — `mean_excl_top1pct`,
  `mean_excl_top5pct`, `top1pct_profit_share`, `top5pct_profit_share`.
- Rewrite `finalize_backtest_stats()` (currently a plain aggregate
  insert, ~20 lines) to compute these via `ntile(100) over (partition by
  trigger_id, horizon_days order by return_value desc)`.
- Surface the two `mean_excl_*` columns wherever `avg_return` is already
  shown (Reports panel, `deep-dive.ts` scoring inputs).

**Done when.** At `horizon_days = 3`, `bb_rsi_confluence_long` reports
`mean_excl_top1pct ≈ −0.33%` against `avg_return ≈ +0.29%` (post-#54
values). If those two columns disagree in sign, the trigger is a
lottery and the UI should say so.

**Risk.** None meaningful — additive columns, recomputable at will.

---

## 2. Cost model as a first-class input — ~4-6h

**Why.** There is currently **zero** cost modeling in the repo (grep for
`slippage|spread|commission` returns one unrelated volume field). Every
backtest and sim assumes free fills at the close. The measured best mean
edge across all horizons was +0.52%; realistic round-trip spread on a
$2.72 stock is 0.4-1.8%. Most of this project's "edges" were dead on
arrival and nothing in the tooling could say so.

**The data problem, and the fix.** We have no historical bid/ask — only
OHLCV bars — so spread has to be *modeled*, not replayed. But it can be
calibrated rather than guessed: `bars_intraday` holds 90 days of 1-min
data for the band, and `quotes.ts` already pulls live quotes. Sample
real spreads across the band for a few weeks, fit a simple model
(`spread_pct ≈ f(price, dollar_volume)` — tick-size floor plus a
liquidity term), and store the coefficients in config rather than
hardcoding them.

**Changes.**
- New `netlify/functions/lib/tradingCosts.ts` — pure, unit-testable:
  `estimateSpreadPct(price, dollarVol20d)` and
  `applyRoundTripCost(grossReturn, entry, exit)`.
- New scheduled `sample-spreads.ts` writing observed spreads to a
  `spread_samples` table; a one-off fit script produces the coefficients.
- Apply at every exit-price computation in `sim-flip-exits.ts` and
  `sim-intraday-flips.ts`, and as an adjustment column in
  `backtest-triggers.ts` (store gross *and* net in
  `backtest_returns_raw` so the cost assumption stays auditable rather
  than baked in).
- Add `scan_config.cost_model_enabled` so gross/net can be compared.

**Done when.** Re-running `sw5_purehold` with costs on turns every
duration bucket negative — which is the expected, correct result, and
the proof the model is wired in.

**Risk.** Modeled costs are an assumption. Keep gross and net side by
side permanently; never report only net.

---

## 3. Standing data-integrity checks — ~4-6h

**Why.** All six silent-corruption bugs were mechanically detectable and
none were detected — they were each found by a human noticing a number
looked wrong, usually after it had already been acted on. This is the
single highest-leverage item in the document.

**Changes.**
- New `netlify/functions/lib/fetchAllPaginated.ts` — one helper that
  loops `.range()` correctly, and a lint rule (or a CI grep) banning
  bare `.select()` on `symbols`, `bars_daily`, `factor_state`. This
  eliminates the 1000-row bug *class*, not just its five instances.
- New nightly `data-integrity-check.ts` asserting:
  - bar gaps (currently 736 symbols >7d, 193 >30d)
  - split-scale breaks (≥10x session moves; currently 89 band symbols)
  - implausible absolute prices (CETX at $2.6M/share)
  - duplicate `(symbol_id, date)` rows, null OHLC on non-null closes
  - row-count drift: every paginated query logs expected vs received
- Results to a `data_quality_issues` table; Discord alert only on *new*
  or worsening classes, so it doesn't become noise.

**Done when.** First run reproduces the known counts above without being
told them. Any future regression pages you the same day rather than
three sessions later.

**Risk.** Alert fatigue if thresholds are too tight — hence alerting on
deltas, not absolute counts.

---

## 4. Forward measurement over backtests — ~3-4h dev, then calendar time

**Why.** Backtests here have been wrong six times. `fire_outcomes` —
the live, forward record of what actually happened after real fires —
has been wrong zero times, and already holds 511 rows. It is the most
trustworthy artifact in the project and the least used.

**Changes.**
- Extend `record-fire-outcomes.ts` horizons to match `HORIZONS`
  (`ret_20d` is missing) and add cost-adjusted variants once item 2
  lands.
- Build Phase 8 from `docs/logic-revamp-plan.md`: a Reports panel
  putting live `fire_outcomes` next to backtest `trigger_stats` per
  trigger, with the divergence called out explicitly.
- Add a `triggers.min_live_sample` gate — a trigger with fewer than N
  live fires is labelled unproven in the UI regardless of how good its
  backtest looks. `catalyst_momentum` (PF 1.32, n=49, one regime)
  is exactly the case this guards against.

**Done when.** You can answer "does this trigger's live behaviour match
its backtest?" from one screen. Realistically needs ~6 weeks of
accumulation to be informative.

**Risk.** None technical. The risk is impatience — the whole point is
refusing to act before the sample exists.

---

## 5. Universe as a knob you actually turn — ~6-8h

**Why.** The research bundle this project was built on targets liquid
small/mid-caps; the sub-$5 band was chosen for account size, not because
the factors work there. Moving up-market is the single change most
likely to make the *existing* logic work — spreads at $10-100 are
0.01-0.05% rather than 0.4-1.8%, which is the difference between the
measured edge being invisible and being tradeable. Right now testing
that costs a day of manual surgery.

**Changes.**
- `confluenceGate.ts` is already the single band chokepoint, but its
  hardcoded fallbacks have **drifted from the real config**
  (`price_max: 3` / `min_dollar_vol_20d: 150000` in code vs `5.00` /
  `50000` in `scan_config`). Fix that first — it's a live inconsistency,
  not just a cleanup.
- Extract `lib/resolveUniverse.ts` as the one definition of "which
  symbols are in play", used by `confluenceGate`, both sims,
  `intraday-factors-scan`, `backfill-intraday`, `backfill-news`.
- Add named universe presets (a `universes` table or a `scan_config`
  FK): `microcap_sub5` (current), `liquid_smallcap_10_100`, etc. Every
  sim and backtest takes a universe id and stamps it on its output rows,
  so results from different universes can never be silently compared.
- Data is mostly already there — `symbols` holds ~5,000 names including
  large caps with 5-year history, so a new band mostly needs
  `bars_intraday` backfill, not `bars_daily`.

**Done when.** `sim-flip-exits {"universe": "liquid_smallcap_10_100"}`
runs end to end and produces a comparable table to the current band, in
one command.

**Risk.** The honest one: this is the experiment most likely to show the
existing triggers work fine and were only ever failing because of the
universe. That would invalidate a lot of prior conclusions — which is
the point, but plan for it.

---

## Suggested order

1. **#3 integrity checks** and **#1 tail reporting** — cheap, and they
   make every subsequent number trustworthy. Do not skip ahead of these.
2. **#2 cost model** — changes every number that exists; better to
   absorb that before generating more.
3. **#5 universe** — the actual experiment, once the measurement rig is
   honest enough to interpret its result.
4. **#4 forward measurement** — start accruing immediately and in
   parallel; it gates nothing but informs everything.

## What this plan deliberately does not do

No new triggers, no new indicators, no ML. The trigger search returned
negative across ~35 variants, a 5-year multi-regime backtest, and a
1-day-to-6-month duration sweep. Adding a 36th variant to a measurement
rig that has been wrong six times is not the constraint. If the rebuilt
rig says the same thing on a liquid universe with costs modeled, that is
a real answer and worth more than any additional signal.
