# Signal-logic revamp — step-by-step plan

**Goal:** re-aim the trigger/scoring/exit logic at what the account is
actually doing — buying sub-$5 names and flipping them over hours to a
few days — instead of the multi-week, market-wide, end-of-day equity-
factor strategy the current triggers implement.

This is a sequenced plan. Each phase is independently shippable and
leaves `main` deployable. Do them in order: later phases depend on the
measurement and data plumbing built in earlier ones.

## Why the current logic doesn't fit (summary of the 2026-09-10 audit)

- **Horizon:** every backtest horizon is 5/10/20 trading days; `deep-dive`
  scores alerts on the 10-day stat; `momentum_exit` holds up to 180 days.
  Nothing measures a 1–3 day move.
- **Universe:** `momentum_rank_pct` / `roc_20d_rank_pct` / `ret_1w_rank_pct`
  are percentiles across all ~5,000 symbols. Penny names are ranked against
  mega-caps on factors built for a diversified book. Backtest shows
  `momentum_rank_entry` at negative expectancy for this reason.
- **Frequency:** `intraday-scan` evaluates `bb_rsi_confluence_long` on
  `factor_state` values from *yesterday's close*. No trigger reads
  `bars_intraday`. There is no RVOL / VWAP / opening-range / gap signal.
- **Regime:** 8 enabled triggers require `risk_on` (SPY > 200DMA & not
  high-vol). Penny speculation often runs in exactly the tape that gates.
- **Exit:** no profit target, trailing stop, ATR stop, or short time-stop
  anywhere. `momentum_exit` only covers momentum shadow positions.
- **Confluence:** `min_confluence = 1`, so the gate promotes every in-band
  fire. The "≥2 signals agree" safety concept is currently inactive.

Keep: the pipeline plumbing (pending_fires → gate → dossier → alert),
`riskFlags.ts`, risk-defined sizing, cooldowns, `alert_excluded`.

---

## Phase 0 — Measurement foundation

You cannot tell if any later change helps without a yardstick sized to the
trade. Build this first.

### 0.1 Add short horizons to the backtest
- **Files:** `netlify/functions/backtest-triggers.ts`, `finalize_backtest_stats()` (migration).
- Change `HORIZONS = [5, 10, 20]` → `[1, 2, 3, 5, 10]`.
- `finalize_backtest_stats()` already aggregates per `horizon_days`; confirm
  it has no hardcoded horizon list. Add a migration if it does.
- Re-run `backtest-triggers` (`{"reset": true}` first chunk).
- **Acceptance:** `trigger_stats` has rows for `horizon_days` 1/2/3 for every
  backtestable trigger.

### 0.2 Make the dossier score horizon configurable
- **Files:** `netlify/functions/deep-dive.ts`, `scan_config` (migration:
  add `score_horizon_days int default 3`).
- Replace the `HISTORICAL_HORIZON_DAYS = 10` constant with the config value.
- **Acceptance:** dossier `analysis.historical.horizon_days` reflects
  `scan_config.score_horizon_days`.

### 0.3 Realized-outcomes tracker (works for every trigger, live)
- **New table:** `fire_outcomes` — one row per promoted `trigger_event`:
  `trigger_event_id`, `symbol_id`, `entry_ts`, `entry_price`, plus
  `ret_1d / ret_2d / ret_3d / ret_5d / mfe_pct / mae_pct` (max favorable /
  adverse excursion), filled in by a scheduled job.
- **New function:** `record-fire-outcomes.ts` — scheduled ~30 min after
  close: for every `fire_outcomes` row missing a forward return whose
  horizon has now elapsed, pull the bars and fill it.
- **Why:** this is the only way `realtime_outlier_zscore`, `momentum_exit`,
  and every *new* intraday trigger ever get an expectancy number —
  `backtest-triggers` can't replay them.
- **Acceptance:** after a week, `fire_outcomes` has filled 1d/2d/3d returns
  and MFE/MAE for recent events; a simple query gives win-rate per trigger.

