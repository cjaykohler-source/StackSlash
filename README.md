# StackSlash Scanner

Two-tier market scanner: a wide, cheap Tier-1 surface over the whole
universe, and Tier-2 triggers (momentum, earnings drift, technical entry
timing, real-time outlier detection, regime kill-switch) that fire a
deep-dive dossier and a dedup'd alert.

## Session handoff — full project state

Written to stand on its own: a fresh conversation pointed at this repo
shouldn't need the original chat history to pick this up. Everything
below reflects the real, verified state of the system as of this commit
— not aspirational.

### The research this was built on

Two document bundles were analyzed at the start of this project; the
trigger set below is a direct translation of their findings, not
generic technical-analysis folklore.

**Bundle 1 — ~30 papers on technical indicators.** Key findings: single
indicators (RSI, MACD on default settings) mostly failed to beat
buy-and-hold once costs were included; *combinations* of indicators beat
any single one; Bollinger Bands + RSI confluence had the strongest
evidence across multiple papers; momentum outperformed moving-average
rules in less-efficient markets; parameter tuning mattered more than
indicator choice; only ~20% of candlestick patterns showed real signal;
volume confirmation was consistently required; no single indicator set
worked across all markets.

**Bundle 2 — ~24 papers on asset pricing / quantitative finance.**
Key findings: cross-sectional momentum (Jegadeesh & Titman — buy past
12-1 month winners, hold 3-12 months) is the most robust, most-replicated
anomaly in the literature; post-earnings-announcement drift is real but
mechanistically tied to momentum; short-term (1-week) returns *reverse*
rather than continue; penny-stock price/volume prediction via ML was
statistically indistinguishable from random chance; market crashes/
outliers occur far more often than a normal distribution predicts (fat
tails); a volatility/trend regime filter measurably improved returns;
raw expected value is misleading for skewed payoffs (motivates the
skew-adjusted "CEV" scoring concept referenced in `trigger_stats`).

The full back-and-forth reasoning, including the specific paper-by-paper
extraction, lived in chat and was not re-transcribed here — what's below
is the resulting design, verified against real data at every step.

### Infrastructure, as deployed right now

| Piece | Where | Status |
|---|---|---|
| Frontend + functions | Netlify, site `stackslash` → https://stackslash.netlify.app | Live, auto-deploys from GitHub `main` |
| Repo | https://github.com/cjaykohler-source/StackSlash | Clean, pushed, matches what's deployed |
| Database | Supabase project `wnzxvdfskmivbyqadtll` (org StackSlash) | Live — see current counts below |
| Market data | Alpaca, **paper** keys (IEX feed) | No funded account needed for data-only use |
| Alerts | Discord webhook, channel showing as `#heating_up` (bot name "HeatBot") | Working, verified with real fires |
| Auth | Single Supabase Auth user, `cjaykohler@gmail.com` | Working |
| Realtime outlier worker (`worker/`) | Running via `launchd` on the confirmed always-on Mac mini | See "Worker status" below |

Current DB snapshot at time of writing: 8 symbols, 11 triggers (all
enabled), 10,040 `bars_daily` rows (5 years × 8 symbols, zero gaps),
5 `trigger_events`, 27 `trigger_stats` rows, 0 open `shadow_positions`.

### Worker status — resolved this session, one manual step still pending

`worker/` (the persistent Alpaca-websocket outlier detector) **must run
on the one dedicated, always-on Mac mini the user described as "never
sleeps"** — not on any laptop, and not on Netlify (see `worker/README.md`
for why it structurally can't run there).

A prior session hit a real, concrete problem: it touched (at least) two
separate machines that both reported the hostname `Chris-Ks-Mac-Mini`,
making "which box am I on" unreliable from a terminal session alone.
Hardware serial `V4WLRFYCVJ` was positively identified as the *wrong*
machine — that finding still stands, do not target it even if a
hostname matches.

**This session confirmed the correct host directly with the user**
(hostname `Mac-mini` at the time, serial `QLPQFQPRXP`, model Mac14,12 —
an M2 Pro Mac mini) and set the worker up there from scratch:

```bash
git clone https://github.com/cjaykohler-source/StackSlash.git
cd StackSlash/worker
npm install && npm run build
```

`worker/.env` was created with real values pulled from Netlify's env vars
(`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ALPACA_API_KEY_ID`,
`ALPACA_API_SECRET_KEY`, `DISCORD_WEBHOOK_URL`). The `realtime_outlier_zscore`
trigger row was already seeded (`enabled = true`, `cooldown_minutes = 15`)
from an earlier session — no migration needed.

