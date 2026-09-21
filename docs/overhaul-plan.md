# RIOT overhaul — scoped plan

Written 2026-09-21, from a full read of `README.md`, `docs/HANDOFF.md`,
`docs/ACCESS.md`, the live alert path (`intraday-bars-scan`,
`intraday-factors-scan`, `intraday-flip-scan`), the rules layer
(`lib/triggers.ts`, `lib/cooldown.ts`, `lib/promotionGate.ts`,
`lib/alertPositions.ts`), the outlier worker, and the production
`triggers` table.

**Premise.** The research verdict is settled and this plan does not
re-litigate it: nothing tested has a multi-regime edge on the sub-$5
universe net of costs. Given that, the product is no longer "a signal
generator" — it is a **situational-awareness console for a discretionary
trader**, and it should be overhauled to be excellent at that. Three
things block it:

1. **The code disagrees with the documentation** in the live alert path.
   The alerting liquidity floor is not applied to any intraday alert.
2. **The intraday data is lossy by construction.** `bars_intraday` stores
   only the close, so every high/low/range factor is understated.
3. **The rules layer is under-specified where it grew.** The declarative
   engine evaluates thresholds; the real logic lives uncatalogued in scan
   code, and no part of it has a test.

Everything below is sequenced so each phase leaves `main` deployable.
Rough total: **34–45 hours**.

> **Read Phase −1 first.** Every defect in Phases 0–2 was found by
> *reading code*, not by verifying the engine against reality. A 30-minute
> check on 2026-09-21 found two things code review had missed (a trigger
> that has never fired, and an ops view that contradicts itself). Until
> the engine can demonstrate it is correct, repairing individual defects
> is guesswork about which ones matter. **Phase −1 is a gate: do not
> start Phase 0 until it passes.**

---

## Phase −1 — Establish ground truth (~6h) — GATE

**Why this is first.** The project has found six silent-corruption bugs.
The response each time was to write more careful research code. What was
never built is a **standing verification layer** that answers "is the
engine correct *today*" without a human reading source. HANDOFF §3 says
"check `job_runs` before believing any job works" — but `job_runs` is one
of the things that is currently wrong (see −1.2). Right now nothing in
the system can tell you whether the engine is trustworthy, and that — not
any individual defect below — is the top issue.

### −1.1 Prove every enabled trigger fires correctly — ~2h