---

## Phase 1 — Exit engine (highest priority build)

A flip strategy is mostly exit discipline. Right now there is none beyond
the entry-time suggested stop that nothing tracks.

### 1.1 Generalize shadow positions to every entry trigger
- **Files:** `eod-scan.ts` (currently only opens shadow positions for
  `ENTRY_TRIGGER_NAMES`), `confluenceGate.ts`.
- Open a `shadow_positions` row for **every promoted long `trigger_event`**,
  not just momentum. Record `entry_price`, `entry_ts`, `stop_price`
  (from `tradeSuggestion`), `trigger_id`.

### 1.2 Exit rule set (new, replaces the 180-day arm for flips)
- **New table columns / config** on `scan_config`: `flip_profit_target_pct`
  (e.g. 0.15), `flip_time_stop_days` (e.g. 4), `flip_trail_pct` (e.g. 0.10),
  `flip_hard_stop_pct` (already `default_stop_pct`).
- **New function:** `manage-positions.ts` — runs every 5 min during market
  hours (alongside `intraday-bars-scan`) over open `shadow_positions`:
  - profit target hit (`last >= entry * (1 + target)`) → exit `take_profit`
  - trailing stop (`last <= running_high * (1 - trail)`) → exit `trail_stop`
  - hard stop (`last <= stop_price`) → exit `hard_stop`
  - time stop (`now - entry_ts > time_stop_days`) → exit `time_stop`
  - lost-VWAP / catalyst-faded (needs Phase 2) → exit `vwap_lost`
- Each exit fires a `momentum_exit`-style event through the existing
  dossier/alert pipeline so you get a Discord "SELL" with the reason and
  realized P/L.
- **Files:** new `manage-positions.ts`, reuse `stageAndPromote` /
  `deep-dive` path; extend `eod-scan.ts` exit logic or move it here.
- **Acceptance:** open a shadow position manually, watch it exit on each
  rule in a paper scenario; the exit alert shows entry, exit, reason, P/L.

### 1.3 Retire the 180-day / rank-drop exit for flips
- Keep `momentum_exit`'s slow arms only if you still run any genuine
  swing entries; otherwise gate them behind a `strategy` tag on the
  position so flip positions use only the 1.2 rules.

---

## Phase 2 — Real intraday factor module

Everything downstream (flip triggers, VWAP exits) needs live intraday
factors computed from `bars_intraday`, which is already populated.

### 2.1 `lib/intradayFactors.ts` (pure, no I/O — mirrors `indicators.ts`)
Given a symbol's intraday bars for the session + prior daily close +
a 20-day average-volume-by-minute profile, compute:
- `gap_pct` — session open vs prior close
- `rvol` — cumulative session volume ÷ average cumulative volume for this
  minute-of-session over the trailing 20 days
- `vwap`, `dist_vwap` — last price vs session VWAP
- `or_high` / `or_low` — first 15-min range; `or_break` (±1 = broke out)
- `pct_off_hod` / `pct_off_lod` — for exit logic
- `intraday_higher_lows` — simple structure flag
- `range_expansion` — today's true range vs 20-day ATR

