# StackSlash Scanner

Two-tier market scanner: a wide, cheap Tier-1 surface over the whole
universe, and Tier-2 triggers (momentum, earnings drift, technical entry
timing, real-time outlier detection, regime kill-switch) that fire a
deep-dive dossier and a dedup'd alert. See the design discussion in this
project's chat history for the full research basis and architecture
rationale.

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
                           regime_state, non-technical trigger evaluation.
                           Scheduled ~30min after close.
  intraday-scan.ts        Job B — polls snapshots for top-momentum names,
                           evaluates technical-category triggers only, on that
                           candidate set only. Scheduled every 10min during
                           market hours.
  backfill-history.ts     Manually-triggered deep historical pull (default:
                           5 years back) for the 5-Year chart range. Not
                           scheduled — run once per symbol, or when adding one.
  deep-dive.ts            Job C — HTTP-triggered by a Postgres trigger (see
                           "Wiring" below) on every trigger_events insert,
                           from any source (eod-scan, intraday-scan, or the
                           realtime worker). Writes a dossier and dispatches
                           an alert.
  send-alert.ts           Manual/test alert dispatch for an existing dossier.
  lib/
    supabaseAdmin.ts       Service-role client (server-only, bypasses RLS)
    alpaca.ts               Alpaca REST client (daily/intraday bars, snapshots)
    indicators.ts            Pure math: returns, SMA/EMA, RSI, Bollinger, vol, percentile rank
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
- Auth-gated dashboard: live (Realtime) trigger feed, regime banner, symbol drill-down with all five chart ranges

**Placeholder / not yet built, called out in code comments:**
- `deep-dive.ts`'s scoring is a stand-in — always exactly `0.5` for anything without a `momentum_rank_pct` (which includes every outlier-worker fire and every `momentum_exit`). Replace with real multi-signal confirmation / a skew-adjusted-expectation approach once there's evaluation history to tune against.
- `factor_state.sue` / `est_revision_30d` / `book_to_market` etc. are never populated — Alpaca's data API doesn't cover fundamentals/estimates. `earnings_surprise_drift` is seeded but inert until a fundamentals vendor is added.
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

`netlify/functions/lib/indicators.ts` and `triggers.ts` have no I/O
dependencies by design — a future `scripts/backtest.ts` can import them
directly, replay historical `bars_daily` rows (now with 5 years of real
history available), and evaluate the same trigger definitions to score
hit rate / forward return before enabling a trigger live.