`worker/launchd/com.stackslash.outlier-worker.plist`'s three hardcoded
paths (previously `/Users/chriskohler/Desktop/...`) were rewritten to
this machine's actual clone path (`/Users/ckohler/StackSlash/worker`);
`/opt/homebrew/bin/node` was already correct here. Loaded and verified:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.stackslash.outlier-worker.plist
launchctl print gui/$(id -u)/com.stackslash.outlier-worker | grep -E "state|pid"
# state = running, pid = 4497
```

Confirmed end to end, not just "process exists": the log shows a real
Alpaca websocket connecting, authenticating, and subscribing to all 8
symbols, and Supabase's own `job_runs` table shows a
`realtime-outlier-worker` row with `status = running` and no
`finished_at`, matching the launchd-managed process.

**Still pending — needs an interactive terminal (sudo password), not
something a session can run unattended:**
```bash
sudo scutil --set ComputerName "StackSlash-Worker-Host"
sudo scutil --set HostName "stackslash-worker-host"
sudo scutil --set LocalHostName "stackslash-worker-host"
```
Giving this box a distinct hostname is still worth doing so the
two-machine hostname collision that caused the original confusion can't
recur. Until it's done, re-verify by serial (`QLPQFQPRXP`), not
hostname, if there's ever doubt again about which machine this is.

### Open decisions — need a human call, not a default

1. **`momentum_rank_entry` (`>=0.95`) and `momentum_breakout` (`>=0.9`)
   have mathematically unreachable thresholds at the current 8-symbol
   universe** — `percentileRank`'s max value at n=8 is `7/8=0.875`. The
   backtest confirmed 0 historical fires for exactly this reason, not
   bad luck. Fix is either lowering the threshold to match this
   universe size, or growing the universe — a real tradeoff, not
   patched yet.
2. **All three short/bearish triggers show negative historical
   expectancy** in the backtest (`bb_rsi_confluence_short`,
   `macd_bearish_cross`, `volatility_squeeze_breakout_short`) — over
   this period, shorting "overbought" signals in this large-cap-tech-
   heavy universe has been a losing bet. Worth deciding whether to
   disable them, keep them for visibility only, or leave as-is.
3. **Exit tracking (`shadow_positions`) only covers
   `momentum_rank_entry`/`momentum_breakout`.** The other trigger
   categories have different holding-period logic and were deliberately
   left out (see chat's exit-trigger design discussion) — manual
   position tracking (tying real trades to alerts) was the proposed
   next step beyond the current auto-tracked "shadow" approach.
4. **Universe is 8 symbols.** Fine for verifying the whole pipeline
   works; thin for any of the cross-sectional percentile-rank logic
   (issue #1 above is a direct symptom of this).
5. **Fundamentals/estimates data source** (Polygon, Finnhub, etc.) is
   still needed before `earnings_surprise_drift` can ever fire — Alpaca
   doesn't cover this.

### Outstanding items — everything not finished, in one place

Action items (something to actually go do):
- [ ] **Get the real always-on worker host running** — see "Worker
  status" above for the specific serial-number gotcha and full setup
  steps. This is the single most important outstanding item.
- [ ] Decide + fix the unreachable `momentum_rank_entry`/`momentum_breakout`
  thresholds (Open decisions #1)
- [ ] Decide what to do with the three negative-expectancy short triggers
  (Open decisions #2)
- [ ] Add a fundamentals/estimates data vendor to unblock
  `earnings_surprise_drift` (Open decisions #5)
- [ ] Give the worker host a distinct hostname if it still shares one
  with another machine (see Worker status)

Design/scope decisions (need a call before building, not just a fix):
- [ ] Expand the universe beyond 8 symbols (Open decisions #4) — and
  re-run `backfill-history` + `backtest-triggers` for any new symbols
- [ ] Extend exit tracking beyond momentum triggers, or move from
  auto-tracked shadow positions to real manual position tracking (Open
  decisions #3)

Smaller known gaps (not blocking, called out in code comments):
- [ ] `intraday-scan`'s volume-vs-average still uses the daily bar as a
  proxy rather than the now-populated `bars_intraday` — a proper
  same-time-of-day comparison is a real but minor improvement
- [ ] Edge-function-level auth gating (`AuthGuard.tsx` TODO) — current
  client-side + RLS gate is fine for single-user, not hardened for
  multi-tenant
- [ ] Outlier worker's small-sample z-score reliability at low tick
  counts (`worker/README.md` has the tuning knobs)

Backlog (research-identified, not started — see "Trigger backlog"
section below for full detail):
- [ ] Multi-Timeframe Trend Agreement
- [ ] Candlestick Reversal at a Level
- [ ] Estimate-Revision Breakout (blocked on the same fundamentals gap
  as `earnings_surprise_drift` above)

### Everything built, roughly in the order it happened

1. Two research bundles analyzed → two-tier architecture designed (wide
   Tier-1 surface + narrow Tier-2 triggers, entry/exit/regime-gated)
2. Repo scaffolded: Vite+React frontend, Netlify Functions backend,
   Supabase schema+RLS, seed universe/triggers, deployed and debugged
   through several rounds of Netlify secrets-scanning false positives
   (all resolved — see git history if the specifics matter)
3. `eod-scan`/`intraday-scan` verified against real Alpaca data; found
   and fixed a real bug where `intraday-scan`'s momentum-candidate gate
   was being bypassed by `eod-scan` evaluating the same triggers
   unrestricted
4. 5-year historical backfill (`backfill-history.ts`) + chart range
   toggle (Day/Week/Month/Year/5-Year) on the symbol page; `Day` needed
   its own ingestion job (`intraday-bars-scan.ts`, 1-min bars, 5-min
   cadence) added afterward
5. Dossier display rebuilt from a raw JSON dump into readable labeled
   cards (`DossierCard.tsx`)
6. Trigger feed regrouped by day (collapsible, today expanded by
   default), timestamps normalized to time-only
7. Branding pass: logo, dark-navy theme (`#010e1f`), login panel
   flattened into the background with a `#25e979` green stroke + glow
