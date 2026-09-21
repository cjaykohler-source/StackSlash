# RIOT overhaul — scoped plan

Written 2026-09-21, from a full read of `README.md`, `docs/HANDOFF.md`,
the live alert path, the rules layer, the outlier worker and the
production `triggers` / `scan_config` tables. Revised the same day after
the Phase −1.1 audit and the architecture decision below.

**Premise.** The research verdict is settled and this plan does not
re-litigate it: nothing tested has a multi-regime edge net of costs on
this universe. Given that, RIOT is not a signal generator. It is a
**preparation engine for a discretionary trader** — it does the homework
overnight and hands over a short, deeply-researched list before the open.

That reframing is not a retreat. It is the only shape that fits three
facts the project has already established:

1. **Both evidenced signals are end-of-day.** `earnings_release` (8-K
   2.02, 20-day hold) and `bigmove_watchlist` (next-session 10%+ move at
   3–9× base rate) are next-session signals. Delivering them faster adds
   nothing.
2. **Real-time entry alerting is not viable here.** IEX is real-time but
   carries ~1.7% of band volume; SIP is complete but ~15 minutes stale.
   Neither supports entry timing on a $2 stock, and the modelled 1.22%
   round-trip cost is already larger than any edge measured.
3. **The expensive data sources only work on a shortlist.** FMP's free
   tier is 250 calls/day, IBKR borrow takes ~25 min for the band, SEC
   XBRL ~2 h — and Robinhood (float, listing status, L2) *cannot run from
   a host job at all*. All are trivial on 20 names. A shortlist is what
   makes that data reachable.

Rough total: **38–50 hours**, but the sequencing matters far more than
the total — see **Phase A**, which gates roughly half of it.

---

## The target architecture

**Stage 1 — Analysis (after 22:30 ET).** Score the universe, produce
tomorrow's shortlist. This is where the evidence lives.

**Stage 2 — Enrichment (overnight).** Fan out expensive per-symbol work
on the shortlist *only*: float, borrow, balance sheet, offering history,
filings, news. Affordable precisely because it is scoped.

**Stage 3 — Pre-open report (~08:00–08:30 ET).** Last night's shortlist
refreshed with overnight 8-Ks, pre-market gap and pre-market volume.
Delivered before the user sits down.

**Intraday — monitoring, not discovery.** Scoped to names already on the
shortlist or tracked. Reframed from "here is a trade" to "something on
your list changed" and "here is a reason not to buy." This makes the
28-slot websocket budget sufficient rather than absurd, and makes latency
tolerable because the analysis happened last night.

**Trading posture: ready at the open, execute on confirmation.** Not
trading the first 30–60 minutes. Spreads are widest then, the 1.22% cost
model is an all-day average rather than an opening-bell number, and
`avoid_chase_extended` exists precisely because first-hour extended moves
returned −2.3% against −1.0% for a random entry. The edge comes from the
homework, which means there is no need to pay the opening spread.

---

## Status — landed 2026-09-21

