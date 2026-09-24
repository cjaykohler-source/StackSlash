# StackSlash / RIOT — logistics handoff

Written 2026-09-21. Where everything lives and how it runs today. This is
the "what is plugged into what" document; `README.md` holds the strategy,
the research derivations and the open decisions.

---

## 1. Machines and accounts

| Thing | Where |
|---|---|
| Repo | `~/StackSlash` on host **stackslash-worker-host** (macOS, Apple Silicon). GitHub: `cjaykohler-source/StackSlash`, default branch `main` |
| The only machine anything runs on | stackslash-worker-host. Nothing runs on a laptop, in CI or in the cloud except Netlify and Supabase |
| Site | Netlify, https://stackslash.netlify.app (auto-deploys from `main`) |
| Database | Supabase project `wnzxvdfskmivbyqadtll` (org StackSlash), **Pro plan**, ~2.4 GB of 8 GB |
| Access / credential map | `docs/ACCESS.md` — accounts to be invited to, credential names, what each key can do, handover checklist |
| Secrets | `~/StackSlash/.env` (not in git). Netlify has its own copy of the same vars in site settings |
| Local backups | `~/StackSlashBackups/` — one file, 2026-09-11. Not scheduled (see §8) |
| Logs | `~/Library/Logs/stackslash-<job>/` , one directory per job |
| launchd units | `~/Library/LaunchAgents/com.stackslash.*.plist`, copies tracked in `scripts/launchd/` |

Python for the local jobs is `research/.venv/bin/python` (3.9 — too old for
`ib_async`, which is why the IB job is Node). Node is `/opt/homebrew/bin/node`.

---

## 2. Repo layout

```
src/                 React + Vite site (dashboard, symbol page, reports)
netlify/functions/   TypeScript serverless functions = the job bodies
netlify/functions/lib/   shared: alpaca, supabaseAdmin, triggers, riskFlags,
                         promotionGate, alertPositions, fmp, dolthub, ...
worker/              standalone Node package (outlier websocket worker,
                     ibShortAvailability.ts); own package.json + node_modules
scripts/             host-side runners, launchd plists, Python syncs
research/            Python research + local DuckDB/Parquet warehouse
research/data/       90 GB warehouse (NOT backed up, rebuildable).
                     minute/ = ~2 BILLION SIP minute bars, 2016-2026,
                     market-wide, full OHLC + trade_count + vwap
docs/                this file
dist/                built site (git-ignored)
```

Key scripts:

| File | Does |
|---|---|
| `scripts/run-netlify-job.sh JOB [START END]` | Runs one `netlify/functions/<job>.ts` locally via `tsx`, with an optional ET weekday window gate. This is how jobs that outgrew Netlify's ~30 s limit run |
| `scripts/run-python-job.sh NAME script.py` | launchd wrapper for the Python syncs |
| `scripts/run-ib-short-availability.sh` | launchd wrapper for the IBKR borrow job |
| `scripts/run-research-update.sh` | Nightly warehouse update (corporate actions → SIP daily → SIP minute) |
| `scripts/localjobs.py` | Shared Python helpers: `.env` loader, PostgREST client, `job_runs` wrapper |
| `research/backup_supabase.sh` | Logical Supabase backup. Works, not scheduled |

---

## 3. How a job actually runs

Three execution homes, chosen by how long the job takes:

