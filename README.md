# StackSlash Scanner

A two-tier market scanner — a wide Tier-1 factor surface over the whole
tracked universe, and Tier-2 triggers that fire a deep-dive dossier and a
dedup'd Discord alert — running as the signal engine behind a **live $40
paper-money account trading sub-$5 names**, plus the research harness
built to find out whether any of its signals actually have edge.

## Read this first — current strategy verdict (2026-09-11)

After a full logic-revamp pass (see below), the honest conclusion across
~35 backtested trigger/exit variants, multiple hold horizons, and now a
full 5-year multi-regime band-scoped backtest:

**Nothing tested has a robust, multi-regime trading edge on the sub-$5
universe with Alpaca's free IEX feed.** This matches what the project's
own research bundle said at the start (penny-stock price/volume
prediction is "statistically indistinguishable from random chance").
Specifically:

- Cross-sectional momentum (`momentum_rank_entry`, `momentum_breakout`)
  — negative expectancy at every horizon tested. **Disabled.**
- The "swing" triggers (`bb_rsi_confluence_long`, `macd_bullish_cross`,
  squeeze) held ~15 sessions, band-scoped, full 5-year history: profit
  factor **1.04**, average **+0.31%**, **median −1.6%** — noise, not an
  edge. (An earlier 18-month read of this same idea showed a much
  rosier PF 1.78; that number turned out to be a lucky sample on a
  silently-truncated 1,000-symbol universe — see "The 1000-row-cap bug
  family" below. The corrected 5-year number supersedes it.) Left
  **enabled** (they're the least-bad option and cost nothing to run),
  but should not be trusted as a real edge.
- Intraday "flip" triggers (`rvol_breakout`, `vwap_reclaim`,
  `gap_and_go`) — negative once RVOL was correctly calibrated. **Disabled.**
- `catalyst_momentum` (fresh news + volume spike + above VWAP, exited
  fast) is the one survivor: profit factor **1.32** over 49 backtested
  trades — small sample, single regime, not proven. **Enabled**, being
  watched live via `fire_outcomes`.

A follow-up hold-duration sweep on 2026-09-11 closed the last open
question — *is there simply some other holding period that works?* — in
the negative for every duration from 1 day to 6 months, and found the
mechanism behind it. **The return distribution is a lottery, not an
edge:** median return is negative at every horizon tested, win rate is
under 50% everywhere, and deleting the best 1% of trades turns every
single duration negative. The best mean edge found anywhere (+0.52%) is
also smaller than the bid-ask spread on these names. See "The
hold-duration sweep" below for the full table — and note it had to be
run on repaired data, because it surfaced a sixth instance of a
silent-corruption bug family (see "The forward-return misalignment bug").

Then a **transaction cost model** was built (there had never been one —
every backtest in this project's history assumed free fills at the
close) and it settles the question. Charging a modelled round-trip
spread of ~1.02% turns **every** hold duration negative: net profit
factor 0.657 at 1 day through 0.938 at 18 days, **none above 1.0**. The
cost is larger than the entire measured edge, so there is nothing left
to optimise. See "The cost model" below.

Two further results worth knowing before anyone re-opens this:

- **Nothing predicts the winners.** Scanning entry-time features across
  the top 1% of outcomes — RVOL, volatility, momentum, distance from
  highs, price, dollar volume — the winners are only weakly separable
  from the middle. There is no "incoming large gain" detector to build.
- **Something does predict the disasters.** Fires at **>=25x normal
  volume** returned mean −10.0% / median −16.2% over 18 sessions (PF
  0.489), against roughly break-even for every lower volume bucket. It's
  0.75% of fires so it rescues nothing, but it is a real, mechanically
  sensible risk signal and is now a dossier flag. It also independently
  explains why `rvol_breakout` backtested at 0.72 — that trigger was
  aimed at precisely the wrong tail.

**What this means practically:** the system is a solid, real-time
screening and monitoring tool (Isolator, live feed, dossiers, news,
risk flags, quote tags) built on genuinely correct plumbing. It is *not*
a proven money-making signal generator, and after the cost model that is
no longer an open question on this universe. Treat alerts as things to
look at, not blindly trade. See "The 2026-09-10/11 logic-revamp session"
below for the full derivation, every number, and every bug found along
the way — worth reading before changing any trigger or exit logic,
so the next attempt doesn't re-discover the same dead ends.

## Infrastructure, as deployed right now

| Piece | Where | Status |
|---|---|---|
| Frontend + functions | Netlify, site `stackslash` → https://stackslash.netlify.app | Live, auto-deploys from GitHub `main` |
| Repo | https://github.com/cjaykohler-source/StackSlash | `main` |
| Database | Supabase project `wnzxvdfskmivbyqadtll` (org StackSlash) | **Pro plan** (8 GB, upgraded 2026-09-10 — was free/500MB) |
| Market data | Alpaca, **paper** keys (IEX feed) | No funded account needed for data-only use |
| Alerts | Discord webhook, channel `#heating_up` (bot "HeatBot") | Working |
| Auth | Single Supabase Auth user, `cjaykohler@gmail.com` | Working |
| Mac mini (`stackslash-worker-host`, user `ckohler`, repo `~/StackSlash`) | Always-on, `launchd`, **dedicated to this project** | Runs `worker/` (realtime outlier websocket), `eod-scan` (17:45 ET), weekly fundamentals refresh, all backfills/sims/backtests, and the local DuckDB research warehouse |

**Everything runs on the worker host.** This is the operative rule: no
job, backfill, sim or research script runs anywhere else. A second Mac
(`Chris-Ks-Mac-Mini`, user `chriskohler`) exists and has been used as a
development surface, but nothing there is authoritative — it has its own
clone at `Desktop/StackSlash` and different specs, and sizing figures
measured there do not describe the worker host. Verify with `hostname`
before trusting any capacity number in this file.

Everything else (intraday scans, the flip-position manager, news
polling, prunes) runs as Netlify Scheduled Functions — see
`netlify.toml` for the full cron list. Note that Netlify's ~3-4 min
timeout is why `eod-scan` had to move to launchd in the first place, and
that constraint has shaped more of the design than it should have; see
"The plan forward" for the proposal to move the job runner off it.

Current DB snapshot: **~5,000 active symbols**, `bars_daily` holds
**5 years** (2021-09-10 → 2026-09-10, 5,373,902 rows, 4,997 symbols),
`bars_intraday` holds a rolling **90 days** for the band, DB size
**1,710 MB / 8 GB**.

Largest tables, which is what the free-tier plan below turns on:
`bars_daily` 668 MB, `bars_intraday` 413 MB, `backtest_returns_raw`
269 MB, `trigger_evaluations` 225 MB, `intraday_volume_profile` 50 MB,
`factor_window_stats` 47 MB, everything else ~30 MB combined.

## The research this was built on

Two document bundles were analyzed at the start of this project; the
trigger set is a direct translation of their findings, not generic
technical-analysis folklore.

**Bundle 1 — ~30 papers on technical indicators.** Single indicators
(RSI, MACD on default settings) mostly failed to beat buy-and-hold once
costs were included; *combinations* of indicators beat any single one;
Bollinger Bands + RSI confluence had the strongest evidence across
multiple papers; momentum outperformed moving-average rules in
less-efficient markets; only ~20% of candlestick patterns showed real
signal; volume confirmation was consistently required.

**Bundle 2 — ~24 papers on asset pricing / quantitative finance.**
Cross-sectional momentum (Jegadeesh & Titman — buy past 12-1 month
winners, hold 3-12 months) is the most robust, most-replicated anomaly
in the literature; post-earnings-announcement drift is real but
mechanistically tied to momentum; short-term (1-week) returns *reverse*
rather than continue; a volatility/trend regime filter measurably
improved returns; raw expected value is misleading for skewed payoffs
(the skew-adjusted "CEV" score in `trigger_stats`); **penny-stock
price/volume prediction via ML was statistically indistinguishable from
random chance** — the 2026-09-10/11 session ended up re-deriving this
finding empirically rather than heeding it up front.

## The 2026-09-10/11 logic-revamp session — full derivation

Written to stand on its own. Prior sessions had built out the universe
(8 → ~5,000 symbols), the confluence gate, fundamentals/news enrichment,
and a $40-account sub-$3 targeting band, but never rigorously asked
"do any of these triggers actually make money on this universe." This
session did, end to end, and rebuilt the exit/measurement layer along
the way.

### Phase 0 — measurement foundation
- `backtest-triggers` horizons `[5,10,20]` → `[1,2,3,5,10,20]` trading
  days — the strategy trades in days, the backtest needed to measure that.
- `deep-dive.ts`'s dossier score horizon is now `scan_config.score_horizon_days`
  (default 3) instead of a hardcoded 10.
- **`fire_outcomes`** table + `record-fire-outcomes.ts` (scheduled 23:10
  UTC weekdays) — records the realized forward return
  (`ret_1/2/3/5/10d`) and max favorable/adverse excursion for every
  promoted non-exit `trigger_event`, in the trigger's own direction
  sense. This is how a trigger `backtest-triggers` can't replay
  (`realtime_outlier_zscore`, any intraday trigger, a confluence
  cluster) ever gets a real expectancy number — it accrues one from
  live fires. Entry price = the entry-day `bars_daily` close (matches
  the backtest convention, un-gameable by an aberrant realtime tick).

### Phase 1 — the exit engine
There was no profit target, trailing stop, ATR stop, or short time-stop
anywhere before this — `momentum_exit` only covered momentum shadow
positions on rank-drop / bad-week / 180-day rules.
- Every promoted long cluster now opens a `shadow_positions` row,
  classed by `triggers.speed` (`slow`→swing, `fast`→flip).
- **`manage-positions.ts`** (every 5 min, market hours): walks open
  `flip` positions through hard-stop → profit-target → trailing-stop →
  time-stop, in that order; fires a `momentum_exit` event with the
  realized `pnl_pct` on a close.
- **`triggers.exit_rules`** (jsonb, nullable) — per-trigger overrides on
  the `scan_config` flip defaults, snapshotted onto the position at
  entry so a later config edit never moves a live trade's rules.
- **`lib/flipPositions.ts`** (`openFlipPositions`) — shared by
  `eod-scan` (swing) and `intraday-flip-scan` (flip); fixed a real gap
  where an intraday-promoted fast fire never got a position (only
  `eod-scan`'s own promotes were being turned into positions).
- **`sim-flip-exits.ts`** — replays a trigger's real declarative
  definition against `bars_daily` OHLC, opens a position at the
  signal-day close, and walks the exit rules forward bar-by-bar
  (intrabar, gap-aware). This is the harness that produced every
  swing-side number in this section. Supports `bandOnly` (in-band
  symbols only — correct and ~15x lighter for non-cross-sectional
  triggers) and rule overrides for parameter sweeps.

### Phase 2 — the intraday factor layer
No trigger had ever looked at intraday price action; `intraday-scan`
was evaluating "entry timing" triggers against yesterday's EOD
`factor_state`.
- **`lib/intradayFactors.ts`** (pure): time-of-day-aware RVOL, VWAP +
  distance, gap %, opening-range break, % off session high/low, range
  expansion, a crude rising-lows check — computed from `bars_intraday`'s
  per-minute close+volume.
- **`intraday_volume_profile`** table — trailing average volume per
  regular-session minute per symbol, the RVOL denominator. EWMA-
  accumulated nightly (`refresh_intraday_volume_profile()`); a
  `rebuild_intraday_volume_profile()` full-recompute variant exists for
  after a deep backfill (`refresh-intraday-volume-profile.ts` takes
  `{"rebuild": true}`).
- **`intraday_factor_state`** table + **`intraday-factors-scan.ts`**
  (every 5 min, market hours) — the intraday counterpart to
  `factor_state`, computed for the in-band tradeable set.

**A real calibration bug was found and fixed here**: the volume profile
initially had only ~1 seed session, so live RVOL ran ~2.6x inflated —
`rvol_breakout` fired 12-47 symbols per scan and **5 real Discord
alerts went out from local testing against prod** before this was
caught (dismissed after the fact). Root cause was two-fold: (1) the
profile needed a real multi-week backfill, not one session, and (2) the
RVOL math was summing the expected-volume denominator over *every*
elapsed minute while the numerator only counted minutes that actually
printed — a sparsely-covered IEX name looked artificially low-volume.
Fixed by matching numerator and denominator minute-for-minute and
requiring ≥60 profiled minutes before computing RVOL at all. This
mattered a lot: re-validating `rvol_breakout` on the *correctly*
calibrated RVOL flipped its backtested profit factor from 1.49 (an
artifact) to 0.72 (a real loser) — see Phase 3.

### Phase 3 — intraday flip triggers
Four `fast`-speed triggers created (`rvol_breakout`, `gap_and_go`,
`vwap_reclaim`, `squeeze_release_intraday`) and **`sim-intraday-flips.ts`**
— replays `intradayFactors` against real `bars_intraday` history at
5-minute checkpoints, first-fire-per-session, then walks the same flip
exit rules (intraday close-only, then rolling onto daily OHLC for a
multi-day hold).

Verdict (90-day intraday history, later re-validated after the RVOL fix
and the 5-year daily backfill — see Phase-flow above): `vwap_reclaim`
and `rvol_breakout` are net losers (PF 0.72–0.80); `gap_and_go` is too
rare to judge (n≈41); all three **disabled**.

### Phase 4 — the news catalyst
- **`symbol_news`** table + **`news-scan.ts`** (whole-market Benzinga
  feed via a new `fetchNewsFeed()`, every 5 min including pre-market) +
  **`backfill-news.ts`** (one-off per-band-symbol seed, used to backtest
  the catalyst trigger since Alpaca news history is otherwise only
  reachable per-symbol).
- **`catalyst_momentum`** (fast): fresh headline < 2h + RVOL ≥ 3 +
  above VWAP + session up ≥ 3%. `intraday-flip-scan` computes each
  symbol's `news_age_hours` from `symbol_news`.
- Sim verdict: **PF 1.32**, +0.66% avg, 59% win, n=49, exited at 6%
  target / 3% trail / **5% hard stop** (its own `exit_rules` — tight,
  unlike `rvol_breakout`'s wide 12% stop; catalyst reversals are
  violent and immediate). **Enabled** — the one signal with a
  backtested edge, watched live via `fire_outcomes`.

### The swing-hold pivot, and the correction that followed
Asked "what if positions were held up to 15 sessions instead of
flipped fast" — the data initially looked great: an 18-month band-
scoped `sim-flip-exits` run showed the slow triggers at **PF 1.78**,
+3.5% average, pure-hold beating every managed-exit variant. This was
reported as the strongest result of the whole session.

**It was wrong.** While chasing a "let's get 5 years of history" request
immediately after, three separate functions
(`backfill-history`, `backtest-triggers`, `sim-flip-exits`) turned out
to share the same PostgREST ~1,000-row silent cap on their `symbols`
query (see next section) — so every number quoted up to that point,
including the PF 1.78 swing result, was computed on the first ~1,000
(S&P-seeded, large-cap-heavy) symbols, not the actual sub-$5 band, and
on an 18-month sample that happened to be a lucky window.

Re-run correctly (full 5-year history, 4,499/5,001 symbols now backfilled,
proper band-only symbol selection): **combined PF 1.04, +0.31% average,
median −1.6%**, over 18,598 trades. Broken out by year, the "edge" lived
entirely in 2024–mid-2025 (PF 1.23–1.51) and is negative in 2023 (PF
0.91) and 2026 YTD (PF 0.78). `macd_bullish_cross` alone is a net loser
over the full window (PF 0.95); `bb_rsi_confluence_long` alone is barely
positive (PF 1.16) with a negative median — a right-skewed lottery, not
a tradeable edge for a 1–2-position account. This is the number in the
verdict at the top of this file.

### The 1000-row-cap bug family
PostgREST silently caps an unranged `.select()` at ~1,000 rows — no
error, just a truncated result. This bug has now been found and fixed
**five separate times** in this project, each time changing a real
number:
1. `MarketBreadth.tsx` (client-side) — earlier session.
2. `eod-scan.ts`'s `symbols` query — earlier session (at ~1,911 symbols).
3. `backfill-history.ts`'s `symbols` query — this session. Silently
   left ~4,000 of ~5,000 symbols (most of the sub-$5 band) with only
   an ~18-month history instead of 5 years, for months. **Not an IEX
   data limitation** — re-verified directly against Alpaca that SOFI,
   PLUG, NIO, BBAI, KOSS, MARA all have full 2021 daily bars. Fixed with
   pagination + `mapWithConcurrency(4)`; the deep backfill finished in
   ~52 min with 0 failures.
4. `backtest-triggers.ts`'s `symbols` query — this session. Every
   `trigger_stats` number computed before the fix was on the same
   ~1,000-symbol subset.
5. `sim-flip-exits.ts`'s `symbols` query — this session, caught while
   investigating why a 5-year sim run kept exhausting its HTTP/2
   session (GOAWAY) locally — a separate, purely-local issue (Netlify's
   short-lived function invocations aren't affected) worked around with
   a `bandOnly` mode (loads only in-band symbols — correct for
   non-cross-sectional triggers, ~15x lighter) and a retry-with-backoff
   on the bar-fetch loop.

**Lesson for future work in this codebase: any `db.from(...).select(...)`
without an explicit `.range()` loop is a latent silent-truncation bug at
this symbol count.** Grep for bare `.select()` calls on `symbols` or any
other 1,000+ row table before trusting a new script's output.

### The forward-return misalignment bug (2026-09-11)

Found while re-running `backtest-triggers` at full scale after #49
merged. Same shape as the 1000-row family — no error, just quietly wrong
numbers, in the optimistic direction — and it had been corrupting every
`trigger_stats` number ever produced on the current universe.

`backtest-triggers` computes "N trading days later" as `+N` array index
into a symbol's own bar array. **Its own header already documented this
as a known limitation**, safe only for "the continuously-traded
large-cap symbols currently in the universe, worth revisiting if more
thinly-traded names are added." The universe then went from large caps
to ~5,000 sub-$5 micro-caps and nobody revisited it.

- **736 of 4,997 symbols (14.7%)** carry a bar gap >7 days; 193 carry
  one >30 days. A fire on the bar before a delisting gap recorded a
  "3-day return" that was really a multi-year one (AKTS jumps
  2024-12-17 → 2026-01-09; ATTO 2023-07-21 → 2026-08-05). Those gaps
  sit on precisely the halt / delist / reverse-split events with the
  largest dislocations, so the bad returns are both enormous and
  systematically *positive*.
- **89 of the 824 band symbols** have partially-applied split
  adjustment, interleaving two price scales within one series — CETX
  closing at $2,639,700/share, OGEN alternating between ~$3 and ~$213,
  `bb_rsi_confluence_long` recording a single +40,297% three-day return.

What it was worth, at the 3-day horizon:

| trigger | mean (all) | trades >+100% | mean excluding them |
|---|---|---|---|
| `bb_rsi_confluence_long` | +2.416% | 497 / 231,398 (0.21%) | **+0.369%** |
| `macd_bullish_cross` | +0.228% | 333 / 283,856 (0.12%) | **−0.107%** |
| `volatility_squeeze_breakout_long` | +0.152% | 10 / 4,130 (0.24%) | **−0.225%** |

0.21% of trades were supplying 85% of `bb_rsi_confluence_long`'s
apparent edge; the other two flip from positive to outright negative.

Fixed in **#54**: `horizonIsAligned()` requires the exit bar to land
within a plausible calendar window (~1.45 calendar days per trading
day + slack); `hasSplitArtifact()` rejects any ≥10x single-session
close-to-close move as a scale break rather than a price. Rejected
fires are counted onto the response (`skippedGapMisaligned`,
`skippedSplitArtifact`) so the rejection rate stays visible.
`sim-flip-exits` measures its time stop in calendar days so it can't
misalign the horizon the same way, but would still book a fabricated
`take_profit` on a scale break or a `time_stop` filled at a post-halt
price — those walks now abandon as `incomplete`.

**Lesson, and it is the same one twice now: a "known limitation" comment
is a time bomb if the condition that made it acceptable can change.**
This one named its own trigger condition ("if more thinly-traded names
are added"), that condition was met, and the note was never revisited.
Every `trigger_stats` number produced before #54 — including the full
5-year run completed on 2026-09-11 — is affected and needs regenerating.

### The hold-duration sweep (2026-09-11)

The question the earlier phases never directly answered: *is there some
holding period that works?* Swept every duration from 1 day to 6 months
(126 trading days) against the 18,598 `sw5_purehold` signal events,
recomputed in SQL with the #54 guards applied (18,122 clean entries,
824 symbols, 2022-12 → 2026-09, band-scoped).

| bucket | best hold | win rate | mean | **median** | PF |
|---|---|---|---|---|---|
| 1-5 d | 1 d (PF) / 5 d (mean) | 46.9% | +0.183% / +0.315% | −0.13% / −0.58% | **1.099** / 1.075 |
| 6-10 d | 9 d | 45.9% | +0.449% | −1.09% | 1.081 |
| 11-15 d | 12 d | 45.6% | +0.412% | −1.22% | 1.065 |
| 16-30 d | 18 d | 45.5% | +0.521% | −1.55% | 1.070 |

Peak mean across everything under 6 months is **18 trading days**
(+0.521%, PF 1.070, n=17,505). Past 23 days everything turns negative.
Win rate falls monotonically with hold length — 46.9% at 1 day, 43.6%
at 30 days, **38.3% at 6 months** — and median return is negative at
*every* horizon, worsening monotonically from −0.13% to −11.3%.

**Why none of it is tradeable**, in three numbers:

1. **The edge is one percent of trades.** Delete the top 1% and every
   duration goes negative: 1d +0.183% → −0.167%; 3d +0.293% → −0.327%;
   18d +0.521% → −0.685%; 80d +0.512% → −2.393%. The top 1% supplies
   15-18% of all gross profit, the top 5% supplies ~40-45%. With 1-2
   concurrent positions on $40 you are trading the median, and the
   median loses at every horizon.
2. **It is regime-dependent.** At 18 days: PF 0.865 (2023) → 1.505
   (2024) → 1.218 (2025) → **0.844 (2026 YTD)**. Consistent with the
   swing-hold finding above. Short holds are more stable but weaker
   (3-day: 0.96 / 1.18 / 1.04 / 1.14).
3. **Costs exceed the edge.** Median entry price is $2.72, so a *one
   cent* round-trip spread is 0.37% — and these are illiquid sub-$5
   names where 2-5 cent spreads are normal (0.7-1.8%). The best mean
   edge found anywhere from 1 day to 6 months is +0.52%, measured
   close-to-close assuming free fills. **The spread alone is larger
   than the entire signal.**

This independently re-derives the research bundle's "statistically
indistinguishable from random chance" conclusion for penny-stock
price/volume prediction — this time with the mechanism attached, rather
than as a prior nobody had tested. Note also that this weakens the case
for paid Alpaca SIP data: the failure is a negative median and a
cost structure, not a data-resolution problem, so a better feed does
not address it.

### The cost model (2026-09-11) — the decisive result

Until this point **there was no transaction cost model anywhere in the
codebase** (`grep -rn "slippage|spread|commission"` returned one
unrelated volume field). Every backtest, every sim, every number in this
README above this section was gross of costs, filled at the close for
free. Against a best-measured edge of +0.52%, that omission was not a
rounding error — it was the whole answer.

`lib/tradingCosts.ts` takes the wider of two independent estimates:

- **Reg NMS Rule 612 tick floor** — $0.01 minimum increment at/above $1,
  $0.0001 below. A stock cannot trade tighter than one tick, so this is a
  hard lower bound requiring no data at all. At the band's median $2.72
  entry it alone is 0.37% round trip.
- **Corwin-Schultz (2012) high-low estimator** — backs an effective
  spread out of two-day high/low ranges (the high is nearly always a buy
  at the ask, the low a sell at the bid). Needs only daily OHLC, which
  this project has for 5 years, so spreads are estimated *per symbol*
  rather than assumed flat. Computed by `estimate_symbol_spreads()` into
  `symbol_spread_estimates`.

Applied to the cleaned `sw5_purehold` entry set:

| hold | mean gross | cost | **mean net** | **net PF** |
|---|---|---|---|---|
| 1 d | +0.183% | 1.019% | **−0.836%** | **0.657** |
| 5 d | +0.315% | 1.018% | **−0.703%** | **0.852** |
| 18 d | +0.521% | 1.018% | **−0.497%** | **0.938** |
| 30 d | −0.401% | 1.017% | **−1.418%** | **0.866** |

Gross and net are both persisted on `flip_sim` (`pnl_pct_gross`,
`cost_pct`) so a modelled assumption can never silently replace the raw
number.

**Honest limitation, and it is documented on the refresh function too:**
Corwin-Schultz returns ~1.0% almost uniformly across every price bucket
here (sub-$1 through $20+), which is not credible as a spread — %
spread should widen sharply as price and liquidity fall. It is picking
up intraday volatility in a universe that gaps constantly. It is sound
for order of magnitude ("~1%, not ~0.05%"), which is all the decision
needs, but do not treat per-symbol values as precise. Calibrating
against sampled live quotes is outstanding work.

**A price-tier result that inverts an earlier recommendation.** Net PF
by entry price at an 18-day hold runs *backwards* from intuition:
<$1 1.126, $1-2 1.149, $2-3 0.970, $3-4 0.888, $4-5 0.639. The cheapest
names look best, not the most liquid. This contradicts the "move
up-market" suggestion made earlier the same day, so treat that idea as
unsupported until tested properly. It does **not** mean $1-2 works: that
cell was then run through the full discipline and failed all three
checks — mean +1.139% collapses to **−0.096% excluding its top 1%**,
median is −1.543%, and per-year PF runs 1.258 / 2.585 / 1.136 / **0.783
(2026 YTD)**. One exceptional year carrying a lottery.

### The winner-detector test, and what it found instead

The sharpest remaining question was: if the mean is carried by the top
1%, are those identifiable *at entry*? Compared entry-time features
across outcome groups over the cleaned entry set:

| group | n | mean fwd ret | avg RVOL | 20d vol | % of 60d high | avg price |
|---|---|---|---|---|---|---|
| top 1% | 176 | +119.2% | 7.2 | 0.081 | 0.587 | $2.26 |
| top 2-5% | 704 | +49.4% | 9.8 | 0.068 | 0.607 | $2.42 |
| middle | 15,575 | −0.4% | 8.4 | 0.050 | 0.674 | $2.80 |
| **bottom 5%** | 1,050 | **−38.0%** | **86.2** | 0.083 | 0.611 | $2.78 |

Winners sit at RVOL 7.2 — *below* the 8.4 middle — and are only weakly
separable on volatility, distance-from-high and price. **No winner
detector exists in this data.** The strongest feature by far points at
the losers, which is the actionable half: see the 25x volume flag in the
verdict at the top. Per-bucket net PF at 18 days: <2x 0.937, 2-5x 1.001,
5-10x 0.955, 10-25x 1.106, **25x+ 0.489**.

### The measurement rebuild (2026-09-11)

Given the trigger search came back negative six times over, the
conclusion drawn was that *measurement*, not trigger logic, was the weak
part of this project — six silent-corruption bugs, four of which changed
a headline number, two of which were reported as findings before being
caught. `docs/measurement-rebuild-plan.md` scopes five workstreams;
three are built:

1. **Tail-concentration reporting (built).** `finalize_backtest_stats()`
   now also computes `mean_excl_top1pct`, `mean_excl_top5pct` and the
   top 1%/5% share of gross profit, nulled below 100 samples where
   `ntile(100)` stops meaning anything. Reports flags any trigger whose
   `avg_return` and `mean_excl_top1pct` disagree in sign as tail-driven.
   On current data **every enabled long trigger trips it**.
2. **Cost model (built).** Above.
3. **Standing data-integrity checks (built).** `check_data_integrity()`
   does one materialised pass over `bars_daily` — gaps, split scale
   breaks, implausible prices, partial OHLC, stale symbols — and
   `data-integrity-check.ts` (nightly 23:45 UTC) records to
   `data_quality_issues` and alerts **only on regressions**, since ~736
   legitimately gappy symbols is not news but 900 tomorrow is.
   `fetchAllPaginated()` retires the hand-rolled `.range()` loop.
4. **Forward measurement (partial).** `fire_outcomes` extended to
   `ret_20d` + `cost_pct`; all 511 existing rows reopened to backfill.
   `triggers.min_live_sample` (default 30) gates presenting a trigger as
   proven. The Reports panel comparing live outcomes to backtest stats is
   **not built**.
5. **Universe as a config knob (not built).** Note `confluenceGate.ts`'s
   hardcoded fallbacks have drifted from `scan_config` — `price_max: 3` /
   `min_dollar_vol_20d: 150000` in code vs `5.00` / `50000` in the table.
   That is a live inconsistency, not cleanup.

First integrity run, verified end-to-end against prod:

| issue | rows | symbols |
|---|---|---|
| `bar_gap_over_7d` | 3,841 | 736 |
| `bar_gap_over_30d` | 323 | 193 |
| `split_scale_break` | 525 | 195 |
| `implausible_price` | **45,172** | **131** |
| `partial_ohlc` | 0 | 0 |
| `stale_active_symbol` | 5 | 5 |

`implausible_price` is far bigger than expected: SMX carries a
back-adjusted close of **$384bn/share** against a $17.41 last price
across 826 bars — most of those symbols' history, not stray rows. They
are serial reverse-splitters and their current prices ($0.73-$2.61) put
them squarely in the trading band. No legitimate high-priced stock is
caught at the $10k threshold (NVR ~$7.5k, SEB ~$2.4k). `partial_ohlc` at
zero confirms the close-only `eod-scan` bug is genuinely fixed.

Two self-corrections worth recording: a `duplicate_bars` check was
written and then removed because `bars_daily_pkey` is UNIQUE on
`(symbol_id, date)` — it was spending a full GROUP BY to re-confirm a
constraint, and its "0" was a tautology rather than evidence. And the
first version blew PostgREST's statement timeout by scanning
`bars_daily` five times; it is now one materialised pass with a
function-local 600s timeout.

### The local research warehouse (2026-09-11)

**Architecture change.** The worker host is dedicated to this project, so
heavy analytical work moved off Supabase into a local DuckDB store
(`research/`, gitignored, deliberately not backed up because everything
in it rebuilds from Supabase or re-fetches from Alpaca).

Rationale: every timeout hit while building the integrity checks, the
spread estimator and the duration sweep was PostgREST's statement limit
on full scans with window functions — precisely the workload columnar
engines exist for. Measured on the daily bars: **80 MB local vs 668 MB in
Postgres** (8.4x compression), and the windowed integrity scan that
*timed out entirely* over PostgREST runs locally in **0.08 seconds**.

Verified against Supabase on identical data — gaps (3,841 / 736) and
implausible prices (45,172) match exactly. Scale breaks came back 523 vs
525; traced rather than waved off: `MSS` (5.645 → 0.5645) and `BQ`
(3.079 → 0.3079) are exact 1:10 reverse splits that Postgres `numeric`
evaluates as precisely 0.1 while DuckDB `DOUBLE` lands a hair above, so
the `<= 0.1` boundary excludes them. Benign — and a reminder that
equality boundaries on computed ratios are representation-sensitive.

**Two pagination hazards were hit for real building the loader**, both
now documented in it:
1. PostgREST's server-side `max-rows` cannot be lifted by a Range header
   — asking for 50,000 returns 1,000 with a 200 and no warning. This is
   the **sixth** instance of that bug in this project, and it happened
   directly beneath a comment describing it as the most expensive
   recurring bug here. The loader now pages at exactly the cap and
   verifies the total received against the server's own exact count.
2. Deep `OFFSET` pagination is quadratic — `offset 5000000` walks five
   million rows to discard them, so a 5.3M-row table never finishes.
   `bars_daily` is paged *per symbol*, which the `(symbol_id, date)`
   primary key turns into a cheap indexed range scan. Full load: **4
   minutes, 5,373,902 rows**.

`research/session_cohorts.py` is the **session cohort analyzer** — it
inverts the question this project usually asks. `backtest-triggers` asks
"our trigger fired, what happened next", which can only evaluate logic
already written. This asks "a big move happened, what preceded it",
across all ~930k band sessions with no trigger bias:

| cohort (band sessions, cleaned) | n |
|---|---|
| total sessions | 930,065 |
| open→close ≥ +10% | 21,159 |
| ≥ +20% | 4,234 |
| ≥ +50% | 451 |
| ≤ −10% | 12,864 |

Two disciplines are built in rather than left to whoever runs it: strict
no-lookahead (every feature from strictly prior sessions, with the
overnight gap the one deliberate exception since it is genuinely known at
09:30), and lift/precision against base rate on a **time split**. The
+20% cohort is 0.46% of sessions, so tripling the hit rate still leaves
you wrong 98.6% of the time — "cohort differs from average" is not a
finding when scanning a dozen features over 930k rows.

**Phase A (daily precursors) is built but has not been run.** Phase B
(intraday path — *when* in the session the move happened, and whether it
was detectable early) needs the band-only 5-year minute backfill
(`run-intraday-backfill.sh`, ~3.3 GB) and is the part that actually
matters: a +20% open-to-close move identifiable only at 16:00 is
worthless; one identifiable at 10:00 is tradeable.

### Other fixes from this session
- **`jobRun.ts`**: `describeError()` replaces `String(err)`, which
  turned a thrown `PostgrestError` (not an `Error` instance) into the
  useless `"[object Object]"` in `job_runs.error`. This was actively
  hiding the cause of two real `eod-scan` production failures.
- **Root-caused those `eod-scan` failures**: the launchd job (17:45 ET
  / 21:45 UTC) collided with three Netlify prune jobs scheduled the
  same minute; their large `DELETE`s starved the (then-free-tier) DB
  enough that `eod-scan`'s first query got a fast 504 and the whole run
  aborted in ~5s. Prunes moved to 22:20/22:25 UTC.
- **`eod-scan.ts`** was writing close-only `bars_daily` rows (no
  open/high/low) on its recent-bars catch-up — silently, since the
  5-year backfill. Fixed; needed for MFE/MAE math in `fire_outcomes`
  and the sim harnesses.
- Retention widened now that the DB is on Pro: `prune-bars-daily`
  550 days → ~5 years; `prune-bars-intraday` 7 days → 90 days (the
  window the intraday sim / volume profile need).
- Disabled `momentum_rank_entry` / `momentum_breakout` in production —
  negative expectancy at every horizon, on top of the pre-existing
  "unreachable percentile threshold at this symbol count" issue.

### PR state as of this commit
- **#49** — the three `.select()` pagination fixes (`backfill-history`,
  `backtest-triggers`, `sim-flip-exits`) + `bandOnly` mode + GOAWAY
  retries. **Merged 2026-09-11.**
- **#51 / #52 / #53** — `run-backtest-full.sh`, the chunked full-scale
  `backtest-triggers` runner for the mini, plus resumability
  (`START_CHUNK=N`) and a switch from quarterly to monthly chunks.
  **Merged.** Quarterly chunks reliably died at a ~10-minute HTTP/2
  GOAWAY wall (9m52s-9m58s across repeated fresh-process retries — a
  hard local session limit, not flakiness); monthly chunks clear it.
  50 chunks, ~2021-09-10 → 2026-09-10.
- **#54** — the forward-return gap / split-artifact guards.
  **Merged 2026-09-11.** Every `trigger_stats` number predating it is
  optimistically wrong and needs regenerating.
- **#55** — `docs/measurement-rebuild-plan.md`, the five-workstream
  scope. **Merged 2026-09-11.**
- **#56** — tail-concentration columns, the integrity checks
  (`data-integrity-check.ts`), `fetchAllPaginated()`. **Merged
  2026-09-11** (the `data-integrity-check` schedule lands with #57).
- **#57** — the cost model, the 25x volume risk flag, `fire_outcomes` to
  20d, `refresh-spread-estimates`, the `data-integrity-check` schedule,
  and the local DuckDB warehouse (`research/`) + session cohort
  analyzer + backup script. **Open.**
- **#50** — the previous README rewrite. **Merged 2026-09-11.**
- **#58** — this README. **Open.**
- **#32** — an older, now-superseded README handoff PR. Closed.

## The plan forward

Ordered. Steps 1-3 are prerequisites for trusting anything after them.

### 1. Merge and land what exists
Merge **#57** and **#58** (#50, #55 and #56 are already merged), then
on the worker host:

```bash
cd ~/StackSlash && git pull && ./research/setup_worker_host.sh
```

This prints the machine's real disk/RAM/CPU (**needed — every capacity
figure previously quoted was measured on the wrong machine**), builds the
Python env, and loads `bars_daily` + `symbols` into DuckDB (~4 min).

### 2. Verify what was never executed
Three service-role RPCs were written and their SQL validated inline, but
the RPC wrappers themselves have **never been invoked**:

```bash
set -a && . ./.env && set +a && npx tsx -e "import {getSupabaseAdmin} from './netlify/functions/lib/supabaseAdmin.ts'; (async () => { const d=getSupabaseAdmin(); for (const f of ['finalize_backtest_stats','estimate_symbol_spreads']) { const r = await d.rpc(f); console.log(f+':', r.error ? JSON.stringify(r.error) : r.data); } })()"
```

`check_data_integrity()` is already verified end-to-end.
`symbol_spread_estimates` is **empty** until `estimate_symbol_spreads()`
runs — until then every cost-adjusted sim silently falls back to the tick
floor alone.

Then regenerate `trigger_stats` on post-#54 logic:
`./run-backtest-full.sh` (50 monthly chunks, resets on chunk 1). Watch
`skippedGapMisaligned` / `skippedSplitArtifact` — that is the bug's real
footprint.

### 3. Back up before deleting anything
`supabase link --project-ref wnzxvdfskmivbyqadtll` (prompts for the DB
password), then `research/backup_supabase.sh`. **Free tier takes no
backups**, and most of that database cannot be re-fetched:
`fire_outcomes`, `trigger_events`, `dossiers`, `alerts` and
`shadow_positions` are accumulated history. Only bars rebuild from
Alpaca.

### 4. Downgrade Supabase to free tier (~$25/mo saved)
Projected **~416 MB** against the 500 MB cap:

| action | saves |
|---|---|
| `backtest_returns_raw` + `flip_sim` → local only | 274 MB |
| `bars_daily` 5yr → 18mo (full history lives locally) | ~468 MB |
| `bars_intraday` 90d → 14d | ~349 MB |
| `trigger_evaluations` pruned harder | ~200 MB |

**Deleting rows does not shrink the disk** — Postgres marks space
reusable, not free, and Supabase measures actual disk. `VACUUM FULL` (or
a dump/restore) is required to genuinely reclaim it. This is the step
people skip and then conclude the cleanup failed.

Pleasing symmetry: the free-tier cap is exactly what forced `bars_daily`
to 18 months before and caused the swing research to be re-run on a
truncated universe. It is now harmless, because full history lives
locally and research no longer touches Supabase.

### 5. Run the cohort analysis (the actual open research question)
Phase A is built and **has never been run**:

```bash
research/.venv/bin/python research/session_cohorts.py --build
research/.venv/bin/python research/session_cohorts.py --threshold 0.20
```

If daily precursors show nothing above base rate on the time split, Phase
B is unlikely to rescue it and the minute backfill should be skipped. If
they do, run `./run-intraday-backfill.sh` (band-only, 5 years, ~3.3 GB,
chunked monthly) and build Phase B — *when* in the session the move
happened and whether it was detectable early.

### 6. Optional: move the job runner off Netlify
The project is already ~70% off it — `eod-scan`, the worker, every
backfill and sim run on the worker host. The 16 cron jobs would move to
launchd and *gain* by it (no 3-4 min timeout). The one real dependency is
the `deep_dive_webhook` Postgres trigger, which `pg_net` cannot fire at
`localhost`; the clean fix is to have `confluenceGate.stageAndPromote()`
call `deep-dive` directly in-process, removing `pg_net`, the webhook and
the 403 non-Netlify-caller guard together. Keeping Netlify for frontend
hosting costs nothing and preserves external access.

### Standing cautions
- **`sim-intraday-flips` has never been audited for the #54 bug family.**
  It produced `catalyst_momentum`'s PF 1.32 (n=49, one regime) — the only
  signal this project leans on. It walks `bars_intraday`, so its exposure
  is different but analogous. Do this before trusting that number.
- **`confluenceGate.ts`'s fallbacks have drifted from `scan_config`**
  (`price_max: 3` / `150000` vs `5.00` / `50000`). Live inconsistency.
- **The Reports live-vs-backtest panel** (item 4, Phase 8) is unbuilt.
- **Do not add a 36th trigger variant.** The search returned negative
  across ~35 variants, a 5-year multi-regime backtest, a full duration
  sweep, and now a cost model. Adding signal to a rig that has been wrong
  six times is not the constraint.

## Universe & storage

Grown 8 → 512 (S&P 500) → 1,911 (+ NYSE) → ~5,000 (+ NASDAQ + AMEX).
`symbols.exchange` records the listing venue. Alpaca's asset API has no
security-type field, so common-stock-vs-ETF/fund/SPAC/preferred
filtering is a best-effort name-keyword filter — known to leak a small
number of edge cases, accepted rather than paying for a security-master
vendor. **`BRK.A`** returns zero bars from Alpaca's free IEX feed at any
date range (confirmed directly) — not a pipeline bug.

**Storage, post-Pro-upgrade:** the free-plan 500 MB cap forced `bars_daily`
down to a rolling ~18 months and is the reason the swing-strategy
research above had to be re-run once the account upgraded to Pro (8 GB).
Current depth: `bars_daily` 5 years for 4,499/5,001 symbols (the
remainder are recent listings or names IEX has no earlier history for —
genuinely, not from a bug), `bars_intraday` 90 days for the ~380-symbol
band, DB ~1.4 GB total. Plenty of headroom left in the 8 GB plan for
further backfills (e.g. more `bars_intraday` history, or intraday
history for a wider symbol set) if a next phase needs it.

## Trigger disposition (current, as of this commit)

**Every PF in this table predates #54's gap/split guards and is
optimistically biased** — the guards were measured to be worth roughly
+2.0pp of mean return on `bb_rsi_confluence_long` and to flip
`macd_bullish_cross` and `volatility_squeeze_breakout_long` from
positive to negative at the 3-day horizon. Regenerate before relying on
any of them. Two further notes from the 2026-09-11 sweep:
`bb_rsi_confluence_short` and `macd_bearish_cross` fired **zero times**
in 5 years across the whole ~5,000-symbol universe — they are not
"negative expectancy" so much as unreachable, like
`momentum_rank_entry`'s percentile threshold.

| trigger | category | speed | direction | enabled | why |
|---|---|---|---|---|---|
| `bb_rsi_confluence_long` | technical | slow | long | ✅ | PF 1.16 / 5yr band — weak but least-bad |
| `macd_bullish_cross` | breakout | slow | long | ✅ | PF 0.95 / 5yr band — net loser but cheap to leave on for visibility |
| `volatility_squeeze_breakout_long` | breakout | slow | long | ✅ | PF 1.27, tiny sample (n=133) |
| `volatility_squeeze_breakout_short` | breakout | slow | short | ✅ | left on per earlier explicit call |
| `earnings_surprise_drift` | earnings | slow | long | ✅ (inert) | needs a paid estimates feed FMP's free tier doesn't have |
| `realtime_outlier_zscore` | outlier | slow | long | ✅ | tick-level, no backtest possible; live-confirmation-scored only |
| `momentum_exit` | exit | slow | long | ✅ | the swing exit path (rank-drop/weekly-reversal/180d for momentum entries; time+disaster stop for others) |
| **`catalyst_momentum`** | intraday | **fast** | long | ✅ | **PF 1.32/n=49 — the one backtested edge** |
| `rvol_breakout` | intraday | fast | long | ❌ | PF 0.72 once RVOL was correctly calibrated |
| `vwap_reclaim` | intraday | fast | long | ❌ | PF 0.80 — catches falling knives |
| `gap_and_go` | intraday | fast | long | ❌ | n=41, inconclusive |
| `squeeze_release_intraday` | intraday | fast | long | ❌ | not sim-validated yet (needs a daily factor join the sim doesn't wire up) |
| `momentum_rank_entry` | momentum | slow | long | ❌ | negative expectancy at every horizon; also has an unreachable percentile threshold at this symbol count |
| `momentum_breakout` | breakout | slow | long | ❌ | negative/coin-flip expectancy |
| `bb_rsi_confluence_short`, `macd_bearish_cross` | — | slow | short | ❌ | negative expectancy shorting "overbought" in this universe |

`scan_config` (current): `price_min/max` 0.10–5.00, `min_dollar_vol_20d`
50k, `max_rsi14` 85, `min_confluence` 1 (multi-trigger confluence is
near-zero at this price band — see Phase 5 in the plan doc if
redefining this), `account_size` 40, `max_risk_pct` 0.20,
`default_stop_pct` 0.12, `score_horizon_days` 3, `flip_profit_target_pct`
0.06, `flip_trail_pct` 0.03, `flip_time_stop_days` 2, `swing_time_stop_days`
10, `swing_disaster_stop_pct` 0.25.

## Stack

- **Supabase** (`wnzxvdfskmivbyqadtll`, org StackSlash, **Pro plan**) — Postgres, Auth, Realtime
- **Netlify** — static/SSR frontend + Scheduled Functions as the job runner
- **Alpaca Market Data API** — paper keys (IEX feed; no funded account needed)
- **`worker/`** — separate always-on process (Mac mini via `launchd`) holding a live Alpaca websocket for real-time outlier detection; see `worker/README.md`. Not part of the Netlify deploy.

## Repo layout

```
src/                      Frontend (Vite + React + Supabase client)
  pages/                  Login, Dashboard, SymbolDetail, Reports, Settings,
                           Isolator (screener), About
  components/             AuthGuard, RegimeBanner, TriggerFeed (Buy/Sell
                           split, icon-square risk flags), DossierCard,
                           SymbolSearch, SymbolProfile, QuoteTag (+useQuotes),
                           TopMovers, TrackingPanel (session-framed mini
                           charts), FlagIcon, InfoTooltip, ProximityBar,
                           CompanyDescription, PriceChart (shared chart,
                           `compact` sparkline mode for TrackingPanel)
  lib/                    Supabase client, shared TS types, marketTime.ts
                           (ET session-axis helpers), screenFields.ts,
                           triggerEval.ts, triggerProximity.ts,
                           triggerInfo.ts (labels + triggerSide()),
                           factorFormat.ts

netlify/functions/
  eod-scan.ts                  Job A — factor_state, cross-sectional ranking,
                                regime_state, non-technical/non-exit trigger
                                eval, swing shadow_positions open/exit + the
                                shared flip-position opener. launchd on the
                                mini (17:45 ET) — Netlify's timeout can't
                                run it at ~5,000 symbols.
  intraday-scan.ts             Technical-category triggers on the
                                momentum/liquid candidate set. Every 10 min,
                                market hours.
  intraday-bars-scan.ts        1-min bars for the priority set (tracked +
                                today's fires + top-liquid), every 5 min,
                                13:00-23:55 UTC (regular + after-hours).
  intraday-factors-scan.ts     RVOL/VWAP/gap/opening-range for the band into
                                intraday_factor_state. Every 5 min, market hours.
  intraday-flip-scan.ts        Evaluates enabled `fast` triggers against
                                intraday_factor_state + news_age_hours;
                                opens flip positions on promotion. +2min
                                offset from intraday-factors-scan.
  manage-positions.ts          The flip exit engine — hard/target/trail/time
                                stop on open flip positions. Every 5 min,
                                market hours.
  news-scan.ts                 Whole-market Benzinga feed -> symbol_news.
                                Every 5 min, 12:00-20:00 UTC (incl. pre-market).
  record-fire-outcomes.ts      Realized forward-return tracker for every
                                promoted entry. 23:10 UTC weekdays.
  refresh-intraday-volume-profile.ts
                                Nightly EWMA blend of the RVOL denominator;
                                {"rebuild":true} for a full recompute.
  refresh-window-stats.ts      Nightly — factor_window_stats for the Isolator.
  refresh-fundamentals-background.ts
                                Weekly (DoltHub financials/Zacks/earnings).
  confluence-gate.ts            HTTP entry for lib/confluenceGate.ts (used by
                                the realtime worker, which can't import the lib).
  deep-dive.ts                  Job C — scores from trigger_stats (blended
                                across a cluster) + live confirmation, writes
                                a dossier, dispatches the Discord alert.
  onboard-symbol.ts, quotes.ts, news.ts, send-alert.ts, session-bars.ts
                                As before — on-demand onboarding, live quote/
                                news endpoints, manual alert resend, session
                                bars for a not-yet-tracked symbol.

  Backfills / one-offs (POST-triggered, not scheduled):
  backfill-history.ts           Deep bars_daily pull, paginated + concurrent.
  backfill-intraday.ts          ~90-day 1-min history for the band.
  backfill-news.ts              Per-band-symbol news history (sim seed).
  backtest-triggers.ts          Replays every backtestable trigger against
                                bars_daily -> trigger_stats. Chunk by date
                                range at full scale.
  sim-flip-exits.ts             Daily-bar exit-rule backtest -> flip_sim.
                                bandOnly mode, rule-override sweeps.
  sim-intraday-flips.ts         Intraday-checkpoint version of the above,
                                against bars_intraday + symbol_news.

  prune-bars-daily.ts, prune-bars-intraday.ts, prune-trigger-evaluations.ts
                                Scheduled retention (5yr / 90d / short window).

  lib/
    supabaseAdmin.ts             Service-role client
    alpaca.ts                    REST client — bars, snapshots, news
                                  (fetchNews per-symbol, fetchNewsFeed
                                  whole-market paginated), asset lookup
    indicators.ts                 Pure daily-bar math
    intradayFactors.ts             Pure intraday-bar math (RVOL/VWAP/OR/gap)
    dailySnapshot.ts                Shared factor computation (eod-scan +
                                     backtest-triggers)
    triggers.ts                     Declarative trigger evaluator
    cooldown.ts                     filterByCooldown()
    confluenceGate.ts               stageAndPromote()/promotePending() — the
                                     real trigger point (>=min_confluence
                                     same-direction fires -> one trigger_event)
    flipPositions.ts                openFlipPositions() — shared by eod-scan
                                     and intraday-flip-scan
    concurrency.ts                  mapWithConcurrency()
    etTime.ts                       Server-side ET date/time helpers
    riskFlags.ts                    Dossier/alert risk flags + position sizing
    fmp.ts, fundamentalsDolt.ts, dolthub.ts
                                     Fundamentals/earnings enrichment
    backfillSymbol.ts, notify.ts, jobRun.ts (describeError() for real
                                     error messages in job_runs)

worker/                   Separate deployable — persistent Alpaca websocket,
                           EWMA real-time outlier detection. See its own
                           README.
docs/
  logic-revamp-plan.md    The original 8-phase plan this session worked
                           from — phases 5-8 are still unbuilt, see "If you
                           pick this up next" above.
```

## Setup

1. **Install deps**
   ```bash
   npm install
   ```

2. **Environment variables.** Copy `.env.example` to `.env` and fill in:
   - `VITE_SUPABASE_ANON_KEY` — Supabase dashboard > Project Settings > API
   - `SUPABASE_SERVICE_ROLE_KEY` — same page, **never** expose this client-side
   - `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY` — generate **paper** keys at
     https://app.alpaca.markets/paper/dashboard/overview (no funding needed)
   - One of `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` or `DISCORD_WEBHOOK_URL` for alerts
   - `FMP_API_KEY` for fundamentals-sync (optional — profile/earnings enrichment)

   Set the same values in Netlify: Site settings > Environment variables — the
   local `.env` only covers `netlify dev` / `vite dev`. `worker/` has its own
   `.env`, separate from this one (see `worker/README.md`). The Mac mini's
   `.env` (in its own repo clone) is what `eod-scan`, backfills, and sims run
   against when invoked locally there.

3. **Create your login.** Supabase Auth > Users > Add user (email + password).

4. **Run locally**
   ```bash
   npx netlify dev
   ```
   Scheduled functions don't fire in dev and refuse direct external HTTP
   calls even in production (403 for non-Netlify-internal callers) —
   invoke a job directly for testing:
   ```bash
   set -a && . ./.env && set +a
   npx tsx -e "import fn from './netlify/functions/eod-scan.ts'; fn().then(r=>r.text()).then(console.log)"
   ```
   A POST-only one-off (backfill/sim/backtest) needs a `Request` body:
   ```bash
   npx tsx -e "import fn from './netlify/functions/sim-flip-exits.ts'; fn(new Request('http://x',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bandOnly:true})})).then(r=>r.text()).then(console.log)"
   ```
   **Caution:** these run against the real production database (no local/
   staging DB exists) — a trigger left `enabled` will promote real fires
   and send real Discord alerts if you evaluate it against fresh data.
   This bit us once this session (see Phase 2 above); double-check a
   trigger's `enabled` state before test-running a scan function, not
   just a sim/backtest.

5. **Deploy.** Push to `main`; Netlify auto-deploys. `netlify.toml` defines
   the build command, publish dir, SPA redirect, and every scheduled-
   function cron.

6. **The deep-dive webhook is already wired.** A Postgres trigger
   (`deep_dive_webhook` → `public.notify_deep_dive()`, via `pg_net`) fires
   on every `trigger_events` insert and POSTs to the deployed `deep-dive`
   function. Part of migration history, not a manual step.

## What's real vs. placeholder

**Real and functional, end to end:** the whole pipeline from factor
computation through the confluence gate, dossier, and Discord alert;
the exit engine (swing + flip, per-trigger exit rules); the intraday
factor layer; the news catalyst pipeline; `fire_outcomes` live-outcome
tracking; two independent backtest harnesses
(`backtest-triggers` for daily-factor triggers, `sim-flip-exits` /
`sim-intraday-flips` for exit-rule-aware position simulation); the
Isolator screener; DoltHub fundamentals/risk-flags; symbol
search/onboarding; the Tracking panel; Top Movers.

**Known-weak, not placeholder — real but shallow:**
- `deep-dive.ts`'s live confirmation is the same three generic checks
  (trend/volume/regime) for every trigger regardless of category.
- The confluence blend in `deep-dive` is a sample-size-weighted average
  of contributing triggers' individual stats — no backtest of "these
  two co-firing" as its own event exists.
- `screen_symbols` / the Isolator can't yet filter on `fundamentals`
  table columns (runway, dilution, Zacks) — they're joined on the
  dossier but not on the screener.
- Gross margin isn't parsed from the DoltHub income statement.

**Placeholder / genuinely not built:** `earnings_surprise_drift`'s full
SUE (needs a paid estimates feed); Phases 5-8 of the logic-revamp plan
(confluence redefinition by speed, regime hard-gate removal, worker
symbol-selection repoint, a live-vs-backtest Reports panel); the
name-keyword common-stock filter's known small imperfections.

## Backtesting & simulation — three tools, different jobs

- **`backtest-triggers.ts`** — replays a trigger's exact declarative
  `definition` against `bars_daily` day-by-day, records the raw forward
  return at each horizon into `trigger_stats`. Fast, cross-sectional
  (correct for momentum-rank triggers), but has no concept of an exit
  rule — it's "what happens N days later," not "what a managed trade
  would have made."
- **`sim-flip-exits.ts`** / **`sim-intraday-flips.ts`** — actually open
  and manage a simulated position with the real exit rules
  (hard/target/trail/time), intrabar and gap-aware, against `bars_daily`
  or `bars_intraday`+`symbol_news` respectively. This is the harness
  that should be used for any question shaped "what would this trigger
  + this exit rule set have made" — which is almost always the more
  relevant question than raw `backtest-triggers` output. Both write to
  the shared `flip_sim` table (`run_id` distinguishes runs).
- **`fire_outcomes`** — not a backtest at all; the live, forward-looking
  record of what actually happened after real promoted fires. The
  eventual ground truth once enough time has passed.

Re-run `backtest-triggers` whenever a trigger definition or
`dailySnapshot.ts` changes. At the full ~5,000-symbol/5-year scale it
must be chunked by date range (see the function's own header) and run
from the mini, not a laptop, to avoid the local HTTP/2 session-timeout
issue described above.

## Trigger backlog (research-identified, not started)

- **Multi-Timeframe Trend Agreement** — EMA stack aligned daily *and*
  weekly, pullback to the fast EMA. Needs weekly-timeframe EMAs.
- **Candlestick Reversal at a Level** — no new data needed (full OHLC
  already in `bars_daily`), just pattern-detection logic.
- **Estimate-Revision Breakout** — blocked on the same paid-estimates
  gap as `earnings_surprise_drift`.

Given the verdict at the top of this file, building more triggers
without first deciding the strategic direction (screening tool vs.
proven signal generator vs. different data/universe) is probably not
the highest-leverage next step — see "If you pick this up next" above.
