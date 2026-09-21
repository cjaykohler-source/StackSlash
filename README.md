# RIOT — Ranked Intraday Outlier Telemetry (repo: StackSlash Scanner)

The site was rebranded RIOT on 2026-09-14 (logo, tab title, favicon); the
repo, Netlify site name, URL and Discord bot still say StackSlash.

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
  fast) was reported as the one survivor at profit factor **1.32** over
  49 trades. **It does not survive either.** That PF was the best of 8
  exit-rule variants swept the same afternoon (gross PF 0.805-1.397,
  most below 1.0), and it is gross of costs. Charged per trade with
  `tradingCosts.roundTripCostPct()` — the wider of one tick and the
  symbol's Corwin-Schultz estimate, averaging 1.22% on these entries —
  the chosen variant is **net PF 0.779** (mean −0.57%). Every one of the
  8 variants is below 1.0 on that model (best 0.979, n=9). It only clears
  1.0 (PF 1.10) if you assume the tightest spread physically possible, one
  tick. Excluding its single best trade the gross mean is −3.03%. Still
  **enabled** pending a decision; see "Standing cautions".

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

> **New here?** `docs/ACCESS.md` is the access map (accounts, credential
> names, blast radius, handover steps). `docs/HANDOFF.md` is the logistics
> map: machines, repo
> layout, how jobs run, every schedule, data sources, database inventory
> and the current operational state. This file is the strategy, the
> research derivations and the open decisions.

## Current state — handoff (2026-09-18)

Read this, then "The alert pipeline audit (2026-09-16)" below for the
derivations. Everything here was built and verified 2026-09-15 → 09-18;
"Session 2026-09-18" below lists what changed in the last session.

### What the system does now

- **Universe:** $0.10–$5 (`scan_config.price_max` = 5). The band was
  briefly standardised on $0.10–$10 on 2026-09-21 after `scan_config` was
  found to disagree with the docs, then **reverted the same day**: the
  catalyst edge measurably dilutes above $5 (see `docs/research-audit-plan.md`
  §1.3c). Every research result below is at $0.10–$5, which is again the
  live band. **Daily bars are SIP consolidated tape**
  (`fetchDailyBars` feed `sip`; `bars_daily` reloaded 5 years from the local
  warehouse 2026-09-17). Intraday 1-min bars stay IEX (real-time; free SIP
  is 15-min delayed). IEX carried only ~1.7% of band volume (SIP/IEX median
  58.7x), so every pre-09-17 volume number was distorted.
- **Real-time prices are IEX, with a delayed-tape fallback** (2026-09-18).
  IEX sees little of this universe: a thin name can have **no IEX print all
  session**, or one early print and then nothing, while the tape trades. In
  that state an IEX snapshot serves the *previous* session's daily bar (MOB
  showed +0.2% "today" while the tape had it -6%). During a session,
  `quotes` and `session-bars` treat a symbol as stale when its snapshot isn't
  from today **or its last IEX trade is over 20 minutes old**, and fall back
  to SIP bars clamped ~15 minutes back (`fetchDelayedSipToday` /
  `fetchDelayedSipMinutesToday` in `lib/alpaca.ts`). A SIP *snapshot* is
  refused on this plan (403); clamped-end SIP bars are allowed. Tape bars
  are **never** written to `bars_intraday` (the IEX series the factor layer
  reads). No trade on either feed → the last close, marked stale with its
  date. The UI shows three states: live · **15m** (tape) · **Sep 17**
  (last close).
- **Liquidity floors (scan_config, SIP scale):** live monitoring
  `monitor_min_dollar_vol_20d` **$800k/day** (~700 names), alerting
  `min_dollar_vol_20d` **$2.5M/day**. Applied 2026-09-17 16:01 ET and
  verified; the one-shot launchd job is unloaded.
- **Buy / Watch / Sell — one rule everywhere** (feed, symbol page, Discord,
  digest, position tracking):
  - **Watch** = a `watch`-category trigger, or any buy setup whose dossier
    carries a red flag. Blue 👀 WATCH cards, no buy sizing, no exit tracking.
  - **Buy** = buy setups with no red flag. Only these get Exit Warnings.
  - **Sell** = avoid warnings + exit warnings.
- **Red flags mean a negative, never urgency** (`lib/riskFlags.ts`): 25x+
  volume, share offering filed ≤30 days (SEC), nano-cap < $50M, ≤2 quarters
  of cash, shares +50% YoY. News and earnings are always amber.
- **Live intraday (launchd, every 5 min, 09:35–16:00 ET):**
  `intraday-flip-scan` is the live alert engine. It evaluates enabled
  `speed='fast'` triggers on `intraday_factor_state` (per-trigger cooldown),
  ranks by RVOL and caps at `scan_config.intraday_alert_cap` (10) per scan.
  Everything else promotes through `lib/promotionGate.ts`: one
  `trigger_event` per in-band pending fire (the confluence gate is gone).
  - **Heavy Volume Breakout** (`rvol_breakout`, category `watch`)
  - **Avoid: Don't Chase** (`avoid_chase_extended`, first hour by the
    clock: `session_minutes` 15-60, `session_bars` >= 10). First real fires
    09-18 at 09:57 and 10:07 ET.
- **After close:** `eod-scan` (17:45 ET, launchd) evaluates the daily
  triggers, tags every event `delivery=digest` (deep-dive builds the dossier,
  sends no card); `eod-digest` (18:10 ET) posts one ranked card: **Targets**
  (top 15) · **Watch** · **Avoid**. Daily triggers enabled:
  - Buy: **Earnings Release** (`earnings_release`: 8-K item 2.02 filed the
    previous session; 20-session hold, 25% disaster stop) — the only buy
    setup left after 2026-09-17 (see "Disabled 2026-09-17" below)
  - Watch: **Big-Move Watchlist** (`bigmove_watchlist`, added 2026-09-17:
    big-move score >= 3 — see "The trigger redesign" below)
  - Sell/avoid: **Avoid: Volume Blow-off**
    (≥25x), **Avoid: Reverse Split** (ex-date last 4 weeks / next 30 days,
    Alpaca corporate actions; once per 30 days)
- **Exit Warnings** (`manage-positions`, launchd, every 5 min): every Buy
  alert opens a tracked position (`lib/alertPositions.ts`): −12% stop, +10%
  take profit, 5% trail armed at +5%, 10-day limit — **overridden by a
  trigger's own `exit_rules`**. Positions whose entry turns out Watch are
  cancelled.
- **SEC:** `sec-filings-sync` (launchd 07:30 / 17:30 / 22:30 ET) loads EDGAR's daily
  form index into `sec_filings` (offering forms, 8-K with `items` from the
  submissions API for band companies, SC 13D/13G). Requires
  `SEC_USER_AGENT` in the host `.env` (SEC fair-access policy). EDGAR posts
  a session's daily index later in the evening, so the **22:30** run is the
  one that lands that day's filings; the 17:30 run can only see the prior
  day's (the big-move score's 8-K input depends on this).
- **Site — dashboard:** Spotlight chart grid (only `tracked_symbols` with
  `spotlight = true`) · trigger feed (Time · Symbol · Catalyst · Flags ·
  Fired at · Price · Change; Buy / Watch / Sell sections share a fixed
  colgroup so columns line up; a re-fire reads "x2 - 1:57") · sidebar:
  **Tracking** column (nearest the feed, ~295px: add box, rows with a
  spotlight toggle and x, quote-age tag beside the ticker) then Top gainers
  stacked over Top losers.
- **Site — symbol page:** title line with price, change and a **Track /
  Tracking** button. Controls row: ranges (Session · Week · Month · Year ·
  5 Years · Since 2016), the candle-size picker (Session only), and the
  date controls at the right. Chart, then a **volume meter** column (96px,
  523px tall, top level with the metrics column): session volume vs the
  median day of the prior 20 sessions, 0-4x scale widening to 0-8x at 4x,
  pinned past 8x. The volume pane has a dotted **typical-volume-per-candle**
  line (same median; flat on Session, rolling and stepped on longer ranges).
  Right column: price stats, then the factor snapshot in groups (Volume,
  Returns, Rank vs universe, Trend, Oscillators, Volatility, Other).
  Trigger status grouped Buy / Watch / Avoid / Exit (event triggers show
  their last fire). Dossiers with older sessions folded; company description
  from FMP → Wikipedia fallback.