8. Realtime outlier worker built (`worker/`) — persistent Alpaca
   websocket, EWMA-based z-score outlier detection, verified firing
   real Discord alerts through the same pipeline as everything else;
   `launchd` deployment pattern established (see "Worker status" above
   for its current state)
9. Three more triggers added from the research backlog: Volatility
   Squeeze Breakout, Momentum Breakout, MACD Cross (bullish/bearish)
10. Exit triggers via auto-tracked `shadow_positions` (see "Open
    decisions" #3) — closes on rank drop, a bad week, or 180 days held
11. Plain-English trigger labels applied everywhere
    (`lib/triggerInfo.ts`, single source of truth) + a new `/about` page
    breaking down all 11 triggers in plain language with live
    enabled/cooldown status
12. Real backtest engine (`backtest-triggers.ts` + shared
    `dailySnapshot.ts` factor module) replacing `deep-dive.ts`'s
    placeholder score with actual historical win-rate/expectancy
    (`trigger_stats`) blended with live multi-signal confirmation —
    surfaced both open decisions #1 and #2 above as real findings, not
    assumptions

## Stack

- **Supabase** (`wnzxvdfskmivbyqadtll`, org StackSlash) — Postgres, Auth, Realtime
- **Netlify** — static/SSR frontend + Scheduled Functions as the job runner for daily/intraday scans
- **Alpaca Market Data API** — paper keys are sufficient (no funded account needed for data-only use)
- **`worker/`** — a separate always-on process (Mac mini via `launchd`, or Fly.io) holding a live Alpaca websocket for real-time outlier detection; see `worker/README.md`. Not part of the Netlify deploy.

## Repo layout

```
src/                      Frontend (Vite + React + Supabase client)
  pages/                  Login, Dashboard (trigger feed + regime banner), SymbolDetail (chart + dossiers)
  components/             AuthGuard, RegimeBanner, TriggerFeed
  lib/                    Supabase client, shared TS types (mirrors the DB schema)

netlify/functions/
  eod-scan.ts             Job A — daily bars, factor_state, momentum ranking,
                           regime_state, non-technical/non-exit trigger
                           evaluation, shadow_positions open/close.
                           Scheduled ~30min after close.
  intraday-scan.ts        Job B — polls snapshots for top-momentum names,
                           evaluates technical-category triggers only, on that
                           candidate set only. Scheduled every 10min during
                           market hours.
  intraday-bars-scan.ts   1-min bars, whole active universe, every 5min
                           during market hours — populates the Day chart range.
  backfill-history.ts     Manually-triggered deep historical pull (default:
                           5 years back) for the 5-Year chart range. Not
                           scheduled — run once per symbol, or when adding one.
  backtest-triggers.ts    Manually-triggered: replays every backtestable
                           trigger against 5yr history, writes trigger_stats.
                           Not scheduled — re-run when a trigger definition or
                           dailySnapshot.ts changes.
  deep-dive.ts            Job C — HTTP-triggered by a Postgres trigger (see
                           "Wiring" below) on every trigger_events insert,
                           from any source (eod-scan, intraday-scan, the
                           realtime worker, or a shadow_positions exit).
                           Scores from trigger_stats + live confirmation,
                           writes a dossier, dispatches an alert.
  send-alert.ts           Manual/test alert dispatch for an existing dossier.
  lib/
    supabaseAdmin.ts       Service-role client (server-only, bypasses RLS)
    alpaca.ts               Alpaca REST client (daily/intraday bars, snapshots)
    indicators.ts            Pure math: returns, SMA/EMA, RSI, Bollinger, vol,
                              percentile rank, MACD cross, 20d-high, etc.
    dailySnapshot.ts          Shared factor computation — used live by
                              eod-scan AND by backtest-triggers, so the two
                              can't silently drift apart.
    triggers.ts               Declarative trigger definition evaluator
    notify.ts                  Telegram/Discord dispatch + dedup/cooldown
    jobRun.ts                   job_runs logging wrapper

worker/                   Separate deployable — persistent Alpaca websocket,
                           EWMA-based real-time outlier detection. See its
                           own README for setup/deployment (launchd or Fly.io).
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

   Set the same values in Netlify: Site settings > Environment variables — the
   local `.env` only covers `netlify dev` / `vite dev`. `worker/` has its own
   `.env`, separate from this one (see `worker/README.md`).

3. **Create your login.** Supabase Auth > Users > Add user (email + password).
   This is the single shared login for the password-protected site.

4. **Run locally**
   ```bash
   npx netlify dev
   ```
   This serves the Vite frontend and the Netlify Functions together so
   `fetch('/.netlify/functions/...')` calls resolve. Scheduled functions
   don't fire automatically in dev — invoke them directly, e.g.:
   ```bash
   curl -X POST http://localhost:8888/.netlify/functions/eod-scan
   curl -X POST http://localhost:8888/.netlify/functions/backfill-history
   ```

5. **Deploy.** Connect this repo to a new Netlify site (or `netlify init`),
   set the env vars in the Netlify UI, and push. `netlify.toml` already
   defines the build command, publish dir, SPA redirect, and the two
   scheduled-function cron expressions.

6. **The deep-dive webhook is already wired — nothing to do here.** Unlike a
   typical Supabase Database Webhook (which needs a one-time dashboard setup
   the `supabase_functions` schema doesn't bootstrap on this project), this
   was built directly with `pg_net`: a Postgres trigger
   (`deep_dive_webhook` → `public.notify_deep_dive()`) fires on every
   `trigger_events` insert and POSTs to the deployed `deep-dive` function.
   It's part of the Supabase migration history, not a manual step. If you
   ever move the site to a different URL, update the hardcoded URL inside
   `public.notify_deep_dive()` (via a new migration) to match.

## What's real vs. placeholder

**Real and functional:**
- Schema, RLS, seed universe (SPY + 7 tickers) and 11 seed triggers spanning momentum/earnings/technical/outlier/breakout/exit categories
- `eod-scan`: real Alpaca bars, real momentum/vol/technical/breakout factors, cross-sectional ranking (momentum, 20-day ROC, 1-week return), a real (if simple) SPY-based regime signal, evaluates non-technical/non-exit triggers, opens/closes shadow_positions
- `intraday-scan`: real snapshots, technical-category triggers only, restricted to the momentum-filtered candidate set (this restriction was a real bug once — `eod-scan` was evaluating technical triggers unrestricted too; fixed)
- `intraday-bars-scan`: real 1-min bars, whole active universe, every 5 min during market hours — the **"Day" chart range** is populated, not a placeholder
- `backfill-history` + the 5-Year chart range: verified against real data — 1,255 clean daily bars/symbol, 2021-09 through today
- `worker/`: a genuinely separate, persistent process — real Alpaca websocket, real EWMA-based z-score outlier detection, verified firing real alerts through the same pipeline
- **Shadow positions + `momentum_exit`**: auto-tracked hypothetical positions opened by `momentum_rank_entry`/`momentum_breakout` fires, closed when momentum rank drops, a bottom-decile week hits, or 180 days pass — verified end to end against real data, including the exit alert flowing through the same dossier/pipeline with zero new alert code
- The `deep_dive_webhook` → dossier → dedup'd alert chain, end to end, for every trigger source
- **`backtest-triggers` + real `deep-dive.ts` scoring**: replays every backtestable trigger's actual declarative definition against 5 years of real `bars_daily` history via a shared `dailySnapshot.ts` module (also used live by `eod-scan`, so backtested numbers can't drift from what the live triggers actually do), stores real win-rate/expectancy per trigger in `trigger_stats`. `deep-dive.ts` combines that historical base rate with live multi-signal confirmation (trend, volume, regime) instead of the old flat `0.5`. Verified against real data — score math, historical stats, and confirmations all checked out exactly.
- Auth-gated dashboard: live (Realtime) trigger feed, regime banner, symbol drill-down with all five chart ranges

**Placeholder / not yet built, called out in code comments:**
- `factor_state.sue` / `est_revision_30d` / `book_to_market` etc. are never populated — Alpaca's data API doesn't cover fundamentals/estimates. `earnings_surprise_drift` is seeded but inert until a fundamentals vendor is added — and has 0 backtest samples for the same reason.
- `momentum_rank_entry` (`>= 0.95`) and `momentum_breakout` (`>= 0.9`) use percentile thresholds that are **mathematically unreachable with only 8 symbols** — `percentileRank`'s max possible value at n=8 is `7/8 = 0.875`. The backtest surfaced this directly (0 samples for both, not "hasn't happened yet"). Needs either a lower threshold sized to the current universe, or a bigger universe — a real open decision, not something to silently patch.
- `realtime_outlier_zscore` and `momentum_exit` aren't in `trigger_stats` — the former is tick-level (can't replay against end-of-day bars), the latter depends on `shadow_positions` state rather than a stateless factor check. Both fall back to confirmation-only scoring in `deep-dive.ts` until they can accumulate their own live-fire history.
- Volume-vs-average in `intraday-scan` still uses the daily bar as a rough proxy rather than `bars_intraday` (which now exists and is populated) — a proper same-time-of-day comparison is still a follow-up.
- Universe is 8 symbols — expanding it is just adding rows to `symbols` (then re-running `backfill-history` for the new ones).
- Exit tracking only covers `momentum_rank_entry`/`momentum_breakout` — the mean-reversion/short-horizon triggers (BB/RSI confluence, squeeze breakout, MACD cross, outlier) have different holding-period logic and aren't tracked in `shadow_positions`. Manual position tracking (tying real trades to alerts, rather than auto-opening a shadow position on every entry fire) is a natural next step — see the exit-trigger design discussion in this project's chat history.
- Edge-function-level auth gating (blocking page load itself, not just data) — noted as a TODO in `AuthGuard.tsx`. Current gate is client-side redirect + RLS as the real security boundary; fine for single-user, not a hardened multi-tenant gate.
- The outlier worker's z-score reliability at low tick counts is a known, real limitation (small-sample EWMA variance) — see its own README for the tuning knobs (`MIN_TICKS_BEFORE_EVAL`, `EWMA_ALPHA`).

## Trigger backlog

Signals considered against the research this project is built on but not
yet built, roughly in priority order:

- **Multi-Timeframe Trend Agreement** — EMA stack aligned on daily *and*
  weekly, pullback to the fast EMA, RSI resets to 40-50. Needs
  weekly-timeframe bars/EMAs, not just daily — more ingestion work than
  the three triggers added in this pass.
- **Candlestick Reversal at a Level** — hammer / bullish engulfing /
  rising window occurring at a support/MA level, volume-confirmed. Needs
  OHLC pattern-detection logic (we already store full OHLC in
  `bars_daily`, so no new data source — just more involved code than a
  threshold check).
- **Estimate-Revision Breakout** — analyst estimate revisions trending up
  ahead of price. Blocked on the same fundamentals/estimates data-source
  gap as `earnings_surprise_drift` (Alpaca's market-data API doesn't cover
  this; needs a vendor like Polygon or Finnhub added as a small extra
  step in `eod-scan`).

## Backtesting

Built: `backtest-triggers.ts` replays every backtestable trigger's real
declarative definition against 5 years of `bars_daily` history via the
shared `dailySnapshot.ts` factor module (also used live by `eod-scan`,
so a backtest can't silently compute things differently than
production), and writes real win-rate/expectancy numbers into
`trigger_stats` — see "Everything built" #12 and "Open decisions" #1/#2
above for what it already found. Not scheduled — re-run it manually
whenever a trigger's definition or `dailySnapshot.ts` changes:

```bash
curl -X POST https://stackslash.netlify.app/.netlify/functions/backtest-triggers
```

`indicators.ts` and `triggers.ts` still have no I/O dependencies by
design, which is exactly what made this reusable rather than a
duplicated implementation.