### 2.2 Minute-of-session volume profile
- **New table:** `intraday_volume_profile` — `symbol_id`, `minute_of_session`
  (0–959), `avg_volume`, rebuilt nightly from `bars_intraday` (7-day window,
  since that's all we retain) by a scheduled function
  `refresh-intraday-volume-profile.ts`.
- Only needs the priority set `intraday-bars-scan` already covers.

### 2.3 Wire into `intraday-scan.ts`
- After `fetchSnapshots`, also load each candidate's `bars_intraday` for
  today and its profile row, run `intradayFactors()`, and put the results
  in the `TriggerInputs` object — replacing the stale `factor_state`
  `bb_pctb`/`rsi2` for the intraday path, or alongside them.
- **Acceptance:** `trigger_evaluations` rows for the intraday scan show
  live `rvol`, `dist_vwap`, `gap_pct` in their `inputs` blob.

---

## Phase 3 — Flip-native triggers

Built on Phase 2. Add as new rows in `triggers` (`category = 'intraday'`,
`direction = 'long'`), evaluated by `intraday-scan` via the declarative
evaluator (extend `triggers.ts` ops if needed — e.g. `between`).

Candidate set (tune thresholds against `fire_outcomes` after 2–3 weeks):

| name | definition sketch |
|---|---|
| `rvol_breakout` | `rvol ≥ 3` AND `or_break = 1` AND `dist_vwap ≥ 0` AND price in band |
| `vwap_reclaim` | crossed from `dist_vwap < 0` to `≥ 0` this bar AND `rvol ≥ 2` |
| `gap_and_go` | `gap_pct ≥ 0.10` AND `last ≥ or_high` AND `rvol ≥ 4` |
| `squeeze_release_intraday` | `bb_width_percentile_126d ≤ 0.1` (EOD, still valid) AND `range_expansion ≥ 2` AND `rvol ≥ 3` |

Notes:
- Drop the `risk_on` condition from these — see Phase 6.
- Keep `bb_rsi_confluence_long` but recompute `bb_pctb`/`rsi2` intraday in
  Phase 2.3 so it actually times entries.
- Deprecate `momentum_rank_entry` / `momentum_breakout` for this account
  (disable, or keep visible-only) — negative expectancy, threshold
  near-unreachable at 5,000 symbols.

**Acceptance:** each new trigger fires in `pending_fires` with a sane rate
(single digits per day, not hundreds) and `fire_outcomes` starts
accumulating.

---

## Phase 4 — Catalyst trigger

For quick flips the catalyst *is* the edge. Pieces exist (`fetchNews`
Benzinga, `bars_intraday`); wire them into a trigger.

### 4.1 News ingestion for the band
- **New function:** `news-scan.ts` — every ~5 min during market hours,
  `fetchNews` for the in-band liquid set + tracked, upsert into a new
  `symbol_news` table (`symbol_id`, `headline`, `url`, `created_at`,
  `source`). (`deep-dive` currently fetches news per-fire only.)

### 4.2 `catalyst_momentum` trigger
- Fires when: newest `symbol_news` row < 2h old AND `rvol ≥ 3` AND
  `dist_vwap ≥ 0` AND price in band.
- Evaluated in `intraday-scan` (needs the news table + Phase 2 factors).
- **Acceptance:** back-check against a known recent runner — the trigger
  should have fired within ~30 min of the headline.

---

## Phase 5 — Redefine confluence, then re-enable

### 5.1 Direction + speed classes
- Add `speed` to `triggers` (`fast` | `slow`). Fast = intraday flip
  triggers + outlier + `bb_rsi_confluence_long`. Slow = momentum / MACD /
  earnings drift.
- Confluence only counts triggers of the **same speed class** toward a
  cluster — a daily MACD cross and an intraday RVOL breakout aren't
  corroborating the same thesis.

### 5.2 Tighten the window for fast clusters
- `confluenceGate.WINDOW_HOURS = 30` is fine for slow; add
  `FAST_WINDOW_MINUTES = 90` for fast-class clusters.

### 5.3 Re-enable
- Set `scan_config.min_confluence = 2` **for fast-class only**; lone fast
  fires stay in `pending_fires` (feed shows them, no alert). Slow fires can
  keep `min_confluence = 1` or be visibility-only.
- **Acceptance:** a real 2-fast-trigger cluster promotes and alerts; a lone
  RVOL breakout does not.

---

## Phase 6 — Regime rethink

- Split the regime concept: keep `risk_on` as *context on the dossier*, but
  **stop using it as a hard gate** on the mean-reversion / squeeze / outlier
  / intraday-flip triggers. Those want volatility.
- Optionally add a penny-specific froth gauge (breadth of sub-$5 names up
  >20% on the day, from `top_movers` data) and surface it on the dashboard
  as the regime banner for this strategy.
- **Files:** trigger `definition` edits (remove `risk_on` conditions),
  `dailySnapshot.computeRegime`, `RegimeBanner.tsx`.

---

## Phase 7 — Repurpose the outlier worker

- Current: 28 symbols by dollar volume (the least penny-like in the band).
- Change symbol selection in `worker/src/index.ts`: tracked symbols first,
  then fill from the in-band liquid set **ordered by RVOL / today's %
  move**, refreshed on a timer (not just at startup) so it rotates onto
  whatever is active.
- Consider a paid Alpaca SIP plan only if full-universe realtime becomes
  the bottleneck.
- **Acceptance:** worker log shows it watching in-band movers, not AAPL-tier
  names.

---

## Phase 8 — Validation loop

- After each of Phases 3–6 ships, let `fire_outcomes` accumulate 2–3 weeks.
- Build a `Reports.tsx` panel: per trigger, live win-rate / avg 2-day
  return / avg MFE / avg MAE from `fire_outcomes`, next to the backtest
  `trigger_stats`.
- Kill or retune any trigger whose live 2-day expectancy is negative after
  ~30 fires. This is the real backtest for this universe.

---

## Config change checklist (`scan_config`)

| field | now | target | phase |
|---|---|---|---|
| `score_horizon_days` | (n/a — hardcoded 10) | 3 | 0.2 |
| `min_confluence` | 1 | 2 (fast class) | 5.3 |
| `flip_profit_target_pct` | — | 0.15 | 1.2 |
| `flip_trail_pct` | — | 0.10 | 1.2 |
| `flip_time_stop_days` | — | 4 | 1.2 |
| `default_stop_pct` | 0.12 | ATR-scaled, ~0.12 floor | 1.2 |
| `max_rsi14` | 85 | keep | — |
| `price_max` | 5.00 | keep | — |

## Trigger disposition

| trigger | action | phase |
|---|---|---|
| `momentum_rank_entry` | disable (negative expectancy, unreachable threshold) | 3 |
| `momentum_breakout` | disable or visibility-only | 3 |
| `bb_rsi_confluence_long` | keep, recompute intraday | 2.3 |
| `macd_bullish_cross` | slow class, visibility-only | 5.1 |
| `volatility_squeeze_breakout_long` | keep, add intraday variant | 3 |
| `earnings_surprise_drift` | leave inert (no estimates feed) | — |
| `realtime_outlier_zscore` | keep, repoint worker | 7 |
| `*_short`, `macd_bearish_cross` | leave disabled (long-only account) | — |
| `rvol_breakout`, `vwap_reclaim`, `gap_and_go`, `catalyst_momentum` | new | 3–4 |
| `momentum_exit` | shorten arms, generalize | 1 |

## Dependency order

```
0.1 0.2 0.3  ─┬─►  1.1 1.2 1.3  ──►  (exit engine live)
              │
              ├─►  2.1 2.2 2.3  ──►  3 (flip triggers)  ──►  5 (confluence)  ──►  8 (validate)
              │                          │
              │                    4.1 4.2 (catalyst)  ──┘
              │
              └─►  6 (regime)   7 (worker)   — independent, any time after 2
```

## Risks / open questions

- **Free IEX feed coverage.** RVOL/VWAP computed from IEX-only prints
  undercount true volume, especially for thin names. Accept as directional,
  or budget for SIP.
- **7-day `bars_intraday` retention** limits the volume profile to a
  7-session average — noisy. A small dedicated `intraday_volume_profile`
  table (Phase 2.2) that survives the prune mitigates this.
- **Sample size.** Even at a few flip signals/day, 30 fires per trigger is
  ~6–8 weeks. Expect to run on backtest priors + gut for the first month.
- **Slippage.** Sub-$1 names: a 15% profit target can be 1–2 cents of
  spread. Model fills conservatively in `fire_outcomes` (use the *next*
  bar's open, not the signal bar's close).