- **Symbol search:** an unknown ticker returns a 404 (no `job_runs` row) and
  suggests a one-edit near-miss the universe already carries, same length
  first (APPL → AAPL, not APP).
- **Data cleanup done:** zero-volume flat placeholder bars (9.7% of rows)
  deleted and filtered on ingest (`isRealSession`); all trigger events /
  alerts / dossiers / fire_outcomes before 2026-09-17 10:35 ET deleted
  (live outcome history restarts).

### Research results this session (net of ~1% round trip, $0.10–$5)

| Study | Result |
|---|---|
| Minute patterns (`schema_lab.py`, 50k tier) | Volume breakout ≈ cost (n 8,049); VWAP reclaim / new HOD same tier; squeeze release **worse** than random; gap-and-go tail-driven; breakdown **better** than random (bounces — not a sell); early extended move **−2.3% vs −1.0% random over 2h** and 7.5x more likely to swing ±10% |
| Big-move score (added to `schema_lab.py`) | Direction-neutral lift vs control; the metric for research-target triggers |
| Daily triggers on clean SIP data (`daily_trigger_study.py`) | Nothing profitable; win rates ≤45%. Excluding red flags + offerings cut 2022+ 20-day losses ~90% (oversold) / ~75% (MACD) but did **not** help in 2016–21 |
| Catalysts (`catalyst_study.py`) | **8-K 2.02 earnings beats a random day in both periods** (no red flags: +4.2% / +0.4% 20d vs random +1.8% / −3.2%). **Reverse split −17% to −22%**, 424B4 priced offering −17% (2022+). 52-week high on volume and 8-K 1.01 did not beat random |

**Caveat:** 2022+ was examined repeatedly this week; treat it as seen, not a
sealed holdout.

### Verify next session (Monday 2026-09-21)

- **Evening SEC sync:** `job_runs` shows `sec-filings-sync` at 22:30 ET on
  09-18, and `sec_filings` has **09-18** filings before Monday's 17:45
  `eod-scan` — then check that `bigmove_watchlist` fires include some with
  the 8-K point (it was permanently 0 before this run existed).
- **Weekend jobs on SIP bars:** `refresh-spread-estimates` (Sun 07:00 UTC)
  and `weekly-bars-scan` (Mon 06:00 UTC) in `job_runs`.
- **Watch never opens a position:** after Monday's `eod-scan`, no open
  `shadow_positions` with `entry_trigger_name = 'bigmove_watchlist'`.
- **Delayed-tape fallback under load:** `quotes` with ~40 tickers during
  the session responds without 429s (it can add one SIP bars call per poll
  for the stale subset).
- **Stale `running` rows:** only `fundamentals-sync` should still leak one
  (it is invoked twice each morning; the second hangs). Anything else
  appearing is new.
- **Don't Chase:** a normal handful of fires, all 09:45-10:30 ET.

### The trigger redesign (2026-09-17, afternoon)

**Big-move watchlist — built and live** (`bigmove_watchlist`, category
`watch`, after close). One point each for: volume >= 3x the prior 20-day
average, a >= 10% close-to-close move, a day range >= 2x the prior 14-day
ATR, and an 8-K filed since the previous session. Fires at **3+**.

`research/bigmove_study.py` (SIP daily + EDGAR acceptance times, $800k
floor, next session vs a random in-band day):

| | 2016-21 | 2022+ |
|---|---|---|
| random in-band day moves >= 10% | 6.7% | 9.3% |
| score >= 3 | **35.4%** (5.3x) | **42.8%** (4.6x) |
| score >= 2 | 27.6% (4.1x) | 34.8% (3.8x) |
| score >= 3, touches +/-20% intraday | 26.5% (7.6x) | 36.4% (7.7x) |

Volatile names move more on any day, so the study also cuts the lift within
estimated-spread tiers: score >= 3 still runs **3.3-9.4x** its tier's base
rate in both periods. Only ~36% of those moves are up and 1/5-day net
returns are negative, so this is **Watch, never Buy** — a next-session
watchlist, not a setup.

**Spread / liquidity tiers.** Dollar-volume tiers barely move next-session
outcomes (10%+ move 5.5-8.7% in 2016-21 across every tier from <$250k to
>=$10M); the floors are a tradability choice, not an edge. The daily
high/low/close spread estimate (Abdi-Ranaldo) is really a volatility proxy:
its top tier (>= 4%) has the highest big-move rates **and** the worst net
returns (-6.4% / -7.5% at 1 day). Nothing here argues for moving the floors.

**Catalyst + volume (live) — tested, do not build.** `schema_lab.py` gained
point-in-time 8-K fields (`mins_since_8k`, `filed_8k_202`) and a
`universe.require_8k` pool filter. Minute-level runs, entry from 09:45,
2016-21 discovery (~12k sessions each), 10%+ move by the close, gross:

| schema | n | >= 10% by close | touches +/-10% | net by close |
|---|---|---|---|---|
| `random_session_0945` (control) | 11,979 | 4.0% | 9.5% | -0.96% |
| `volume_no_catalyst_800k` | 6,100 | **3.4%** | 7.3% | -0.92% |
| `catalyst_8k_baseline` (8-K, no volume rule) | 12,057 | **8.5%** | 19.6% | -1.11% |
| `catalyst_8k_volume` (8-K + volume) | 7,556 | 7.8% | 16.5% | -1.03% |
| `catalyst_8k_volume`, 2022+ holdout | 1,488 | 10.0% | 19.3% | -0.80% |

The 8-K is the whole signal (~2x a random session); the volume conditions
**subtract** and drop ~38% of sessions, and intraday volume alone is *worse*
than a random session. Net returns are ~-1% everywhere: attention, not a
trade. The 8-K already counts toward the after-close score, so the most this
justifies is a Watch note ("8-K filed today") on names already listed.

### Overnight health check (2026-09-18)

First full night on SIP data, and it held: `eod-scan` ok in 198s over 4,974
factor rows, `eod-digest` sent one card (22 lines), `research-update` added
12,538 daily bars and 1.85M minute bars for 09-17, the live engine sent 23
Heavy Volume Breakout alerts with no `alerts.error`, and the floors read
800k / 2.5M (the one-shot job is unloaded). First `bigmove_watchlist` fires:
**6**, alongside earnings_release 1, avoid_reverse_split 11,
avoid_volume_blowoff 5. What it turned up, all now fixed:

- **A watch trigger opened tracked positions.** eod-scan's position step
  filtered on trigger *speed* only, so Big-Move Watchlist opened six shadow
  positions; `manage-positions` would have cancelled them as
  `watch_not_buy` at the next open. Now filtered where the position is
  created, and the six were cancelled by hand.
- **`sec_filings` ran a day behind.** EDGAR publishes a session's daily
  index after 17:30 ET, so the pre-scan run always missed that day's
  filings and the big-move score's 8-K input was permanently 0. A **22:30
  ET** run was added (see the job table).
- **628 stale `running` rows in `job_runs`** were swept to `failed`. Nearly
  all were historical (251 on 09-14, 169 on 09-08, from the Netlify-timeout
  era); the only recurring leak left is `fundamentals-sync`, which is
  invoked twice each morning and leaves the second row hanging.
- Integrity-check regressions were benign: `implausible_price` +1,190 is
  split-adjusted reverse-split history (SXTC at $57M/share) plus BRK.A,
  only 12 rows since 2026-09-01; `stale_active_symbol` 5 → 11 is active
  symbols with no recent bars. The classes that matter improved sharply on
  SIP data: `bar_gap_over_7d` 3,841 → 2,364, gap30 323 → 111,
  `split_scale_break` 541 → **71**.
- **ABAT** (the one earnings_release buy) was correctly cancelled at 09:30
  as `watch_not_buy`: its dossier carries two red flags (~2.0 quarters of
  cash, shares +56% YoY). Buy / Watch / Sell working end to end.

### Session 2026-09-18 — what changed