**Why.** `realtime_outlier_zscore` is enabled and has fired **0 times in
30 days**, while its worker reports 2,072,977 processed ticks. That is the
signature of an unreachable threshold — the same failure the README
already documents for `momentum_rank_entry` ("an unreachable percentile
threshold at this symbol count") and for `bb_rsi_confluence_short` /
`macd_bearish_cross` ("fired zero times in 5 years… not 'negative
expectancy' so much as unreachable"). **This is the fourth instance of a
known failure mode, live in production, presenting in the UI as an
enabled trigger.** Nothing flagged it because nothing checks.

Separately, `earnings_release` and `avoid_reverse_split` both test
`field == 1` through `compare()`'s strict `===`. If either underlying
column is a boolean rather than a number, the rule silently never fires
and looks identical to "no setup today."

**Changes.**
- For each enabled trigger, record over a fixed lookback: evaluations,
  fires, promotions, alerts. A trigger with evaluations > 0 and fires = 0
  is **presumed broken**, not "quiet."
- Confirm the stored type of every field an enabled trigger references;
  assert number-vs-boolean at evaluation time rather than failing closed
  in silence.
- Diagnose `realtime_outlier_zscore` specifically: is the z-score
  threshold reachable given `ewmaAlpha` and `minTicksBeforeEval`? Either
  fix the threshold or disable the trigger — an enabled trigger that
  cannot fire is a lie in the UI.

**Done when.** Every enabled trigger has either fired on real data in the
lookback, or is disabled with the reason recorded.

### −1.2 Make the ops view tell the truth — ~2h

**Why.** As of 2026-09-21 13:00 UTC there is exactly **one** outlier
worker process (PID 48383, started 8 Sep). Yet **two** `job_runs` rows for
`realtime-outlier-worker` were heartbeated within the last minute:

| id | status | started | ticks | last heartbeat |
|---|---|---|---|---|
| 6191 | `running` | 09-18 | **0** | 36s ago |
| 547 | `failed` | 09-08 | 2,072,977 | 39s ago |

The row that reads healthy has processed nothing; the row doing the work
is marked failed. One live process cannot legitimately own both. So the
single instruction the handoff doc gives for trusting the system — check
`job_runs` — currently returns a contradiction for the one always-on
component. This must be understood before it is patched; do not just
sweep the rows.

Related, already known: `fundamentals-sync` leaks a `running` row, and
628 stale `running` rows were swept on 09-18.

**Changes.**
- Diagnose the double-heartbeat (stale `jobRunId` reuse in
  `Heartbeat.beat()`, a second `start()` call, or a non-launchd writer).
- A daemon's liveness must be derived from heartbeat age, not from
  `status`; `failed` with a 39-second-old heartbeat is nonsense.
- Add a check to `data-integrity-check`: more than one open heartbeat row
  per daemon, any `running` row older than its job's expected duration,
  and any enabled trigger with zero fires in N days → Discord.

**Done when.** `job_runs` has exactly one open row per running daemon,
and `data-integrity-check` alerts on the three conditions above.

### −1.3 End-to-end reconciliation on one symbol — ~1h

**Why.** Nothing verifies that the bars, the factor row, the trigger
snapshot, the dossier and the rendered UI agree. Every silent-corruption
bug in this project's history was a disagreement between two layers that
nothing compared.

**Changes.**
- A script that takes a ticker and a session and prints, side by side:
  `bars_intraday`-derived session state, the `intraday_factor_state` row,
  any `trigger_events.snapshot`, and what the symbol page renders.
- Run it against a name that fired and one that did not.

**Done when.** The four layers agree for both cases, or the disagreement
is documented.

### −1.4 Decide what the live evidence base is — ~1h (decision)

**Why.** `trigger_events` holds **118 rows spanning two trading days**
(09-17 → 09-18); all prior history was deleted in the 09-17 reset.
`fire_outcomes` has the matching 118. That is the entire live track
record. It is not enough to judge any trigger, and it means "the engine
is working" currently rests on two days of data.

**Changes.** State explicitly in the README how many sessions of clean
live history must accrue before any trigger is judged on live outcomes,
and do not re-reset without an export.

**Done when.** The bar is written down, and a pre-reset export step
exists.

---

## Phase 0 — Make the code match the documentation (~4h)

Nothing here is a feature. Every item is a place where the system does
something other than what `README.md` says it does.

### 0.1 Apply the alerting liquidity floor to live intraday alerts — ~1h

**Why.** `intraday-factors-scan` builds its universe from
`scan_config.monitor_min_dollar_vol_20d` (**$800k/day**, correct — it is
the monitoring band). `intraday-flip-scan` then filters `liveRows` on
`price_min` / `price_max` and `alert_excluded` only, and inserts straight
into `trigger_events`, deliberately bypassing `promotionGate`. The result:
`min_dollar_vol_20d` (**$2.5M/day**) is never applied to any live alert.
Every `rvol_breakout` and `avoid_chase_extended` card can fire on a name
at a third of the documented alerting floor. On this universe that is the
line between tradeable and untradeable.

**Changes.**
- In `intraday-flip-scan.ts`, read `min_dollar_vol_20d` alongside the
  price bounds, and filter `liveRows` on the symbol's latest
  `factor_state.dollar_vol_20d` before evaluation.
- Prefer reusing `promotionGate.inBand()` over a second copy of the rule;
  if the gate stays bypassed for the cooldown/ranking reasons in that
  file's docstring, extract `inBand` and call it directly.
- A symbol whose dollar volume is unknown does **not** qualify (match the
  gate's existing "better to miss a signal than alert on something
  untradeable").

**Done when.** A session's `trigger_events` from `intraday-flip-scan`
contain no symbol whose latest `factor_state.dollar_vol_20d` is below
`scan_config.min_dollar_vol_20d`. Expect fire counts to drop materially —
that is the fix working, not a regression.

### 0.2 Paginate the cooldown query — ~30m

**Why.** `filterByCooldown` runs
`.select(...).in("trigger_id", ...).gte("ts", cutoff)` with no `.order()`
and no range. HANDOFF §3 records that PostgREST silently truncates at
1,000 rows without an explicit order, and the README documents six
instances of this exact bug family. The max cooldown among fast triggers
is 1,440 minutes, so this pulls a full day of events. At ~25–40
alerts/day it is not truncating today — but the failure mode is *missing
last-fire rows*, i.e. duplicate Discord alerts, which is the precise bug
`cooldown.ts` was written to prevent.

**Changes.**
- Add `.order("ts", { ascending: false })` and page with `.range()` until
  a short page, matching the loop already used in `intraday-flip-scan`
  for `intraday_factor_state`.

**Done when.** The query is paginated and a synthetic test with >1,000
events in-window returns every `(trigger_id, symbol_id)` last-fire.

### 0.3 Replace the category guard with an explicit `opens_position` — ~1h

**Why.** On 2026-09-18, `bigmove_watchlist` (category `watch`) opened six
shadow positions. The fix filtered `category !== 'watch'` at the creation
site. `avoid_chase_extended` is category `avoid`, so it passes that
filter — it is saved only because `openAlertPositions` filters
`direction === 'long'` and that trigger happens to be marked `short`. The
guard is a denylist keyed on the wrong field; one `avoid` trigger written
as direction `long` reopens the same bug.

**Changes.**
- Migration: `alter table triggers add column opens_position boolean not
  null default false;` then set it true only for `earnings_release` (and
  any future buy setup).
- `intraday-flip-scan` and `eod-scan` select on `opens_position` instead
  of inferring from `category` / `direction`.

**Done when.** `openAlertPositions` is reached only by triggers with
`opens_position = true`, and flipping any trigger's `category` or
`direction` cannot open a position.

### 0.4 Clean up dead and sentinel `exit_rules` — ~30m

**Why.** `earnings_release` carries `trail_pct: 1` and
`profit_target_pct: 1` — 100%, meaning "disabled", matching its 20-day
study. Everywhere else these are decimals (`0.03`, `0.12`). A reader who
reads 1 as 1% sees a position that exits instantly. Separately,
`rvol_breakout` carries a full `exit_rules` object but is category
`watch` and can never open a position — dead config that reads as live.

**Changes.**
- Migration: set `earnings_release.exit_rules` trail/profit-target to
  `null`; confirm `alertPositions`'s `{...rules, ...exitRules}` merge
  skips nulls rather than writing them (adjust the merge if not).
- Migration: null out `rvol_breakout.exit_rules`.

**Done when.** No `exit_rules` value in `triggers` is a disabled-sentinel
`1`, and no disabled-for-positions trigger carries exit rules.

### 0.5 Retire `sim-intraday-flips` — ~30m

**Why.** Audited 2026-09-11 with four unfixed defects (no cost model,
lookahead in the RVOL denominator via `perMinuteMean()`, no gap/split
guard on the daily roll, mixed intraday/daily price bases) plus a latent
`.limit(1000)`. It produced `catalyst_momentum`'s PF 1.32, which is net
0.779. It is still in the tree and will hand a plausible number to
whoever runs it next.

**Changes.** Delete it, or make it throw on entry with a pointer to the
audit. Deleting is the honest call given "do not add a 36th trigger
variant".

**Done when.** The file cannot produce a number.

---

## Phase 1 — Fix the intraday data (~6h)

### 1.1 Store full OHLC in `bars_intraday` — ~3h

**Why.** `intraday-bars-scan.ts` writes
`{ symbol_id, ts, price: b.c, volume: b.v }` — Alpaca's `o`, `h` and `l`
are fetched and discarded. Every downstream factor in
`lib/intradayFactors.ts` is therefore close-based: `session_high`,
`session_low`, the 15-minute opening range, `pct_off_hod`, `pct_off_lod`,
`range_expansion`, and `risingLows()`. On sub-$5 names the wick *is* the
move. Today the system misses breakouts that traded through the opening-
range high and reverted inside the minute, and understates stop risk on
every name. This is the highest-value single change in the repo.

**Changes.**
- Migration: add `open`, `high`, `low` (nullable) to `bars_intraday`.
- `intraday-bars-scan.ts`: write `b.o` / `b.h` / `b.l`.
- `lib/intradayFactors.ts`: take `high`/`low` on `IntradayBar`; use them
  for `session_high`/`session_low`, opening range, `pct_off_hod`,
  `pct_off_lod`, `range_expansion` and `risingLows()`. Keep `close` for
  VWAP, `session_return` and `gap_pct`. Fall back to `close` when
  high/low are null so historical rows still evaluate.
- Forward-only; no backfill needed.

**Done when.** For a sample session, `session_high` from the factor layer
equals the max of `bars_intraday.high`, and differs from the close-based
value on a majority of active names.

### 1.2 Re-baseline the affected thresholds — ~3h

**Why.** 1.1 changes the meaning of four live conditions. `pct_off_hod >=
-0.02` currently measures distance from an *understated* high, so it
fires more often than the rule intends; after the fix it tightens.
`rvol_breakout` and `avoid_chase_extended` fire counts will both move.

**Changes.**
- Re-run the minute studies in `research/schema_lab.py` on OHLC-correct
  session state.
- Record the new fire rates for both live fast triggers over a week
  before and after, in the README.

**Done when.** Both triggers' fire rates are re-measured and documented,
and any threshold change cites the study that produced it.

---

## Phase 2 — Make the rules layer say what it means (~8h)

### 2.1 Tests for the evaluator and the cooldown — ~2h

**Why.** There is no test file in the repo. `evaluateTrigger` is twelve
lines and the single most leveraged function in the system: every fire,
live and backtested, passes through it. Its null handling, type coercion
and operator semantics are unverified. `reverse_split_window == 1` and
`earnings_release == 1` rely on `eq` doing strict `===` against whatever
type `factor_state` actually stores — if either is a boolean column, the
rule silently never fires.

**Changes.**
- Add a test runner (`vitest`, or `node --test` to avoid a dependency).
- `triggers.test.ts`: every operator, null/undefined fields, boundary
  equality, boolean-vs-number coercion on `eq`, empty and malformed
  definitions.
- `cooldown.test.ts`: exactly-at-threshold, multiple triggers with
  different cooldowns in one batch, >1,000 events in-window (guards 0.2).
- **Verify against production** which type `reverse_split_window` and
  `earnings_release` hold, and that both triggers have actually fired.

**Done when.** Tests run in CI on every PR, and the two `== 1` triggers
are confirmed to fire on real data.

### 2.2 Split `direction` from intent — ~1h

**Why.** `avoid_chase_extended`, `avoid_volume_blowoff` and
`avoid_reverse_split` are all marked `direction = short`. None is a short
signal; all three mean "do not buy this." `promotionGate.inBand()`
branches on direction (it skips the RSI ceiling for shorts), so the
overload changes eligibility logic for reasons unrelated to the intent.

**Changes.**
- Allow `direction = 'none'`; set it on the three avoid triggers.
- `inBand` applies the long RSI ceiling for `long`, and no directional
  rule for `none`.
- Audit the UI's Buy/Watch/Sell split, which currently keys off a mix of
  `category` and `direction`, for the same overload.

**Done when.** No trigger claims a trade direction it does not mean, and
the Buy/Watch/Sell rule reads from `category` + `opens_position` only.

### 2.3 Give score logic a home — ~4h

**Why.** The declarative engine is doing less than it appears. Four of
six enabled rules are a single threshold on a field computed elsewhere:
`bigmove_score >= 3`, `earnings_release == 1`,
`reverse_split_window == 1`, `volume_ratio_20d >= 25`. The four-part
big-move score — volume ≥3×, move ≥10%, range ≥2×ATR, 8-K since the
previous session — is real logic living in `eod-scan.ts`, invisible to
the `triggers` table, with no test and no backtest-parity guarantee. The
grammar (`all` of flat `{field, op, value}`, six operators, no OR, no
NOT, no arithmetic, no cross-field comparison) cannot express it.

**Two honest options — pick one, do not keep the middle ground.**

- **(a) Extend the grammar.** Add `any` (OR), `not`, and a `score` node
  (`{ score: [...conditions], gte: 3 }`). `bigmove_score` becomes data.
  Cost: the evaluator roughly triples and needs the Phase 2.1 tests
  first.
- **(b) Name the code.** Keep the grammar flat; move every derived field
  into a registry of named, tested pure functions in
  `lib/derivedFields.ts`, and have the `triggers` row reference one by
  name. Cheaper, keeps the evaluator trivial, and makes the real logic
  catalogued and testable.

**Recommendation: (b).** It matches the project's stated position that
the constraint is measurement quality rather than expressiveness, and it
does not grow the one function every fire depends on.

**Done when.** Every field referenced by an enabled trigger is either a
raw column or a named function in the registry, and each has a test.

### 2.4 Record threshold provenance — ~1h

**Why.** Every live threshold is a round number — `rvol >= 2`, `>= 3`,
`session_return >= 0.10`, `gap_pct >= 0.05`, `pct_off_hod >= -0.02`.
None was derived from a distribution. Worse, they mix feed scales:
`volume_ratio_20d >= 25` is SIP daily, while `rvol >= 2 / >= 3` is IEX
intraday — a feed measured at ~1.7% of band volume — and only the daily
side was recalibrated for the 09-17 SIP switch.

**Changes.**
- Migration: add `triggers.evidence_note text` and
  `triggers.calibrated_on date`.
- Populate from the README's trigger disposition table; state the feed
  each threshold was calibrated against.
- Surface on the symbol page's trigger status, so a threshold's basis is
  visible where it is used.

**Done when.** Every enabled trigger states which study and which feed
set its thresholds.

---

## Phase 3 — Build the console the evidence supports (~10h)

The research says stop looking for entry signals. These are the
situational-awareness features a discretionary sub-$5 trader needs, which
the system has the inputs for and does not surface.

### 3.1 Float rotation — ~3h

**Why.** Volume ÷ float is *the* small-cap day-trading metric, and it
separates "heavy volume" from "the entire float changed hands today." You
already hold both inputs: `broker_snapshot` (Robinhood float, 374 names)
and live `cum_volume`. The existing 25× `volume_ratio_20d` flag is a
crude proxy for it.

**Changes.**
- Derived field `float_rotation = cum_volume / float`, in the Phase 2.3
  registry.
- Symbol page + dossier. **Amber**, per the house rule — untested is
  never red.
- Backfill float coverage beyond 374 names (a Robinhood MCP session; it
  cannot run from a host job).

**Done when.** Float rotation shows on every symbol page with known
float, and coverage of the alerting band is recorded.

### 3.2 Halt / LULD state — ~4h

**Why.** Halts are where sub-$5 accounts die, and the system is blind to
them. A resumption traded blind is the single fastest way to lose the
position. This is a genuine gap in a "day trading tool", not a nicety.

**Changes.**
- Derived: a gap in the minute series during RTH on a name that was
  printing is very likely a halt. Flag it.
- Prefer a real source if one is reachable on the current plans (Alpaca's
  trade conditions / halt status); fall back to the derived signal, and
  label which one is in use.
- **Red flag** — this is a proven negative in the house sense.

**Done when.** A halted name is visibly marked on the feed and symbol
page within one scan cycle, and the source (real vs derived) is shown.

### 3.3 Surface what is already collected — ~3h

**Why.** `short_interest` (FINRA, 12 settlements) and `short_availability`
(IBKR borrow) are synced on schedule and under-surfaced; the Financials
panel exists but the README lists short interest as "researched, not
built" for display. Data collected and not shown is pure cost.

**Changes.**
- Short interest as "X% of shares outstanding · N days to cover · as of
  <date>", amber.
- Borrow availability beside it.
- Both on the symbol page and in the dossier for alerting-band names.

**Done when.** Every table the nightly jobs populate is either visible in
the UI or explicitly documented as research-only.

---

## Phase 4 — Make the live tier actually live (~8h)

### 4.1 Two-tier scan cadence — ~4h

**Why.** The chain is `intraday-bars-scan` (5 min) →
`intraday-factors-scan` (5 min) → `intraday-flip-scan` (+2 min offset),
with `FRESH_MINUTES = 15` tolerated. Worst case an alert describes state
7–12 minutes old. For `earnings_release` (20-day hold) that is
irrelevant; for anything named "intraday flip" it is fatal — on a $2
stock seven minutes is the whole move. The cadence is slow because it
scans everything.

**Changes.**
- Fast tier: top ~100 by dollar volume plus everything in
  `tracked_symbols`, at 1-minute cadence, `FRESH_MINUTES` 3.
- Slow tier: the rest of the band, unchanged at 5 minutes.
- Watch Alpaca's 200 req/min ceiling; the fast tier is ~4 chunks of 25.

**Done when.** Median age of the factor row behind a fast-tier alert is
under 2 minutes, measured from `as_of` at insert.

### 4.2 Re-rank the websocket worker's subscriptions intraday — ~2h

**Why.** The one true real-time path is capped at 30 symbols by the free
IEX plan, and `worker/src/index.ts` picks them **once at startup** from
the previous close's `factor_state`. By 10:00 that is the wrong 30 names
— the movers are exactly the ones it is not watching.

**Changes.**
- Re-rank every 15 minutes against `intraday_factor_state` (by RVOL, then
  session move), keeping all `tracked_symbols` pinned.
- Resubscribe on change; log the churn.

**Done when.** The watched set demonstrably follows the day's movers, and
`tracked_symbols` are never evicted.

### 4.3 Decide the IEX question explicitly — ~2h (decision + doc)

**Why.** You measured it: IEX carries ~1.7% of band volume, SIP/IEX
median 58.7×, and thin names can print nothing all session. The delayed-
tape fallback patches the *displayed price*; it does not patch the
*factor layer*, which is still IEX-only by design (tape bars are
deliberately never written to `bars_intraday`). So the live alert engine
reasons about a shadow of the market. There is no third option:

- **(a)** Accept it. The live tier is a screening tool on partial data —
  say so in the UI next to the quote-state tag, not only in the README.
- **(b)** Price Alpaca's paid SIP feed and get real-time consolidated
  intraday. This makes 4.1 and every intraday factor meaningfully
  correct, and it is the only change that would make the intraday
  triggers worth re-studying.

**Done when.** The decision is recorded in the README with its reasoning,
and the UI reflects it.

---

## Phase 5 — Close the loop (~6h)

### 5.1 Trade journal — ~3h

**Why.** There is no record of what was actually filled. `shadow_positions`
tracks hypothetical exits; nothing captures real entries, real fills or
real slippage. This is the only dataset no vendor can supply, and it is
the only way to learn whether the modelled 1.22% round-trip spread
matches reality — the number the entire strategy verdict rests on.

**Changes.**
- Table `trades`: symbol, side, ts, fill price, size, exit ts/price,
  optional `trigger_event_id`, free-text note.
- Manual entry UI (a small form on the symbol page is enough).
- Compare realized slippage against `tradingCosts.roundTripCostPct()`.

**Done when.** Realized cost per round trip can be plotted against the
modelled estimate.

### 5.2 Live-vs-backtest Reports panel — ~2h

**Why.** Already on the backlog (Phase 8, item 4, unbuilt). `fire_outcomes`
and `backtest_returns_raw` both exist; nothing compares them. Without it
a decaying trigger is invisible.

**Done when.** Per trigger, realized `fire_outcomes` sit beside
backtested `trigger_stats` at matching horizons, with fire counts.

### 5.3 Operational resilience — ~1h

**Why.** One Mac, no SSH, no Screen Sharing, unscheduled backups (one
dump, 2026-09-11), IB Gateway needing manual login every ~24h.
`fire_outcomes`, `trigger_events`, `dossiers` and `alerts` exist nowhere
but Supabase, and Supabase Pro's own daily backups are the sole net.

**Changes.**
- Schedule `research/backup_supabase.sh` via launchd (needs `supabase
  link` or `DATABASE_URL` in `.env`) — the nightly job already exists as
  of #172; confirm it is loaded and landing files.
- Reconcile delisted symbols: set `symbols.active = false` when Alpaca's
  asset record says inactive, so `stale_active_symbol` reports only
  genuinely stale-but-listed names.
- Sweep the remaining stale `fundamentals-sync` `running` row and fix the
  double invocation.

**Done when.** Two consecutive nightly backups land in
`~/StackSlashBackups/`, and `stale_active_symbol` stops growing.

---

## Suggested order

**Phase −1 is a gate.** It is ~6 hours and it is the only phase that
answers "can the engine be trusted." Everything after it is wasted effort
if the answer is no, because you would be repairing and extending a
system whose behaviour you cannot verify. Nothing below starts until
−1.1 and −1.2 pass.

Then:

1. **Phase 0** in one or two PRs. All defect repair, ~4 hours, and 0.1
   means a documented safety rule is currently not enforced.
2. **Phase 2.1 (tests)** — promoted ahead of Phase 1. Tests are part of
   the foundation, not part of the rules cleanup. Do them before changing
   any factor math, so 1.1's changes land against a harness.
3. **Phase 1.1 (OHLC)** — the largest single gain in data fidelity;
   every later measurement depends on it.
4. **Phase 2.2–2.4** — the rest of the rules cleanup.
5. **Phase 3** — the product direction. 3.2 (halts) is a safety issue,
   not a feature.
6. **Phase 4.3 (the IEX decision)** gates how much 4.1 is worth. Make the
   call before building the fast tier.
7. **Phase 5** in parallel throughout; it gates nothing and informs
   everything.

### The foundation gate, concretely

Do not spend meaningful time on Phases 1–5 until all of these hold:

- [ ] Every enabled trigger has fired on real data, or is disabled with a
      reason (−1.1)
- [ ] `job_runs` shows exactly one open row per daemon, and daemon health
      is derived from heartbeat age (−1.2)
- [ ] `data-integrity-check` alerts on zero-fire enabled triggers and
      duplicate/stale heartbeat rows (−1.2)
- [ ] Bars → factors → snapshot → UI reconcile for a fired and an
      unfired symbol (−1.3)
- [ ] `evaluateTrigger` and `filterByCooldown` have tests running in CI
      (2.1)
- [ ] The alerting liquidity floor is enforced in the live path (0.1)

## What this plan deliberately does not do

**No new triggers.** The search returned negative across ~35 variants, a
5-year multi-regime backtest, a 1-day-to-6-month duration sweep and a
cost model. Nothing here adds a 36th.

**No re-opening of the strategy verdict.** Phase 1.1 will change intraday
factor values and Phase 4 may change the feed. If either produces a
reason to re-study the intraday triggers, that is a new decision with new
evidence — not a reason to re-enable anything now.

**No automated trading.** Both broker connections stay read-only. Nothing
in this plan places an order.

**No account-size fiction.** At $40 with `max_risk_pct` 0.20, position
sizing is not a meaningfully solvable problem; the live tier is a
simulation regardless, and the plan treats it as one.

## One unresolved product question

`earnings_release` is the only Buy, and its evidence (+4.2% / +0.4% at
20 days) is a **20-day hold**. The one surviving edge and the "day
trading tool" framing point in opposite directions. Phases 3 and 4 build
the discretionary console; Phase 5 measures the swing setup. Both are
defensible — but which one RIOT *is* should be decided explicitly rather
than by whichever phase gets built first.