- **Phase −1.1 complete** (#174). Audited the evaluation→fire funnel for
  every enabled trigger. Two defects found and fixed: `eod-scan` stored
  the raw `factor_state` row instead of the enriched `inputs` actually
  evaluated (so every derived field that decides firing was absent from
  the audit trail), and it evaluated `realtime_outlier_zscore` — whose
  definition is a `{note}` stub with no `all` clause — 24,875 times a
  week for guaranteed-false results.
- **Outlier worker fixed** (#175). It filled all 28 subscription slots
  with the highest-dollar-volume names in the universe, no price filter —
  mega-caps, none in band. Every fire was discarded by
  `promotionGate.inBand()`. 2,072,977 ticks since 2026-09-08, zero
  promotions: structurally incapable of firing. Now band-scoped from
  `scan_config`, with a startup warning when the in-band fill is empty.
- **Band standardised on $0.10–$10** (#176). `scan_config.price_max` had
  been 10 while every doc and research script said 5. Code fallbacks,
  research scripts and current-state docs now agree. Historical research
  keeps its original $5 scope — see **Phase A**.

---

## Phase A — The holdout test (~5h) — GATES THE ARCHITECTURE

**Why this is first.** The architecture above concentrates everything on
the quality of the EOD shortlist. Stages 2 and 3 are expensive machinery
wrapped around that list. If the selection mechanism does not hold, they
are machinery around a weak list.

And there is a deadline of a kind. Everything at ≤$5 has been mined
across ~35 trigger variants, a 5-year multi-regime backtest, a
1-day-to-6-month duration sweep and a cost model; the README itself says
2022+ should be treated as "seen, not a sealed holdout." **The $5–$10
range has never been examined.** It is the only genuinely unexamined data
this project owns, and as of 2026-09-21 it is roughly 46% of the
alertable universe (673 of 1,031 names at the $2.5M floor, against 363 at
the old $5 ceiling).

That makes it a real holdout by accident — and a single-use one. A few
exploratory passes and it is as compromised as everything else. So the
test is **pre-registered below and run once.**

### A.1 Pre-registration — write this down before running anything

**Hypothesis.** The `bigmove_score >= 3` selection mechanism generalises
to $5–$10: it produces a materially elevated rate of large next-session
moves in a price range it was never fitted on.

**Primary metric.** Next-session lift — the ratio of

- P(next-session close-to-close move ≥ 10% | score ≥ 3), to
- P(next-session move ≥ 10% | random in-band day, same period)

This is a **hit-rate-versus-base-rate** metric, deliberately not profit
factor. `bigmove_watchlist` is a Watch, never a Buy: only ~36% of its
moves are up and its 1/5-day net returns are negative. The list's job is
to concentrate attention, and lift is what measures that. Judging it on
P&L would conflate list quality with execution.

**Pass threshold.** Lift **≥ 2.5×** in $5–$10, in **both** 2016–21 and
2022+ reported separately, and surviving the spread-tier control below.
Published lift at ≤$5 is 3.3–9.4× tier-controlled; 2.5× is a deliberately
lower bar, because the question is whether the mechanism *generalises*,
not whether it is equally strong.

**Controls.**
- **Spread tier.** Volatile names move more on any day. Lift must hold
  *within* Abdi-Ranaldo spread tiers, as `bigmove_study.py` already does
  at ≤$5. An uncontrolled result does not count.
- **Dollar-volume floor.** $800k, matching the monitoring band.
- **Periods.** 2016–21 and 2022+ **always reported separately, never
  merged.** Merging is how a period-specific artefact looks robust.
- **Price ranges.** $0.10–$5 and $5–$10 **reported separately.** The ≤$5
  number is the already-known control; the $5–$10 number is the test.

**Number of passes: one.** One run of `bigmove_study.py` at the widened
band, one report. No threshold sweeps, no "what if score ≥ 2," no
re-cuts after seeing the answer. Anything further is a new, explicitly
non-holdout question and must be labelled as such in the README.

**Pre-committed decision rule.**

| result in $5–$10 | what it means | what happens |
|---|---|---|
| lift ≥ 2.5× both periods, tier-controlled | mechanism generalises | build Stages 2–3 in earnest on the full $10 band |
| lift ≥ 2.5× in one period only | period-specific | build Stages 2–3, but shortlist scoped to ≤$5; revisit later |
| lift < 2.5× but > 1.5× | weak but real | build Stages 2–3; **price-scope the trigger**, do not average the ranges together |
| lift ≈ 1.0× | no signal above $5 | shortlist stays ≤$5, and the $5–$10 range is screen-only (see B.4) |

**What this test does not do.** It does not measure profitability, and it
must not be reported as if it did. It measures whether the shortlist
points at the right names.

### A.2 Run it — ~2h

`research/bigmove_study.py` is already band-widened (#176). Run once,
report the four cells (2 periods × 2 price ranges) plus tier-controlled
lift. Record the result, the date and the pre-registration in the README
next to the existing ≤$5 table.

**Done when.** The four cells are in the README, the decision rule above
has been applied, and the next phase is chosen by it rather than by
preference.

### A.3 Re-validate the catalyst path — ~2h

Second priority, same discipline. `catalyst_study.py` at $10: does 8-K
2.02 still beat a random day above $5? This is the other mechanism the
shortlist will lean on (see B.2), and `earnings_release` is currently the
only Buy in the system.

**Done when.** `earnings_release`'s evidence note states which price
range it was validated on.

---

## Phase B — De-risk the shortlist dependency (~6h)

Concentrating on one list is the architecture's main structural risk.
These four items reduce it; **B.1 should be done before Stages 2–3
regardless of how Phase A turns out.**

### B.1 Make Stages 2 and 3 list-agnostic — ~1h

**Why.** The cheapest risk reduction available. Enrichment and reporting
should take a list of tickers as **input**, not compute one. A single
interface — `getShortlist(date) → ticker[]` — and everything downstream
is indifferent to where the list came from.

With that boundary in place, a Phase A failure collapses from "the
architecture is wrong" to "one input needs replacing." The expensive
machinery is reusable whatever selects the names.

**Done when.** No stage-2 or stage-3 code references `bigmove_watchlist`,
`trigger_events` or any trigger by name.

### B.2 Diversify the list by mechanism, not by variants — ~3h

**Why.** The shortlist would currently be ~96% one trigger:
`bigmove_watchlist` at 77 fires/week against `earnings_release`'s 3.
Single point of failure by construction.

The distinction that matters, given this project's standing "do not add a
36th trigger variant" rule — which stands: `bigmove_score` is one
composite of four *correlated* volatility/attention proxies. Adding a
fifth correlated proxy is exactly what not to do. Adding a
**mechanistically independent selection path** is a different move.

The filings path is the one with evidence already: 8-K 2.02 beats a
random day in both periods; reverse splits run −17% to −22%; 424B4
offerings −17%. That is a catalyst mechanism, not a volatility mechanism.
If volatility-based selection decays, catalyst-based selection does not
necessarily go with it.

**Changes.** Shortlist = union of the volatility path (`bigmove_score`)
and the filings path (8-K 2.02 / material filings), each contributing a
labelled slice so their lift is tracked separately (B.3).

**Done when.** The shortlist draws on two independently-measured
mechanisms, and the report says which path put each name on the list.

### B.3 Standing lift scoreboard — ~2h

**Why.** The risk is not only "is the list good today" but "will anyone
notice when it stops." `fire_outcomes` and `record-fire-outcomes` already
exist; what is missing is a rolling metric on the **list**, per mechanism.

Same metric as Phase A — hit rate against base rate, not profit factor.
Published lift is 3–9×. If the trailing-20-session figure drifts toward
1.0×, the list is dead and it shows up in weeks rather than never.

**Done when.** The Reports page shows trailing-20-session lift per
selection path, and `data-integrity-check` posts to Discord when it falls
below a floor.

### B.4 Write down the floor case — ~30m (decision)

**Why.** If lift is ≈1.0× above $5, the shortlist there degrades to "the
most active sub-$5 names with a catalyst." That is **still a useful
product** — a screen rather than a prediction — and the README already
frames the system that way: *"a solid, real-time screening and monitoring
tool… treat alerts as things to look at, not blindly trade."*

The downside is not "architecture wasted," it is "the claim gets weaker."
Recording that in advance keeps a disappointing Phase A result from
reading as a project failure.

**Done when.** The README states what the shortlist claims in each Phase
A outcome, and the UI language matches the weakest one that applies.

---

## Phase C — Fix the firing path (~5h)

Defect repair. Every item is a place where the system does something
other than what the documentation says.

### C.1 The analysis stage runs before its own inputs land — ~1h

**Why.** `eod-scan` runs 17:45 ET. `sec-filings-sync` lands that session's
filings at 22:30 ET. Verified 2026-09-21:

```
filing_date 2026-09-18 → 137 filings, first loaded 22:30 ET on 09-18
eod-scan ran 17:45 ET on 09-18 — 4h45m earlier
```

So the 8-K component of `bigmove_score` is **always one session stale**. A
name that filed today gets no 8-K point tonight, and by tomorrow night
"filed since the previous session" has moved on. The 22:30 run was added
on 09-18 specifically to land same-day filings, but nothing consuming it
was moved. **One of the four points in the project's best trigger has
never worked as designed.**

This also fixes itself under the target architecture, where Stage 1 runs
after 22:30 by definition.

**Changes.** Move `eod-scan` after `sec-filings-sync`'s late run, or split
scoring into a second pass that runs after it. Re-check `bigmove_score`
fire counts and the 8-K component's contribution before and after.

**Done when.** A name that filed an 8-K today can score its 8-K point
tonight, demonstrated on a real filing.

### C.2 Apply the alerting liquidity floor to live intraday alerts — ~1h

**Why.** `intraday-factors-scan` builds its universe from
`monitor_min_dollar_vol_20d` ($800k — correct, it is the monitoring
band). `intraday-flip-scan` then filters only on price and
`alert_excluded`, and inserts straight into `trigger_events`, bypassing
`promotionGate`. `min_dollar_vol_20d` ($2.5M) is **never applied to any
live alert**. Every `rvol_breakout` and `avoid_chase_extended` card can
fire on a name at a third of the documented alerting floor.

**Changes.** Extract `inBand()` and call it from `intraday-flip-scan`, or
filter `liveRows` on the latest `factor_state.dollar_vol_20d`. Unknown
dollar volume does not qualify.

**Done when.** No `intraday-flip-scan` event is below
`scan_config.min_dollar_vol_20d`. Expect fire counts to drop — that is
the fix working.

### C.3 Paginate the cooldown query — ~30m

**Why.** `filterByCooldown` selects with no `.order()` and no range.
HANDOFF §3 records that PostgREST silently truncates at 1,000 rows
without an explicit order, and the README documents six instances of this
bug family. Max fast-trigger cooldown is 1,440 minutes, so it pulls a full
day of events. Not truncating at ~25–40 alerts/day — but the failure mode
is *missing last-fire rows*, i.e. duplicate Discord alerts, the exact bug
`cooldown.ts` exists to prevent.

**Done when.** Paginated, with a test at >1,000 in-window events.

### C.4 Replace the category guard with `opens_position` — ~1h

**Why.** On 09-18 `bigmove_watchlist` (category `watch`) opened six shadow
positions; the fix filtered `category !== 'watch'`.
`avoid_chase_extended` is category `avoid` and passes that filter — it is
saved only because `openAlertPositions` filters `direction === 'long'` and
that trigger happens to be marked `short`. A denylist keyed on the wrong
field; one `avoid` trigger written as `long` reopens the bug.

**Changes.** `triggers.opens_position boolean not null default false`,
true only for `earnings_release`. Select on it instead of inferring.

**Done when.** `openAlertPositions` is reachable only by
`opens_position = true`, and changing `category` or `direction` cannot
open a position.

### C.5 Clean up dead and sentinel `exit_rules` — ~30m

**Why.** `earnings_release` carries `trail_pct: 1` and
`profit_target_pct: 1` — 100%, meaning "disabled," matching its 20-day
study. Everywhere else these are decimals like `0.03`. A reader who reads
1 as 1% sees a position that exits instantly. Separately `rvol_breakout`
carries a full `exit_rules` object but is category `watch` and can never
open a position.

**Done when.** No `exit_rules` value is a disabled-sentinel `1`, and no
non-position trigger carries exit rules.

### C.6 Retire `sim-intraday-flips` — ~30m

**Why.** Audited 2026-09-11 with four unfixed defects (no cost model,
lookahead in the RVOL denominator, no gap/split guard on the daily roll,
mixed price bases) plus a latent `.limit(1000)`. It produced
`catalyst_momentum`'s PF 1.32, which is net 0.779. Still in the tree,
still able to hand a plausible number to whoever runs it next.

**Done when.** It cannot produce a number.

---

## Phase D — Foundation for measurement (~8h)

### D.1 Tests for the evaluator and the cooldown — ~2h

**Why.** There is no test file in the repo. `evaluateTrigger` is twelve
lines and the most leveraged function in the system — every fire, live
and backtested, passes through it — and its null handling, type coercion
and operator semantics are unverified. `earnings_release` and
`avoid_reverse_split` both test `field == 1` through a strict `===`; both
do fire on real data (confirmed in −1.1), but nothing guards that.

**Changes.** `vitest` or `node --test`. Cover every operator,
null/undefined fields, boundary equality, boolean-vs-number coercion on
`eq`, malformed definitions; and for cooldown, exactly-at-threshold,
mixed cooldowns in one batch, and >1,000 in-window events.

**Done when.** Tests run in CI on every PR.

### D.2 Store full OHLC in `bars_intraday` — ~3h

**Why.** `intraday-bars-scan` writes `{ symbol_id, ts, price: b.c,
volume: b.v }` — Alpaca's `o`, `h`, `l` are fetched and discarded. So
`session_high`, `session_low`, the opening range, `pct_off_hod`,
`pct_off_lod`, `range_expansion` and `risingLows()` are all close-based.
On these names the wick *is* the move: breakouts that traded through the
opening-range high and reverted inside the minute are invisible, and stop
risk is understated everywhere.

Under the new architecture this matters mainly for Stage 3 and the
monitoring tier, but it is also the input to any future intraday study.

**Changes.** Add `open`/`high`/`low` (nullable), write them, use them for
extremes and the opening range while keeping `close` for VWAP and
returns. Fall back to `close` when null. Forward-only.

**Done when.** `session_high` equals `max(bars_intraday.high)` and differs
from the close-based value on a majority of active names.

### D.3 Re-baseline the affected thresholds — ~3h

**Why.** D.2 changes the meaning of four live conditions.
`pct_off_hod >= -0.02` currently measures distance from an understated
high, so it fires more often than intended.

**Done when.** `rvol_breakout` and `avoid_chase_extended` fire rates are
re-measured before and after and recorded, and any threshold change cites
its study.

---

## Phase E — Build the three stages (~14h)

**Gated on Phase A.** Scope follows the decision rule in A.1.

### E.1 Stage 1 — the analysis pass — ~3h

Scoring after 22:30 (C.1), producing a ranked shortlist through the
`getShortlist()` boundary (B.1), drawing on both mechanisms (B.2). Target
list size ~15–25: small enough that Stage 2 is cheap, large enough to be
worth reading.

### E.2 Stage 2 — shortlist enrichment — ~6h

Per-symbol work that is only affordable when scoped:

- Float and listing status (**Robinhood MCP — a Claude session, not a
  host job**; this is the piece the architecture exists to make possible)
- Borrow availability (IBKR), short interest (FINRA)
- Balance sheet, cash runway (SEC XBRL — already synced)
- Offering history and recent filings (`sec_filings`)
- **Float rotation** = session volume ÷ float. The small-cap metric the
  system has both inputs for and does not compute. Amber until studied.
- News, with the existing roundup filter

**Done when.** Every shortlisted name has a complete enrichment record by
07:00 ET, and missing fields are shown as missing rather than absent.

### E.3 Stage 3 — the pre-open report — ~5h

~08:00–08:30 ET. Last night's shortlist plus overnight 8-Ks, pre-market
gap and pre-market volume. Delivered to Discord and the site.

Note this needs pre-market bars, which the factor layer currently filters
out by design (`intradayFactors` is regular-session only, correctly —
pre/post bars distort VWAP and the opening range). Pre-market data should
be a separate read for the report, **not** folded into session factors.

**Done when.** A report lands before 08:30 ET containing the shortlist,
its enrichment, and overnight changes.

---

## Phase F — The monitoring tier (~6h)

Reframed from "live alert engine" to "monitoring on names already on the
list." Gated on Phase E.

### F.1 Scope intraday alerting to the shortlist + tracked — ~2h

**Why.** Solves four problems at once: alert volume drops to something
readable; IEX's thin coverage stops mattering as much because those
specific names can be prioritised; the 28-slot websocket budget becomes
sufficient; and latency matters less because the analysis already
happened.

### F.2 One-minute cadence for the monitored set — ~3h

**Why.** The current chain is bars (5 min) → factors (5 min) → flip-scan
(+2 min), with `FRESH_MINUTES = 15` tolerated: worst case 7–12 minutes
stale. Fine for a 20-day hold, fatal for `avoid_chase_extended`, whose
whole premise is the first hour. At ~20–60 symbols this is cheap.

**Done when.** Median factor-row age behind a monitored alert is under 2
minutes.

### F.3 Re-rank the websocket subscriptions intraday — ~1h

**Why.** The worker picks its symbols once at startup from the previous
close. Band-scoped as of #175, but still static. Under F.1 it should
track the shortlist, with `tracked_symbols` pinned.

---

## Phase G — Close the loop (~6h)

### G.1 Trade journal — ~3h

**Why.** Nothing records actual fills. `shadow_positions` tracks
hypothetical exits. This is the only dataset no vendor can supply and the
only way to learn whether the modelled 1.22% round trip matches reality —
the number the entire strategy verdict rests on.

**Done when.** Realized cost per round trip can be plotted against the
modelled estimate.

### G.2 Live-vs-backtest panel — ~2h

Already on the backlog, unbuilt. `fire_outcomes` and
`backtest_returns_raw` both exist; nothing compares them.

### G.3 Operational resilience — ~1h

Confirm the nightly Supabase backup (#172) is loaded and landing files;
reconcile delisted symbols so `stale_active_symbol` stops growing; fix
the `fundamentals-sync` double invocation and its leaked `running` row.

---

## Phase H — Deferred (ops hygiene, not alert logic)

### H.1 The `job_runs` double heartbeat

One outlier worker process (PID 48383, started 8 Sep) yet **two**
`job_runs` rows heartbeated within the same minute: id 6191 `running`
with 0 ticks, id 547 `failed` with 2,072,977. The row that reads healthy
has done nothing; the row doing the work is marked failed. One live
process cannot legitimately own both.

Deferred because it does not change what fires — but it does mean the
single instruction HANDOFF §3 gives for trusting the system returns a
contradiction for the one always-on component. **Diagnose before
sweeping.** Daemon liveness should derive from heartbeat age, not
`status`.

### H.2 Remaining rules-layer cleanup

`direction` is overloaded (three `avoid` triggers are marked `short` and
none is a short signal, while `inBand` branches on direction); score logic
lives uncatalogued in `eod-scan` rather than in the trigger grammar or a
named registry; thresholds are round numbers with no recorded provenance
and mix feed scales (`volume_ratio_20d >= 25` is SIP daily, `rvol >= 2` is
IEX intraday). Worth doing, none of it urgent under the new architecture.

### H.3 The IEX question — now a clearer "no"

Paying for real-time SIP would improve the monitoring tier's accuracy. It
does not help Stage 1 or Stage 2 at all, and it does not rescue entry
timing, which was the main argument for it. Revisit only if the
monitoring tier proves load-bearing.

---

## Suggested order

1. **Phase A** — pre-register, then run once. It gates Phase E, and every
   exploratory query against $5–$10 spends the holdout. Do not start it
   until A.1 is written down.
2. **B.1** (~1h) — the interface boundary. Do this regardless of A's
   result; it is the cheapest risk reduction available.
3. **Phase C** — defect repair. C.1 is the largest single correctness win
   in the plan: one of `bigmove_score`'s four points has never worked.
4. **D.1 (tests)** before D.2, and before any threshold change.
5. **Phase E**, scoped by A's decision rule.
6. **B.2/B.3**, alongside E.1 — the shortlist should be measured from the
   day it becomes load-bearing.
7. **Phase F**, then **G**. **H** when it becomes annoying.

### The gate, concretely

Do not spend meaningful time on Phase E until:

- [ ] A.1 pre-registration written down **before** A.2 is run
- [ ] A.2 run once; the four cells recorded; decision rule applied
- [ ] B.1 interface boundary in place
- [ ] B.4 floor case recorded
- [ ] C.1 — the analysis stage sees same-day 8-Ks
- [ ] C.2 — the alerting liquidity floor enforced in the live path
- [ ] D.1 — `evaluateTrigger` and `filterByCooldown` under test in CI

## What this plan deliberately does not do

**No new triggers.** The search returned negative across ~35 variants, a
5-year backtest, a duration sweep and a cost model. B.2 adds a second
*mechanism*, not a variant; that distinction is the whole point.

**No re-opening of the strategy verdict.** D.2 changes intraday factor
values. If that produces a reason to re-study the intraday triggers, it
is a new decision with new evidence, not a reason to re-enable anything
now.

**No automated trading.** Both broker connections stay read-only.

**No mining of the holdout.** One pass at $5–$10, pre-registered. Any
further question against that range is labelled non-holdout in the README
the moment it is asked.

**No account-size fiction.** At $40 with `max_risk_pct` 0.20, position
sizing is not a solvable problem; the live tier is a simulation and the
plan treats it as one.

## Resolved since the first draft

The earlier version ended on an open question: the only Buy is a 20-day
hold, which pointed away from the "day trading tool" framing. **Resolved
by the architecture above.** RIOT is a preparation engine: EOD analysis,
overnight enrichment, a pre-open report, and intraday monitoring on a
known list. The 20-day `earnings_release` hold and the next-session
`bigmove_watchlist` both fit that shape. Nothing in the evidence supports
an intraday entry engine, and the plan no longer pretends otherwise.