Ops and data (see "Overnight health check" above for the details):
- `eod-scan` no longer opens positions for watch triggers (Big-Move
  Watchlist had opened six); third `sec-filings-sync` run at 22:30 ET;
  `scan_config.min_confluence` dropped; 628 stale `running` job rows swept.
- Delayed-tape fallback for real-time prices (see "What the system does
  now"), including the stale-single-print case (FBDT: one 313-share IEX
  print at 10:00 ET vs 128 tape bars).
- `onboard-symbol`: validates before opening a job row; 404 + near-miss
  suggestion.

Site (all verified on the live site by measuring the rendered page):
- Track button; Tracking column + Spotlight grid (`tracked_symbols.spotlight`,
  with an authenticated UPDATE policy the table lacked); tracked cards show
  today whenever there is any print today, else a labelled prior session.
- Symbol page: volume meter, typical-volume line, controls-row moves, no
  18 Months, grouped factor snapshot, removed the "SIP consolidated tape…"
  note.
- Feed: aligned columns, compact re-fire note, 19% Time column.

Findings worth keeping:
- **Median, not mean, for volume baselines.** FBDT's 75.9M-share day on
  09-15 was 71% of its 20-day mean and inflated the line ~4x; the median is
  `lib/volumeBaseline.ts` (pure, testable) — `lib/dailyVolume.ts` loads it.
- **Daily volume includes extended hours** (SNAP 09-17: 49.70M daily =
  49.70M across all minute bars vs 45.90M regular-only). The meter sums the
  whole session to compare like with like; the per-candle dotted line on the
  regular-session chart therefore reads a few percent high.
- **A pre-market print is not the open.** FBDT's tape series started at
  04:00 ET; measured from there it looked -6%, from the official open it was
  +0.4%. Daily-bar `o` is the right basis for "% today".

### Session 2026-09-18 (evening) — added