1. **launchd on the host** — anything over ~30 s. `scripts/launchd/*.plist`
   are the source of truth; they are copied to `~/Library/LaunchAgents/`
   and loaded with
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/<label>.plist`.
   Re-running bootstrap on a loaded job prints "Input/output error"; that
   is harmless. `launchctl kickstart gui/$(id -u)/<label>` runs one now.
2. **Supabase pg_cron** — pure-SQL work. Jobs are in `cron.job`, history in
   `cron.job_run_details`. They call `public.run_logged_job(...)` so they
   still appear in `job_runs`.
3. **Netlify scheduled functions** — only jobs that finish well under 30 s
   (`netlify.toml` `[functions.*] schedule`, UTC cron). Netlify cuts a
   scheduled function at ~30 s **and retries it**, which historically
   produced duplicate runs, double-posted alerts and orphaned `running`
   rows. That is why almost everything moved to launchd.

Every job writes a `job_runs` row (`job_name`, `status`, `started_at`,
`finished_at`, `rows_processed`, `error`). **Check `job_runs` before
believing any job works.** A row stuck at `running` means the process was
killed.

Other limits worth knowing: PostgREST requests from the `authenticated`
role time out at 8 s unless the function sets its own `statement_timeout`;
HTTP to Supabase dies at ~125 s; Alpaca's free plan allows 200 req/min;
PostgREST pagination silently skips rows without an explicit `.order()`.

---

## 4. Scheduled jobs (all times America/New_York unless stated)

**Every 5 minutes during the session — launchd**

| Job | Window | Does |
|---|---|---|
| `intraday-bars-scan` | 09:00–19:55 | IEX 1-min bars → `bars_intraday` |
| `intraday-factors-scan` | 09:00–16:55 | → `intraday_factor_state` |
| `intraday-flip-scan` (+2 min offset) | 09:35–16:00 | **Live alert engine** |
| `manage-positions` | 09:30–16:00 | Exit Warnings on open positions |
| `news-scan` (Netlify, `*/5 12-20 * * 1-5` UTC) | | Headlines → `symbol_news` |
| `outlier-worker` | always on | IEX websocket, z-score outliers |

**Daily**

| Time | Job | Home | Does |
|---|---|---|---|
| 02:00, 17:00 daily | `fundamentals-sync` | launchd | FMP earnings calendar + company profiles → `earnings` |
| Mon 08:00 | `refresh-fundamentals` | launchd | DoltHub statements + Zacks → `fundamentals` (the only writer of that table; loaded 2026-09-21) |
| 07:15 weekdays | `finra-short-interest-sync` | launchd | FINRA short interest, skips settlements already loaded |
| 07:30 / 17:30 / **22:30** weekdays | `sec-filings-sync` | launchd | EDGAR daily index → `sec_filings`. EDGAR publishes a session's index in the evening, so **22:30 is the run that lands that day's filings** |
| 09:45, 15:15 weekdays | `ib-short-availability` | launchd | IBKR shares-to-borrow. Needs IB Gateway logged in |
| 17:45 weekdays | `eod-scan` | launchd | Daily factors + daily triggers (~200 s, ~4,980 rows) |
| 18:10 weekdays | `eod-digest` | launchd | One ranked Discord card |
| 18:20 / 18:20 / 18:25 weekdays | `prune-bars-intraday`, `prune-trigger-evaluations`, `prune-bars-daily` | Netlify | Retention |
| 19:00 weekdays | `refresh-window-stats` | pg_cron | Rolling factor stats (20-min statement timeout) |
| 19:10 weekdays | `record-fire-outcomes` | launchd | Realized outcomes of fires |
| 19:35 weekdays | `refresh-intraday-volume-profile` | Netlify | Time-of-day volume profile |
| 19:45 nightly | `data-integrity-check` | launchd | Data-quality checks; posts regressions to Discord |
| 20:30 weekdays | `research-update` | launchd | Local warehouse only; **writes no `job_runs` row** — check its log |
| 23:00 weekdays | `sec-balance-sheet-sync` | launchd | SEC XBRL balance sheets (~27 min, ~4,720 rows) |

**Weekly — pg_cron**

| Time | Job | Does |
|---|---|---|
| Sun 03:00 ET (07:00 UTC) | `refresh-spread-estimates` | Abdi-Ranaldo spread estimates |
| Mon 02:00 ET (06:00 UTC) | `weekly-bars-scan` | `bars_weekly` |

**Manual only:** `intraday-scan`, `backfill-history`, `backtest-triggers`,
the Supabase backup,
and the Robinhood float snapshot (only possible from a Claude session).

---

## 5. Data sources

| Source | Used for | Auth | Notes |
|---|---|---|---|
| **Alpaca** | SIP daily bars, IEX 1-min bars, snapshots, corporate actions, asset validation | `ALPACA_API_KEY_ID` / `ALPACA_API_SECRET_KEY` | Free plan. Daily bars = SIP consolidated. Intraday = IEX (real-time). Free SIP is 15 min delayed. Asset lookups go to `paper-api.alpaca.markets`; the live trading host rejects these keys |
| **SEC EDGAR** | Filings index, XBRL balance sheets | `SEC_USER_AGENT` (contact email) | Free, ≤10 req/s |
| **FINRA** | Short interest | none | Public POST API, twice monthly, published 1–2 weeks after settlement |
| **IBKR** | Shares to borrow, delayed quotes | IB Gateway on 127.0.0.1:**4001** (live login, Read-Only API on) | Free tier only (delayed quotes + borrow work). Real-time still returns error 10089 over the API although both bundles are active; **support ticket submitted 2026-09-21** asking for a manual entitlement refresh, and to confirm the subscriptions sit on the account the API session defaults to (the username has two live accounts) |
| **FMP** | Earnings calendar, company profiles | `FMP_API_KEY` | Free tier ~250 calls/day; the job uses ≤90 profile calls per run |
| **DoltHub** | Financial statements, forward calendar, Zacks | none | Feeds `fundamentals` |
| **Discord** | Alerts and digests | webhook in `.env` | |
| **Robinhood (MCP)** | Float, listing status, L2, consolidated quotes, SEC facts | Claude session connector | **Cannot be called by host jobs** — Claude sessions only. Read-only; never trade |

---

## 6. Database

### Production: Supabase Postgres

RLS is on everywhere with an `authenticated read` SELECT policy; writes go
through the service-role key. The site reads directly via PostgREST.

**Market data:** `bars_daily` (876 MB, 5.4M rows, 5 y SIP), `bars_intraday`
(544 MB, IEX 1-min, pruned), `bars_weekly`, `intraday_volume_profile`,
`symbol_spread_estimates`.

**Signals/history:** `factor_state` (daily factors), `intraday_factor_state`,
`fire_outcomes` (now also `intraday_entry_price` / `intraday_ret_2h` /
`intraday_mfe_2h` / `intraday_mae_2h` / `intraday_bars_2h` — buyer-sense
excursions from the fire tick over 2h, for fast triggers; the older
`mfe_pct`/`mae_pct` are daily-horizon from the daily close),
`factor_window_stats`, `trigger_evaluations` (407 MB, pruned),
`pending_fires`, `trigger_events`, `alerts`, `dossiers`, `fire_outcomes`,
`shadow_positions`, `backtest_returns_raw`, `flip_sim`.

**Company data:** `fundamentals` (DoltHub), `balance_sheet` (SEC XBRL, 4,720
symbols), `short_interest` (FINRA, 12 settlements), `short_availability`
(IBKR borrow), `broker_snapshot` (Robinhood float + listing status, 374
names, one-off 2026-09-18), `sec_filings`, `earnings`, `symbol_news`.

**Views:** `trigger_scorecard` (one row per fire: fire price vs the
reference close, and whether the signal class was directionally right),
`trigger_scorecard_daily` (the per-day rollup — "11/16 Sell signals closed
below the firing price"). Horizon differs by trigger speed: **fast** fires
mid-session so it scores against *that* session's close; **slow** fires
from `eod-scan` at 17:45 so its fire price already *is* that close, and it
scores against the *next* session. Getting that backwards returns 0% by
construction.

**Config/ops:** `symbols` (5,003 active), `triggers` (22), `trigger_stats`,
`scan_config`, `tracked_symbols`, `regime_state`, `screens`, `watchlists`,
`job_runs`, `data_quality_issues`.

Schema changes go through the Supabase MCP `apply_migration`. The MCP's
`execute_sql` is **read-only**, so data writes use the service-role client
(`netlify/functions/lib/supabaseAdmin.ts` or `scripts/localjobs.py`).
Destructive production SQL (row DELETE/DROP) is handed to the user to run.

### Local research warehouse — `research/data/`, ~90 GB, not backed up

`minute/` (85 GB SIP minute bars — ~2 billion rows, 2016 to yesterday,
6,029 symbols in 2016 rising to 13,271 in 2026, with `open, high, low,
close, volume, trade_count, vwap`. This is **deeper and truer than
production's `bars_intraday`**, which is IEX, 90 days and close-only —
all intraday research belongs here, and nothing needs backfilling), `stackslash.duckdb` (1.1 GB daily bars +
research tables), `edgar/` (3.1 GB submissions + companyfacts + Parquet
extracts), `minute_log.duckdb`, `corporate_actions/`, `schema_runs*`.
Rebuildable from Alpaca and EDGAR, which is why it is disposable — the
Supabase database is not.

---

## 7. The site

Vite + React, deployed by Netlify from `main`. Behind sign-in (Supabase
Auth); the user signs in themselves.

- **Dashboard:** Spotlight chart grid (`tracked_symbols.spotlight`), trigger
  feed (Time · Symbol · Catalyst · Flags · Fired at · Price · Change, split
  Buy / Watch / Sell), sidebar with the Tracking column, top gainers and
  losers.
- **Symbol page:** title with live price and Track button; range controls;
  chart; volume meter (session volume vs the median day of the prior 20
  sessions); right-hand snapshot column (price stats + grouped factor
  snapshot); **Financials panel** (balance sheet, short interest, borrow,
  float + listing status — all amber, no flags) above Recent News; trigger
  status grouped Buy / Watch / Avoid / Exit; dossiers.
- **Quote states:** live · `15m` (delayed tape fallback) · `Sep 17` (last
  close, no trade today).

Verifying a UI change: build locally, merge, wait for the deploy, then
confirm the live `assets/index-*.js|css` hash matches the local `dist/`
build of the merge commit, and measure the rendered page (positions,
widths, overflow) rather than eyeballing it.

---

## 8. Current state, 2026-09-22 09:00 ET

- **Read `README.md` -> "Session 2026-09-21/22 — the audit" first.** It
  supersedes older sections where they disagree, and it is where the
  trigger evidence now lives.
- All scheduled jobs' latest runs are `ok`. `refresh-fundamentals` is now
  **loaded** (Mon 08:00) -- it is the only writer of the `fundamentals`
  table and had never been scheduled, so revenue/Zacks data only updated
  when someone pressed the button on /settings.
- **Band is $0.10-$5.00.** `scan_config.price_max` had drifted to 10; it
  was standardised, measured, and reverted (#176 then #187). Monitoring
  band 623 names, alerting band 363.
- The outlier worker fires again (#175), and `bigmove_score`'s 8-K point
  fires for the first time (#190).
- **`fundamentals` row age is the quarterly reporting cycle, not
  staleness.** `as_of` is the fiscal period end; median ~83 days is
  correct with 85% of rows on Q2 2026. It cannot be fresher than the
  companies report. Q3 lands late Oct-mid Nov.
- Supabase backups: `research/backup_supabase.sh` plus the nightly job
  from #172. Pro's own daily backups remain the net.
- **Do not run research scripts above `--max-price 5`** without meaning
  to: $5-$10 is outside the traded band and was only ever examined
  incidentally. Both `bigmove_study.py` and `catalyst_study.py` now
  default to 5 and warn above it.

## 8b. Previous state, 2026-09-21 08:00 ET

- All scheduled jobs' latest runs are `ok`. The weekend's two pg_cron jobs
  both ran: `refresh-spread-estimates` Sunday (4,960 rows),
  `weekly-bars-scan` this morning (1,142,340 rows).
- `fundamentals-sync` now runs once per slot on launchd (the Netlify
  double-invocation is gone).
- Data is fresh to the 09-18 close; the 22:30 SEC run lands same-day
  filings (137 on 09-18, 113 of them 8-Ks).
- **IB Gateway is not running right now**, so today's 09:45 borrow job will
  fail until it is logged in again. IB logs it out roughly every 24 h.
- One stale `running` row remains: `fundamentals-sync` 2026-09-18 21:00.
- Supabase backups are not scheduled; the only local dump is 2026-09-11.
  Pro's own daily backups are the current safety net.
- `stale_active_symbol` is 15 and grows because nothing ever sets
  `symbols.active = false` for delisted tickers (GLMD, RAY, CYCN, KWM are
  inactive at Alpaca but still active here).

See `README.md` → "Audit follow-ups (2026-09-19)" and "Open decisions /
next steps" for the full list of what is pending and why.

---

## 9. Working conventions

- Feature branch → PR → merge with `gh pr merge --merge --delete-branch`,
  then confirm the deploy by hash.
- One small PR per UI change, each verified on the live site.
- Trading/portfolio actions are never automated; the Robinhood connector is
  read-only and the IB API is Read-Only.
- Red flags mean a proven negative, never urgency; anything untested is
  amber. Buy / Watch / Sell is one rule everywhere. Volume baselines are the
  **median** day of the prior 20 sessions, never the mean.
- Triggers are judged on evidence: net of ~1% round-trip cost, against a
  random in-band control, 2016–21 and 2022+ reported separately.

---

## 10. Starting a new conversation on this project

Read in this order:

1. **`README.md` -> "Session 2026-09-22/24 — the growth null, and the
   display layer"**. It is the current state and supersedes every
   section below it, including the 2026-09-21/22 audit section. Its
   **"Open items — the consolidated list"** replaces every earlier
   to-do list in that file.
2. **`docs/research-audit-plan.md`** — what has and has not been verified.
   Layer 1 is done for `bigmove_study.py` and `catalyst_study.py` and
   Layer 2 for `bigmove_study.py`; Layer 3 (independent
   reimplementation) has not started, `catalyst_study.py` still has no
   negative controls, and four other studies are unaudited.
3. **`docs/growth-prereg.md`** — the growth question, pre-registered and
   answered (no). Its RESULTS section also carries the measured noise
   floor for this pool, which any future threshold has to be set
   against.
4. **`docs/overhaul-plan.md`** — the architecture: EOD analysis after
   22:30, overnight enrichment of a shortlist, a pre-open report,
   intraday monitoring of names already listed.
5. **`docs/selection-logic.md`** — how the daily target list is chosen.
   Catalyst-primary; `bigmove_score` is an annotation and a
   de-prioritiser, not a source of candidates.
6. This file for logistics, and `docs/ACCESS.md` for credentials.

### Working rules learned the hard way

- **Verify against code and data, never against a description.** Three
  separate findings on 2026-09-21 came from reading this repo's own docs
  instead of the thing they describe, and two of them were wrong. If a
  README line matters to a decision, open the file it describes.
- **Check whether it already exists before building it.** A backfill, a
  replay, MFE/MAE columns and a negative-control harness were each
  proposed and then found to exist or to be unnecessary.
- **Never judge a signal on a direction-blind metric.** `abs10` sums both
  tails, which is how a downside selector reached the top of the first
  selection spec.
- **A mean carried by one observation is not a result.** This project's
  own `mean_excl_top1pct` machinery exists because of it; the live
  scorecard reproduced the same trap within five fires.
- **Feed scales do not mix.** `volume_ratio_20d` is SIP daily, `rvol` is
  IEX intraday. Conflating them produced a wrong recommendation minutes
  after that exact failure was written up as an audit finding.
- Research runs default to `--max-price 5`. Above that leaves the traded
  band.
- **Set a threshold against a measured noise floor, never an assumed
  standard error.** The growth study's pre-registered 5pp bar turned out
  to sit inside a +-8.5pp shuffle floor, because its power math used a
  count from before the liquidity filter. `growth_study.py
  --control-reps N` prints the distribution of the statistic a threshold
  is stated in; use it before fixing the threshold, not after.
- **Verify the rendered result, not the inputs to it.** The extended-hours
  chart shipped with correct axis maths and correct OHLC guards, and
  candles in the wrong place, because the pipeline that turns a bar into
  an x coordinate was never checked. Check true-value-in against
  drawn-value-out.
- **Check the comparison you are actually making.** The volume meter's
  height bug reports a 0px difference when you compare the two flex
  children, in both the broken and the fixed state, because one of them
  stretches. Only the chart *content* shows the gap.
- **When you change a number, find every other place that shows it.** The
  quote fix was right about the metric and wrong about the feed, and the
  tell was that the header still disagreed with the chart's own
  prior-close line.