- **New tables, filled from free sources by host jobs** (PR #162):
  `balance_sheet` (SEC XBRL, 4,720 / 5,003 symbols; 274 report no USD
  figures, e.g. TURB in EUR), `short_interest` (FINRA, 12 settlements
  2026-03-13 → 08-31, ~4.9k symbols each), `short_availability` (IBKR
  shortable shares + borrow tier on the free delayed feed, 4,992 / 5,003).
  Not shown on the site yet. launchd plists are in `scripts/launchd/` and
  must be loaded (see "Needs the user" below).
- **onboard-symbol no longer runs eod-scan in-process** (PR #161): the
  ~200 s scan could never finish inside a synchronous Netlify function, so
  every valid onboarding left two `running` rows (SWRD 09-17, TURB 09-18).
  New symbols get factors from the nightly eod-scan.
- **fundamentals-sync moved to launchd** (02:00 / 17:00 ET): Netlify's
  ~30 s cut-off ran it twice per slot, which also doubled its FMP calls —
  the likely reason the free daily quota was already spent on 09-18.
- **IBKR:** gateway is on the **live** login, port 4001, Read-Only API on.
  Real-time still returns 10089 on every exchange although both bundles
  are active, the API acknowledgement is signed and the user is
  Non-Professional — IB-side; re-probe Monday, ticket if still failing.
  IB silently stops sending ticks after ~135 symbols at 90 lines x 4 s;
  45 x 12 s works. Re-tested 2026-09-21 after a weekend and a fresh
  gateway login: still 10089 on all seven test symbols, delayed data and
  borrow fine. **Support ticket submitted 2026-09-21** (manual entitlement
  refresh; also asked whether the bundles are assigned to the account the
  API defaults to, since the username carries two live accounts).
- **Robinhood MCP** works from a Claude session only (float, L2, SEC
  facts, consolidated quotes); host jobs cannot call it. Never trade.
- `research-update` runs fine (log `~/Library/Logs/stackslash-research-update`)
  but writes no `job_runs` row — check its log, not job_runs.

- **Robinhood float snapshot (one-off, 2026-09-18):** `broker_snapshot`
  holds float, shares outstanding, market cap and the exchange
  listing-compliance status for the 374-name alert set plus tracked names
  (HCHL not found). **65 are flagged Noncompliant** (deficiency notice).
  Pulled from a Claude session via the Robinhood MCP (~270k tokens); not
  refreshed automatically. Not shown on the site yet.
- **To evaluate later (user note):** Robinhood options data (chains,
  quotes, IV, open interest; scanner has options-volume filters).

**Needs the user:** load the launchd jobs; decide on the symbol-page
panel (balance sheet + short interest + borrow, amber); IB support ticket
if Monday's probe still fails.

**Add to Monday's verify list:** first scheduled runs of the four new
launchd jobs (one `job_runs` row each, no `running` leftovers); a single
`fundamentals-sync` per slot; FMP `shares-float` / `short-interest` tried
before 02:00 ET's run or right after a quota reset; IB real-time re-probe;
whether TURB / SWRD get a `factor_state` row (SWRD had none after 09-17's
scan: 7 bars of history).

### Audit follow-ups (2026-09-19)

Full DB audit: Supabase 2.4 GB / 8 GB (Pro), every scheduled job's latest
run `ok`, 09-18 data fresh everywhere (SEC 137 filings incl. 113 8-Ks,
bigmove 17 fires, no watch positions opened). The 7-day failure counts are
all pre-09-17 history (Netlify timeouts, an invalid FMP key, the 09-18
sweep). Open items:

1. **Supabase backups are not scheduled.** `research/backup_supabase.sh`
   has produced exactly one file (`~/StackSlashBackups/`, 161 MB,
   2026-09-11). Pro's own daily backups cover it for now, but
   `fire_outcomes` / `trigger_events` / `dossiers` / `alerts` exist
   nowhere else. Needs `supabase link` (DB password) or `DATABASE_URL`
   in `.env`, then a launchd job.
2. **Stale `running` row:** `fundamentals-sync` 2026-09-18 21:00 (the last
   Netlify double-invocation) still needs sweeping to `failed`.
3. ~~**`refresh-fundamentals`:** its plist sits in `~/Library/LaunchAgents`
   (Mon 08:00) but is NOT loaded~~ — **loaded 2026-09-21** and kicked once
   (ok, 4,876 rows, 2m36s). It is wanted next to `fundamentals-sync`:
   they write different tables. `fundamentals-sync` (FMP, daily) writes
   `earnings` and company profiles; `refresh-fundamentals` (DoltHub,
   weekly) is the **only** writer of `fundamentals` — revenue, margins,
   Zacks ranks, runway. Until now it had only ever run by hand (2026-09-09,
   09-18), so new quarters were picked up only when someone remembered.
4. **First pg_cron runs to verify:** `refresh-spread-estimates` (Sun
   07:00 UTC; timed out at 20 min on 09-13, hand-run 09-15) and
   `weekly-bars-scan` (Mon 06:00 UTC; never yet run under pg_cron,
   `bars_weekly` stops at the week of 09-14).
5. **Supabase advisors:** leaked-password protection is off (one Auth
   toggle); `backtest_returns_raw` has RLS with no policy (research table,
   intentionally unreadable from the browser).
6. **`stale_active_symbol` grows because nothing deactivates delisted
   symbols.** The check counts active symbols with no `bars_daily` row in
   10 days; it went 13 -> 15 on 09-19 when GLMD and RAY stopped printing.
   Alpaca reports GLMD, RAY, CYCN and KWM as `inactive` / not tradable
   (delisted), while `symbols.active` is still true. The rest are still
   tradable but long-halted (SVA has 0 bars ever, HCHL none since June,
   SCPQ since 08-28) or a thin share class (BIO.B). **Proposed fix:** a
   reconcile step (weekly, or inside `data-integrity-check`) that sets
   `active = false` when Alpaca's asset record says inactive, so the
   check only reports genuinely stale-but-listed names.

### Open decisions / next steps

- **Short interest — researched, not built.** FINRA's public API
  (`api.finra.org/data/group/otcMarket/name/consolidatedShortInterest`,
  POST, no key; sorting needs `settlementDate` as an EQUAL filter) returned
  the 08-31 settlement for 22,569 symbols, with shares short, prior, %
  change, ADV and days to cover. Published twice a month, ~1-2 weeks after
  settlement. Proposed: a twice-monthly sync into `short_interest`, shown as
  "Short interest X% of shares outstanding · N days to cover · as of <date>",
  **amber** (not a negative on its own). Awaiting the user's go-ahead.
- **Float:** FMP's `shares-float` and `short-interest` returned "Limit
  Reach" on 09-18 (the free daily quota was spent), so it is unknown whether
  they are on the free tier — retry early in a day. Fallback denominator:
  shares outstanding (already in `fundamentals`). Do **not** use FINRA's daily
  Reg SHO short-*volume* files as short interest (~40-50% of all volume
  prints as short on a normal day).
- **Balance sheet:** production `fundamentals` has cash, total debt, book
  equity, shares, burn/runway (in-band coverage: equity 97%, cash 86%,
  runway 60%, **debt 46%**, median row 80 days old). The full XBRL line items
  (total assets/liabilities, current ratio) exist only in the research
  warehouse (`research/data/edgar/edgar_facts.parquet`). Waiting on what the
  user wants it for (a symbol-page panel vs a new flag).
- **Robinhood MCP** is attached but needs the user to authorize it
  (claude.ai connector settings or `/mcp`). Read-only; never call its tools
  without explicit per-action approval.
- `fundamentals-sync` is invoked twice each morning and the second
  invocation leaves a `running` row.
- Two console errors (401, 500) on the dashboard's first load could not be
  traced: no non-2xx in Supabase edge logs, every Netlify function call 200,
  nothing captured by hooking fetch/XHR. Possibly the browser pane itself.
- Meter compares a *partial* live session with a *full* typical day by
  design (it keeps growing); a time-of-day baseline would be a different
  feature.
- Code fallbacks for the dollar-volume floors (50000 / 10000) in several
  functions are still IEX-scale (used only if scan_config is unreadable).
- IBKR on hold (paid bundles not started).

| Job | Runs on | When |
|---|---|---|
| `eod-scan` | launchd | 17:45 ET weekdays |
| `eod-digest` | launchd | 18:10 ET weekdays |
| `data-integrity-check` | launchd | 19:45 ET nightly |
| `research-update` (SIP daily + minute, corporate actions) | launchd | 20:30 ET weekdays |
| `outlier-worker` (IEX websocket) | launchd | always on |
| `intraday-bars-scan` | launchd (`scripts/run-netlify-job.sh`) | every 5 min, 09:00–19:55 ET |
| `intraday-factors-scan` | launchd | every 5 min, 09:00–16:55 ET |
| `intraday-flip-scan` (live alert engine) | launchd | every 5 min (+2), 09:35–16:00 ET |
| `manage-positions` (Exit Warnings) | launchd | every 5 min, 09:30–16:00 ET |
| `record-fire-outcomes` | launchd | 19:10 ET weekdays |
| `sec-filings-sync` | launchd | 07:30, 17:30 and **22:30** ET weekdays |
| `sec-balance-sheet-sync` → `balance_sheet` (SEC XBRL companyfacts, `scripts/sec_balance_sheet_sync.py`) | launchd (`scripts/run-python-job.sh`) | 23:00 ET weekdays (~2 h) |
| `finra-short-interest-sync` → `short_interest` (`scripts/finra_short_interest_sync.py`; skips settlements already loaded) | launchd | 07:15 ET weekdays |
| `ib-short-availability` → `short_availability` (IBKR shortable shares, delayed feed, `worker/src/ibShortAvailability.ts`; needs IB Gateway on :4001) | launchd (`scripts/run-ib-short-availability.sh`) | 09:45 and 15:15 ET weekdays (~25 min) |
| `refresh-window-stats` | Supabase pg_cron | 23:00 UTC weekdays |
| `weekly-bars-scan` | pg_cron | Mon 06:00 UTC |
| `refresh-spread-estimates` | pg_cron | Sun 07:00 UTC |
| `fundamentals-sync` (FMP) | launchd | 02:00 and 17:00 ET daily |
| `news-scan`, prunes, `refresh-intraday-volume-profile` | Netlify scheduled functions | see `netlify.toml` |
| `intraday-scan` | not scheduled (its trigger moved to eod-scan) | — |

Every job writes `job_runs`; check it (status, duplicates, `running` rows
that never finished) before assuming a job works.

## The alert pipeline audit (2026-09-16)

Two symptoms were reported: nothing ever appears under **Sell Signals**, and
every trigger fires once early in the session and then nothing all day.
Both reproduce, and neither is a UI bug.

**Why the Sell column is empty.** The feed's side mapping is correct — all
three short triggers are in `SELL_TRIGGERS` and exits map to sell by
category. The data never produces sell rows:
- Two of the three short triggers (`bb_rsi_confluence_short`,
  `macd_bearish_cross`) are disabled as net losers.
- The survivor, `volatility_squeeze_breakout_short`, fired 29× in three days
  at a **median price of $9.76**. Only 12 were under $5 and only **1** also
  cleared the $50k dollar-volume floor — one promoted event in three days.
- `momentum_exit` events *do* map to sell (9 on 09-15), but they fire on
  shadow positions from the momentum triggers, which are large caps. The
  feed filters every row to the scan_config band on a live quote, so they
  never render.

**Why everything fires once, early.** Three things compound:
1. `intraday-scan` is not intraday. Its only enabled trigger reads
   `bb_pctb` / `rsi2` / `risk_on` from the **previous day's** `factor_state`,
   which cannot change during the session — the evaluation log shows exactly
   **660 fires per hour, every hour**, on the same symbols. `latest_price`
   is the one live input and no enabled condition uses it.
2. `pending_fires` is unique on `(symbol_id, trigger_id, trade_date)` with
   duplicates ignored, so only the day's **first** scan stages anything.
3. That first scan ran at 13:00 UTC = **09:00 ET**, half an hour before the
   open. Every `bb_rsi_confluence_long` pending fire on 09-15 carries the
   timestamp 09:00:45 ET. Fixed 2026-09-16: the guard is now ET-based and
   waits until 09:35, so the first slot is 09:40.

Then `eod-scan` fires the daily triggers in one burst at ~17:48 ET. That was
the whole day: one pre-market batch on stale data, one post-close batch.

**The live intraday pipeline is built and unused.** All five `speed='fast'`
triggers are disabled, so `intraday-flip-scan` returns immediately on every
run (12 runs/hour, `rows_processed` 0, for days) while
`intraday-factors-scan` computes live session factors for ~1,100 symbols
every 5 minutes that nothing consumes. **There is currently no live
breakout detection at all.**

Other structural findings:
- `scan_config.min_confluence = 1`, so the confluence gate promotes every
  lone fire while the UI still shows "N signals" cluster badges. What
  actually filters is the price/volume band: `macd_bullish_cross` had 556
  fires, 25 in band, 26 promoted. **Open decision.**
- `intraday-flip-scan` hard-codes `direction: "long"`, and
  `openFlipPositions` is long-only in both its filter and its stop math
  (`entry × (1 − stop)`, `high_water`). Making the fast path short-capable
  needs short stop math, low-water tracking and `manage-positions` changes —
  not attempted, and borrow availability is the real constraint on shorting
  sub-$5 names anyway.
- `realtime_outlier_zscore`: 56 fires in three days, **0** promoted — every
  one a mega-cap (min $11.29, median $271). The worker's ~30 websocket slots
  are spent outside the band.
- `earnings_surprise_drift`: 22 fires, none ever in band (cheapest $5.83).
  **Disabled 2026-09-16** as non-functional for a sub-$5 scanner.

**Live outcomes of what stayed enabled** (`fire_outcomes`, avg 5-day, net
figures in the cost model): `macd_bullish_cross` −2.02% over 248 fires (31%
win), `bb_rsi_confluence_long` −1.68% over 212 (37%), and
`volatility_squeeze_breakout_long` −1.38% over 9. Every one has a positive
backtested mean that goes negative once the top 1% is removed.

### Minute-level breakout tests — all four fail

The five intraday triggers had **no** `trigger_stats` at all: they were
never testable, because `backtest-triggers` only replays daily factors.
`schema_lab.py` settles them on the minute data. Four minute-level
equivalents, net of a 1% round trip, against a random-minute control
(`research/schemas/intraday_*.json`):

| schema | tier | matches | 15 min | to close | control | promising |
|---|---|---|---|---|---|---|
| `intraday_rvol_breakout` | 50k | **8,049** | −0.89% | −0.87% | −0.99% | no |
| `intraday_rvol_breakout_tight` | 50k | 366 | −1.22% | −0.54% | −0.99% | no |
| `intraday_squeeze_release` | 50k | 741 | −1.02% | −1.24% | −1.01% | no |
| `intraday_gap_and_go` | 50k | 186 | −0.98% | −1.22% | −1.00% | no |

- **`rvol_breakout` is settled beyond argument.** 8,049 matches, a 15-minute
  interval of [−0.93%, −0.85%], and a **median of exactly −1.00%** — the
  cost. Gross return is ~zero: you pay the spread and get nothing. Win rate
  15.9%; all six years negative.
- **Selectivity makes it worse, not better.** The tight variant (2× a day's
  volume already traded, 5× minute spike, pinned at the high) cut matches
  from 16.1% to 0.73% of sessions and *lowered* the 15-minute mean to
  −1.22%. Consistent with the project's finding that the extreme-volume
  tail is where the disasters live.
- **`squeeze_release` is worse than random** — −1.43% at 2 hours against a
  −1.01% control, whole interval below it.
- **`gap_and_go`** is tail-driven: mean near the cost, median −3.8% to the
  close.

Practical read: these are usable as a **live screen** ("this sub-$5 name is
breaking out right now"), not as trade signals. The 2022+ holdout is
untouched and not worth spending on these.

**Operational constraint found:** `schema_lab` takes an exclusive lock on
`research/data/schema_runs.duckdb`, so **only one run at a time** on this
host — a second run dies at startup with a DuckDB lock error. (Separate
from the warehouse conflict with the 20:30 ET `research-update`.)

### Zero-volume placeholder bars — the real corruption source (2026-09-16)

Chased down from a `#heating_up` ops alert ("split_scale_break: 539 → 541
rows"). The diagnosis moved three times; the end of the chain is the
useful part.

**What Alpaca's IEX feed actually serves.** For a symbol that didn't trade
on IEX in a session, the daily-bars endpoint returns a **flat placeholder
bar** — `open = high = low = close`, `volume = 0` — and on a thin name that
price can be **stale by a whole reverse-split factor**. HUBC (trades
~100 shares/day on IEX) on 2026-09-14 and 09-15: OHLC all `0.3439`, volume
`0`, sitting between a `$8.598` close and a `$6.06` close.

Measured over a 120-day window of `bars_daily`:
- **39,169 zero-volume rows across 1,470 symbols — 9.7% of all bars.**
- **Every one is perfectly flat** (open = high = low = close).
- **51 of the 57** `split_scale_break` rows in that window touch one.

These are not sessions. They corrupt returns, RVOL denominators, moving
averages, Bollinger inputs and MFE/MAE, and they are what the split and
implausible-price checks keep tripping over.

**Fixed on ingest:** `isRealSession()` in `lib/backfillSymbol.ts`, applied
in both write paths (`backfillSymbolBars` and `eod-scan`'s recent-bar
fetch). Deliberately conservative — a bar is dropped only when it is BOTH
zero-volume AND perfectly flat, which covers every observed case.

**Still to do (destructive, for the user to run):** the existing rows are
untouched. To clear them:

```sql
delete from bars_daily
where volume = 0 and open = high and high = low and low = close;
```

Then re-run `eod-scan` so `factor_state` recomputes on clean bars.

**A repair pass that mostly did not work, recorded so it isn't retried
blindly.** Before the above was understood, the 19 symbols with a scale
break in the last 40 days were re-pulled through `backfill-history`
(19,103 rows, 0 failures, 1.6 s). Result: **7 symbols genuinely fixed**
(MPU, CPOP, NFE, NXXT, OPTT, GAUZ, GOSS — those really were mixed scales
in our storage), **12 unchanged** (HUBC, IPDN, NRSN, CTSO, MGN, TANH, NXL,
CHGA, GRNQ, CURX, PLAG, SION). The 12 are unchanged because a single
consistent re-fetch reproduces the break exactly — the vendor serves it.
Headline counts barely moved: `split_scale_break` 541 → **538**, and
`implausible_price` rose 45,172 → **45,238**, because re-pulling restored
more back-adjusted history (HUBC's max stored close is **$102,375,000**).

**Corrected diagnosis:** the earlier theory — that `eod-scan`'s 12-day
re-fetch window interleaves scales with older rows — is **wrong** for this
class, and the re-pull is what disproved it. Re-pulling cannot fix a bar
the feed itself reports.

**Alert failures are now diagnosable.** `alerts.error` column added
(migration `alerts_error_column`) and `dispatchAlert` records
`describeError(err)` on failure. Needed because 8 alerts failed on
2026-09-16 at 09:41 ET — instantly, so a rejected request rather than a
429 or a network blip — and the cause could not be recovered afterwards.
The next failure will say why.

## Open items (to-do)

Keep this list current: add anything left outstanding, strike it when done.

**Needs a decision or hands-on action**
- [x] **Stale `trigger_stats` cleanup** done 2026-09-12: 21 rows older than
  the full regeneration's start (`2026-09-12 02:30:05+00`) deleted, all
  from the four disabled triggers plus the 0-sample
  `earnings_surprise_drift`.
- [x] **Local branch `readme-session-handoff`** (one 2026-09-09 handoff-doc
  commit, superseded): archived to `origin/readme-session-handoff` and
  deleted locally, 2026-09-15.
- [ ] **`catalyst_momentum` is disabled, definition kept** (net PF 0.779 on
  the cost model). Re-enable only on new evidence.
- [ ] **Free-tier downgrade** ("The plan forward" step 4) not started. Still
  Pro; research no longer depends on Supabase, so it's purely a cost call.
- [x] ~~Check `#heating_up` for the 2026-09-11 triple integrity run~~ —
  moot; the integrity check now runs once a night on launchd (verified
  2026-09-12/13/14: one `job_runs` row each).
- [ ] **IBKR (user's account)**: IB Gateway on the paper login, read-only
  API, port 4002, localhost only, verified connecting 2026-09-14 via
  `@stoqey/ib` (Node; Python here is 3.9, too old for `ib_async`). Real-time
  quotes and scanners need the paid US Securities Snapshot + US Equity &
  Options Add-On Streaming bundles (subscribed, then not activated
  2026-09-14, error 10089; user is holding off on paying). **Works free:**
  delayed quotes and short availability (shortable shares + borrow
  difficulty, confirmed on SOFI). Option: a daily short-availability
  logger for band names. Gateway is currently not running.
- [ ] **Paid-product caveat**: market data (Alpaca, IBKR) is licensed for
  personal use. Showing prices/charts to paying users, or charging for the
  Discord channel with prices in alerts, needs a redistribution license
  (CTA/UTP) or a vendor that includes one. Get a securities lawyer's view
  before selling anything (publisher's exclusion, no trading around alerts).
- [ ] `src/assets/RiotLogo.png` (the first RIOT logo) is untracked, and
  `SS_SingleLine_Logo.png` is now unused: keep or delete.

**Verify on first scheduled run**
- [x] `fundamentals-sync`: the rotated FMP key works — 2026-09-15 21:00 UTC
  run `ok`, 71 rows (the 06:00 UTC run still 401'd; it preceded the
  rotation).
- [x] pg_cron `refresh-window-stats`: first run 2026-09-15 23:00 UTC `ok`,
  179,892 rows, no timeout (the last three Netlify attempts had all died at
  the API role's 8 s limit).
- [x] `prune-bars-daily` via `prune_bars_history`: 2026-09-15 22:25 UTC
  `ok`, one row, no 57014.
- [x] `research-update`: first scheduled run 2026-09-15 20:30 ET completed
  20:35 ET (377 minute units, 1.85M bars).
- [x] `launchd` `com.stackslash.data-integrity-check`: one `job_runs` row
  per night, verified.
- [x] `record-fire-outcomes` on launchd: 2026-09-15 19:10 ET `ok`, one row.
- [ ] Still pending by schedule: `weekly-bars-scan` (Mon 09-21 06:00 UTC)
  and `refresh-spread-estimates` (Sun 09-20 07:00 UTC; the 09-13 run died
  at a 2-min timeout, so estimates are from 2026-09-11 — a manual
  `run_refresh_spread_estimates_job()` on 09-15 refreshed 4,830 symbols).
- [x] Discord alerts: the 429 retry works — 24 of 25 sent in the
  2026-09-15 17:48 ET burst, several after waiting out a 429. The one
  failure (CYPH) was a *network-level* throw, which `sendDiscord` never
  caught; fixed 2026-09-16 by retrying those too. The embed was ruled out
  by rebuilding it locally (396 chars, valid).
- [x] `refresh-intraday-volume-profile` hit the 8 s API timeout on
  2026-09-15 and only survived Netlify's retry; the function now sets its
  own 600 s `statement_timeout` (migration
  `refresh_intraday_volume_profile_own_timeout`).

**Jobs / infrastructure**
- [x] **Netlify ran long scheduled functions 2-3×** (`intraday-bars-scan`
  30-60 s, `intraday-factors-scan` ~30 s, `record-fire-outcomes` ~45 s, all
  over the ~30 s limit; 2-3 `job_runs` rows per slot plus orphaned
  `running` rows). Moved to launchd on 2026-09-15: one generic runner,
  `scripts/run-netlify-job.sh JOB [START END]` (ET weekday window gate),
  and a plist per job in `scripts/launchd/`, fired on minutes 0,5,…55 so
  `intraday-flip-scan` (+2 min, still Netlify) reads fresh factors.
  `intraday-factors-scan`'s market-hours check is now ET (the UTC one cut
  the last session hour in winter). Verify: one `job_runs` row per slot.

**Measurement / data**
- [ ] **Production bars are IEX-only** (`feed: "iex"` in `lib/alpaca.ts`).
  Quantify against the SIP research tables, then decide on moving
  `bars_daily` to SIP. Every volume, RVOL, dollar-volume floor and the 25x
  flag is computed from IEX's slice of the tape.
- [ ] **Survivorship**: the production universe is today's listings only;
  the SIP research tables include delisted names. Backtests should move to
  that universe. **When they do, refresh the "Trigger disposition" table
  again** (it holds the 2026-09-12 IEX/production-universe regeneration).
- [ ] **Ticker reuse** (e.g. BBBY) splices two companies into one SIP
  series; needs detection before research relies on per-symbol history.
- [ ] **Spread model**: Corwin-Schultz is near-flat across price; calibrate
  against real quotes.
- [ ] **`sim-intraday-flips`**: five audited defects, none fixed (see
  "Standing cautions").
- [x] `load_from_supabase.py` now stores `date` as a real DATE (2026-09-15;
  takes effect on the next load).
- [x] `confluenceGate.ts` fallbacks realigned with `scan_config`
  (0.10-5.00, $50k) 2026-09-15.
- [ ] Reports live-vs-backtest panel is unbuilt.
- [ ] **Next free data pulls, if wanted** (all free, small): FINRA daily
  short-sale volume and bi-monthly short interest, Nasdaq trading halts /
  LULD history, and parsing Form 4 insider trades + 8-K item 2.02 earnings
  dates from the EDGAR filings already loaded. Tick-level SIP trades are
  feasible only for band sessions (~11.5B trades, ~4-6 days, ~140 GB) or on
  demand; the full tape is ~161B trades, ~2 months at the free rate and
  ~2 TB (one paid Alpaca month at 10k req/min would cut it to about a week).

**Research pipeline (in progress)**
- [x] **Full SIP minute-bar pull done 2026-09-14** (`research/load_minute_bars.py`):
  all 740,459 units, ~3.4B raw 1-minute bars (04:00-20:00 ET), every
  symbol with SIP daily bars since 2016, delisted included, 0 rejected
  symbols; ~80 GB in `research/data/minute/year=/month=/`. It ran as
  launchd agent `com.stackslash.minute-pull`, now unloaded (the plist
  stays in `scripts/launchd/` for a future bulk re-pull).
  **Kept current nightly** by `com.stackslash.research-update` (weekdays
  20:30 ET, `scripts/run-research-update.sh`, log in
  `~/Library/Logs/stackslash-research-update/`): the current quarter of
  corporate actions, then `load_from_alpaca.py --update` (new sessions,
  both adjustments, plus a full split-adjusted re-pull for any symbol that
  split), then `load_minute_bars.py --update` (one set of `dYYYYMMDD-*`
  units per new session). Every step is idempotent, so a missed night is
  caught up by the next run. It also self-heals the universe: any symbol
  first seen in the last 10 days gets its full daily history re-pulled
  once (`sip_backfill_log`), and `load_minute_bars.py --update` plans gap
  units for any symbol-session that has a daily bar but no minute unit.
  The first run found 9 such symbols (OPTT, IPDN, ATTO, NFE, CPOP, NXXT,
  NRSN, HUBC, BURU) with years of history the 2026-09-11 bulk load missed
  because they weren't in Alpaca's asset list that day; the bulk universe
  may have more like them that never trade again. It writes the DuckDB warehouse, so a
  `schema_lab.py` run holding it at 20:30 makes that night's run fail;
  the next night catches up.
  `MARKET_HOURS_RATE` is still 190 (the user chose data over the site for
  the final day); set it back to 60 before any future market-hours pull.
  **Reconcile** (`--reconcile`, table `minute_reconciliation` in
  `minute_log.duckdb`), 21.8M symbol-sessions:
  - 9.8M "complete" (minute volume within 2% of daily), 10.7M "partial",
    1.3M "missing". Median minute/daily volume 0.978 (p5 0.77, p95 1.00).
  - **"Missing" is not lost data.** 99.99% are sessions with ≤100 trades
    (58% of ≤10-trade sessions); spot-checked against the API, these
    sessions' trades are all odd lots (condition `I`) or non-bar prints
    (`M`, `9`, `Q`), which count toward daily volume but never form a
    minute bar. Re-requesting returns 0 bars. E.g. WEED 2023-06-08:
    2,361 trades, 2,829 shares, all odd lots.
  - **"Partial" is mostly odd-lot volume too**: daily volume includes odd
    lots, minute bars don't. The gap grows every year (median ratio 0.989
    in 2016 → 0.963 in 2026) as odd-lot share of volume rose. Treat
    minute volume as round-lot volume, not total volume.
  - Prices: daily high and low match the minute bars within 0.1% on
    89-91% of sessions, and both within 0.5% on 88%.
  - Band sessions (close $0.10-$5): 5.8% missing, 33.7% partial, median
    volume ratio 0.989.
- [x] **Corporate actions** (`research/load_corporate_actions.py`):
  Alpaca splits/reverse splits, name changes, mergers, spin-offs,
  worthless removals and dividends since 2016, one Parquet per quarter in
  `research/data/corporate_actions/`: 379,635 actions, 2016Q1-2026Q3.
  Coverage varies by type: reverse splits are present every year
  (162-221/yr in 2016-2019, 800+/yr by 2025-2026); name changes are
  near-absent before 2019 (4 in 2016-2018, 53 in 2019, hundreds a year
  after), so old -> new CUSIP pairs are the better ticker-reuse signal
  for earlier years; worthless removals only start in 2023. One record
  is dated year 3026 (vendor typo), so date-filtered research should
  drop it.
- [x] **SEC EDGAR** (`research/load_edgar.py`, from sec.gov's
  `companyfacts.zip` and `submissions.zip`): `edgar_companies` (21,296),
  `edgar_tickers` (10,272), `edgar_filings` (13.6M) and `edgar_facts`
  (7.7M: shares outstanding, public float, cash, net income, revenue,
  equity, operating cash flow) in `research/data/edgar/`. Join facts on
  `filed`, never period `end`, to stay point-in-time. For dilution use
  S-1/S-3/424B4/424B5; 424B2 is mostly bank structured notes. To do:
  link the 13,294 no-ticker (delisted/renamed) companies to delisted SIP
  symbols via CUSIP or former names.
- [x] **Schema tester built: `research/schema_lab.py`.** A pattern is a
  JSON file of conditions over 59 point-in-time fields
  (`--list-fields`); see `research/schemas/example_gap_vwap.json`. Run it
  on seeded samples in tiers of **2,500 / 50,000 / 250,000 / 1,000,000 /
  `year:YYYY` / `all`**:
  `research/.venv/bin/python research/schema_lab.py run SCHEMA --tier 2500 --seed 7`.
  Tiers are disjoint by exclusion (a lineage never re-scores a session),
  entries fill at the next bar's open, every run is scored against a
  random-minute control net of costs with 90% bootstrap intervals, and
  runs are retained and resumable (`runs`, `report RUN_ID`, `--resume`).
  2016-2021 is for iteration; the 2022+ holdout needs `--holdout` and is
  one-shot per schema version. Tiers draw from sessions whose minute data
  is on disk, which since 2026-09-14 is all of 2016 → today. Only one run
  can hold `schema_runs.duckdb` at a time (see the audit section above).
  **First schemas run at scale 2026-09-15/16, all negative:** four
  breakout patterns (see "Minute-level breakout tests") plus
  `early_move_continuation` — a band name already up ≥10% by 09:45-10:30,
  above VWAP, at its high, on real volume. At 50k (513 matches) it does not
  continue: −1.8% at 60 min against a −1.0% control, 31% win rate, and the
  apparent next-day +2.7% is pure tail (median −5.0%, −3.2% excluding the
  top 1%). The 2,500-tier read had shown a −9% fade to the close; at scale
  that shrank to −1.6% and overlaps the control, so the fade is not
  tradeable either — a short would clear ~+0.3% before borrow.
- [x] **Session snapshot charts built** (#65-#67): symbol page → **Session
  (candles)**. SIP 1-minute bars for any date since 2016 via the
  on-demand `session-candles` function, drawn as regular-session candles
  (9:30a-4:00p) with bottom-aligned volume, VWAP and the prior close, a
  crosshair tooltip, prev/next session and a date picker. Interval
  dropdown 1/2/5/10/15m; **Auto** picks the finest interval where ≥75% of
  slots traded and the session fits in ≤200 candles (liquid names → 2m,
  thin names → 15m). Verified in the browser on SOFI and AENT.
- [x] Symbol page layout (#70, #78-#80): opens on Session (candles);
  price trails the ticker/name on one line; full-width description
  clamped to 4 lines with See more; range buttons + session picker on one
  row above the chart; candle pane 523px, volume unchanged.
- [x] **Every symbol-page range is candles now, from SIP** (#82): Session
  (1-min, raw), Week (30-min, regular hours), Month/Year (daily),
  18 Months/5 Years (weekly), Since 2016 (monthly), all split-adjusted
  via the on-demand `range-candles` function; Auto price scale goes log
  when the range spans 8x+. The old Day line chart and the IEX
  `bars_daily` line charts are gone from the page.
- [ ] The symbol page only opens tickers in the `symbols` table; the
  `session-candles` function works for any Alpaca ticker, including
  delisted research-universe names, if the page should browse those.
- [ ] **Evaluate later: buy vs sell volume.** Bars carry only total
  volume (the chart's green/red volume just follows candle direction).
  A buy/sell split can be estimated from Alpaca SIP trades (free for
  data older than 15 min): tick rule from trades alone (~75-80% accurate
  per trade, better in aggregate), or Lee-Ready using NBBO quotes (more
  accurate, but quote data is often 5-20x the trade data). Feasible on
  demand per chart session (BTE ~16.6k trades = 2 requests, SOFI ~100k =
  ~10): stacked buy/sell volume bars, a buy/sell ratio in the stats row,
  cached like finished candle sessions. Not feasible in bulk across all
  history on the free rate limit; only for sessions a schema flags.
- [x] Removed the `~/StackSlash-reset` worktree and `batch-backtest-reset`
  branch.

## Infrastructure, as deployed right now

| Piece | Where | Status |
|---|---|---|
| Frontend + functions | Netlify, site `stackslash` → https://stackslash.netlify.app | Live, auto-deploys from GitHub `main` |
| Repo | https://github.com/cjaykohler-source/StackSlash | `main` |
| Database | Supabase project `wnzxvdfskmivbyqadtll` (org StackSlash) | **Pro plan** (8 GB, upgraded 2026-09-10 — was free/500MB) |
| Market data | Alpaca, **paper** keys, free plan: IEX real-time (production scans, quotes, worker) + SIP history older than 15 min (charts, research); 200 req/min shared | No funded account needed for data-only use |
| Market data (optional) | IBKR via IB Gateway on the worker host, paper login, read-only API :4002 | Connects; real-time needs paid bundles (not active). Not running |
| Scheduled DB jobs | Supabase `pg_cron` (`refresh-window-stats`, `weekly-bars-scan`, `refresh-spread-estimates`) | Moved there 2026-09-15 |
| Alerts | Discord webhook, channel `#heating_up` (bot "HeatBot"), embed cards | Working |
| Auth | Single Supabase Auth user, `cjaykohler@gmail.com` | Working |
| Mac mini (`stackslash-worker-host`, user `ckohler`, repo `~/StackSlash`) | Always-on, `launchd`, **dedicated to this project** | Runs `worker/` (realtime outlier websocket), `eod-scan` (17:45 ET), `data-integrity-check` (19:45 ET), `research-update` (20:30 ET), all backfills/sims/backtests, and the local research warehouse (~80 GB, `research/data/`) |

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

Supabase snapshot (as of 2026-09-10): **~5,000 active symbols**, `bars_daily` holds
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
   `data-integrity-check.ts` (nightly, 19:45 America/New_York, via launchd
   on the worker host — see `scripts/launchd/`) records to
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

### PR state
**Everything through #97 is merged (2026-09-15); no PRs are open.** The
list below is the 2026-09-11 snapshot, kept for its notes; #57 and #58
have since merged too. #59-#97 (backtest regeneration, SIP/minute/EDGAR
loaders, schema lab, candle charts, RIOT rebrand, About page, nightly
research update, Discord cards, job-timeout fixes) are in `git log`.

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
**Done 2026-09-11/12** (#57, #58 merged; worker host set up). Kept for
reference: on the worker host,

```bash
cd ~/StackSlash && git pull && ./research/setup_worker_host.sh
```

This prints the machine's real disk/RAM/CPU (**needed — every capacity
figure previously quoted was measured on the wrong machine**), builds the
Python env, and loads `bars_daily` + `symbols` into DuckDB (~4 min).

### 2. Verify what was never executed
**Done 2026-09-11.** `estimate_symbol_spreads()` populated
`symbol_spread_estimates` (4,830 symbols). `finalize_backtest_stats()`
runs after every `backtest-triggers` chunk, and now also stamps
`computed_at`, so a row it didn't refresh is visibly stale.
`check_data_integrity()` was already verified end-to-end.

The spread estimator **cannot be called over HTTP**: it outlasts
Supabase's ~125s API gateway, which returns `upstream request timeout`
while the query keeps running and commits anyway. It therefore runs
inside Postgres as a **`pg_cron` job** (`refresh-spread-estimates`,
Sundays 07:00 UTC) through `public.run_refresh_spread_estimates_job()`,
which records itself in `job_runs` like every other job. To refresh by
hand, run this in the Supabase SQL editor rather than via `.rpc()`:

```sql
select public.run_refresh_spread_estimates_job();
```

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

**Result (2026-09-11): Phase A ran, and the answer is no — skip the
minute backfill.** 249,042 band sessions (2021-09-15 → 2026-09-11) after
the `scan_config` liquidity floor and split-break exclusion; train before
2025-06-01, test after, cutoffs fitted on train only. Several features
*do* hold their lift out of sample — top-decile 20-day volatility is
4.56x the +20% base rate on test (2.43% precision) — but the same deciles
light up for **≤ −10%** sessions just as strongly (3.63x). They detect
*that* a name will move, not *which way*. On the test period, every
lit-up bucket has gross PF 0.997-1.085, a negative median, a negative
mean once the top 1% of sessions is removed, and PF 0.69-0.79 net of a
1% round trip. Combining the two strongest (top-decile volatility and
gap) gives 5.3% of sessions at ≥ +20% but 14.0% at ≤ −10%, PF 0.997.

Phase B asked a different question daily bars can't settle — whether a
move already under way at 10:00 continues — but nothing knowable at the
open points in a direction, which was the premise for expecting it would.

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
- **`sim-intraday-flips` was audited 2026-09-11 and is not fixed.** It
  produced `catalyst_momentum`'s PF 1.32, which is net PF 0.791 once
  costs are charged (see the verdict). Open defects, none yet corrected:
  - **No cost model** — #57 wired `tradingCosts` into `sim-flip-exits`
    only. Every `isim_*` `flip_sim` row is gross.
  - **Lookahead in the RVOL denominator.** `perMinuteMean()` averages
    every *other* session of the 90-day window, including sessions after
    the one being simulated, so a checkpoint's RVOL knows future volume.
  - **No gap / split guard on the daily roll.** After the entry session
    it walks `bars_daily` by index, so a halt fills a `time_stop` (or a
    stop) at a post-halt price — the exact #54 failure `sim-flip-exits`
    now abandons as `incomplete`.
  - **Mixed price bases.** Entry is a `bars_intraday` price; exits are
    `bars_daily` OHLC. Both come from Alpaca with `adjustment: "split"`
    *as of fetch time*, and rows are never re-fetched, so a split inside
    the window leaves the two series on different scales.
  - **Latent 1000-row cap**: the band query ends in `.limit(1000)`. The
    band is ~824 names today, so it is not truncating yet.
- ~~`confluenceGate.ts`'s fallbacks have drifted from `scan_config`~~ —
  realigned 2026-09-15.
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

**Numbers for the four backtested triggers are from the full post-#54
regeneration (2026-09-12)**: 60 monthly chunks, 3,012,128 fires. They are
gross (no spread/cost), on production's IEX-only `bars_daily` over the
survivor-only production universe, so they are still optimistic. Re-run
on the SIP survivorship-free universe before acting on them (to-do).

| trigger | n (3d) | gross PF 1d / 3d / 5d / 20d | mean 3d | median 3d | **mean excl. top 1%, 3d** | top 1% share of profit | exact-0 returns, 1d |
|---|---|---|---|---|---|---|---|
| `bb_rsi_confluence_long` | 222,883 | 1.40 / 1.34 / 1.30 / 1.23 | +0.82% | 0.00% | **−0.05%** | 27% | 9.4% |
| `macd_bullish_cross` | 270,912 | 1.04 / 1.04 / 1.06 / 1.07 | +0.10% | 0.00% | **−0.52%** | 25% | 11.5% |
| `volatility_squeeze_breakout_long` | 3,951 | 1.03 / 1.02 / 1.12 / 1.07 | +0.05% | −0.16% | **−0.73%** | 26% | 14.6% |
| `volatility_squeeze_breakout_short` | 4,402 | 0.95 / 0.90 / 0.88 / 0.84 | −0.25% | 0.00% | **−0.60%** | 15% | 22.5% |

Mean excluding the top 1% is negative at **every** horizon (1–20d) for
all four, so every positive mean is carried by a few outsized winners.
None survives the cost model's ~1% round trip at any horizon. The
exact-0 returns are probably stale IEX closes, which would bias win rate
and medians toward zero; that is unverified until the SIP re-run.
Disabled triggers were not re-run and keep their older (pre-#54) notes
below. Two further notes from the 2026-09-11 sweep:
`bb_rsi_confluence_short` and `macd_bearish_cross` fired **zero times**
in 5 years across the whole ~5,000-symbol universe — they are not
"negative expectancy" so much as unreachable, like
`momentum_rank_entry`'s percentile threshold.

| trigger | category | speed | direction | enabled | why |
|---|---|---|---|---|---|
| `bb_rsi_confluence_long` | technical | slow | long | ❌ 09-17 | Oversold Bounce. SIP study 20d net −1.0% (2016-21) / −2.6% (2022+) against a random day's +1.8% / −3.2% — worse than random in one period, no better in the other |
| `macd_bullish_cross` | breakout | slow | long | ❌ 09-17 | Trend Turning Up. 20d net −0.1% / −3.3%: indistinguishable from a random in-band day |
| `volatility_squeeze_breakout_long` | breakout | slow | long | ❌ 09-17 | Quiet Period Up. n=160 in the SIP study and tail-driven; +6.8% 20d (2016-21) does not survive −4.0% (2022+) |
| `volatility_squeeze_breakout_short` | breakout | slow | short | ❌ 09-17 | Quiet Period Down. Never studied on SIP data; 29 fires in three days, median price $9.76, **one** in-band promotion — it was the only sell trigger and produced nothing |
| `bigmove_watchlist` | watch | slow | long | ✅ | Big-Move Watchlist, added 09-17: next-session 10%+ move 3-9x a random day in both periods; Watch, never Buy |
| `earnings_surprise_drift` | earnings | slow | long | ❌ (disabled 2026-09-16) | needs a paid estimates feed FMP's free tier doesn't have |
| `realtime_outlier_zscore` | outlier | slow | long | ✅ | tick-level, no backtest possible; live-confirmation-scored only |
| `momentum_exit` | exit | slow | long | ✅ | the swing exit path (rank-drop/weekly-reversal/180d for momentum entries; time+disaster stop for others) |
| `catalyst_momentum` | intraday | fast | long | ❌ | gross PF 1.32/n=49 was best of 8 variants; **net PF 0.779** on the cost model (1.10 only at a one-tick spread) — no edge |
| `rvol_breakout` | watch | fast | long | ✅ | Heavy Volume Breakout. Re-enabled 2026-09-16 as **Watch** (not a buy): minute test ~break-even before costs, slightly better than a random entry by the close. PF 0.72 once RVOL was correctly calibrated (as a buy) |
| `avoid_chase_extended` | avoid | fast | long | ✅ | Avoid: Don't Chase, first hour by the clock (`session_minutes` 15-60). Minute test, 513 cases: −2.3% vs −1.0% random over 2 h |
| `avoid_volume_blowoff`, `avoid_reverse_split` | avoid | slow | long | ✅ | 25x+ volume (median −16% over 18 sessions); reverse split (−17% to −22% over 20 sessions, both periods) |
| `earnings_release` | catalyst | slow | long | ✅ | the only Buy: 8-K 2.02 beats a random day in both periods (no red flags: +4.2% / +0.4% 20d vs random +1.8% / −3.2%) |
| `vwap_reclaim` | intraday | fast | long | ❌ | PF 0.80 — catches falling knives |
| `gap_and_go` | intraday | fast | long | ❌ | n=41, inconclusive |
| `squeeze_release_intraday` | intraday | fast | long | ❌ | not sim-validated yet (needs a daily factor join the sim doesn't wire up) |
| `momentum_rank_entry` | momentum | slow | long | ❌ | negative expectancy at every horizon; also has an unreachable percentile threshold at this symbol count |
| `momentum_breakout` | breakout | slow | long | ❌ | negative/coin-flip expectancy |
| `bb_rsi_confluence_short`, `macd_bearish_cross` | — | slow | short | ❌ | negative expectancy shorting "overbought" in this universe |

**Disabled 2026-09-17.** The four technical daily triggers above were
turned off after the SIP-clean `daily_trigger_study.py` re-run: none beats a
random in-band day net of ~1% costs, in either period. What stays is what has
evidence: **Earnings Release** (buy), **Big-Move Watchlist** and **Heavy
Volume Breakout** (watch), **Avoid: Volume Blow-off / Reverse Split / Don't
Chase** (avoid), and the exits. No open `shadow_positions` were orphaned by
the change. Targets now holds only Earnings Release — the honest state of the
evidence, not a gap to fill.

`scan_config` (current): `price_min/max` 0.10–5.00, `min_dollar_vol_20d`
2.5M (SIP scale), `max_rsi14` 85 (`min_confluence` was dropped
2026-09-18, with the confluence gate), `account_size` 40, `max_risk_pct` 0.20,
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
