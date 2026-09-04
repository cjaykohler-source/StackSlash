# StackSlash Scanner

Two-tier market scanner: a wide, cheap Tier-1 surface over the whole
universe, and Tier-2 triggers (momentum, earnings drift, technical entry
timing, regime kill-switch) that fire a deep-dive dossier and a dedup'd
alert. See the design discussion in this project's chat history for the
full research basis and architecture rationale.

## Stack

- **Supabase** (`wnzxvdfskmivbyqadtll`, org StackSlash) — Postgres, Auth, Realtime
- **Netlify** — static/SSR frontend + Scheduled Functions as the job runner
- **Alpaca Market Data API** — paper keys are sufficient (no funded account needed for data-only use)

## Repo layout

```
src/                      Frontend (Vite + React + Supabase client)
  pages/                  Login, Dashboard (trigger feed + regime banner), SymbolDetail
  components/             AuthGuard, RegimeBanner, TriggerFeed
  lib/                    Supabase client, shared TS types (mirrors the DB schema)

netlify/functions/
  eod-scan.ts             Job A — daily bars, factor_state, momentum ranking,
                           regime_state, trigger evaluation. Scheduled ~30min after close.
  intraday-scan.ts        Job B — polls snapshots for top-momentum names,
                           evaluates technical triggers only. Scheduled every 10min
                           during market hours.
  deep-dive.ts            Job C — HTTP-triggered on trigger_events insert
                           (wire via a Supabase Database Webhook). Writes a
                           dossier and dispatches an alert.
  send-alert.ts           Manual/test alert dispatch for an existing dossier.
  lib/
    supabaseAdmin.ts       Service-role client (server-only, bypasses RLS)
    alpaca.ts               Alpaca REST client (bars, snapshots)
    indicators.ts            Pure math: returns, SMA/EMA, RSI, Bollinger, vol, percentile rank
    triggers.ts               Declarative trigger definition evaluator
    notify.ts                  Telegram/Discord dispatch + dedup/cooldown
    jobRun.ts                   job_runs logging wrapper
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
   local `.env` only covers `netlify dev` / `vite dev`.

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
   ```

5. **Deploy.** Connect this repo to a new Netlify site (or `netlify init`),
   set the env vars in the Netlify UI, and push. `netlify.toml` already
   defines the build command, publish dir, SPA redirect, and the two
   scheduled-function cron expressions.

6. **Wire the deep-dive webhook.** In Supabase: Database > Webhooks > new
   webhook on table `trigger_events`, event `INSERT`, HTTP target
   `https://<your-site>.netlify.app/.netlify/functions/deep-dive`. Without
   this, trigger fires will sit in `trigger_events` with `status = 'new'`
   and never get a dossier or an alert.

## What's real vs. placeholder in this scaffold

**Real and functional once env vars are set:**
- Schema, RLS, seed universe (SPY + 7 tickers) and seed triggers
- `eod-scan`: fetches real Alpaca bars, computes real momentum/vol/technical
  factors, ranks momentum cross-sectionally, computes a real (if simple)
  regime signal off SPY, evaluates triggers, logs every evaluation
- `intraday-scan`: polls real snapshots, evaluates technical triggers on
  the momentum-filtered candidate set
- Trigger evaluation, dedup/cooldown (DB-constraint-backed), Telegram/Discord delivery
- Auth-gated dashboard with a live (Realtime) trigger feed and a symbol
  drill-down chart

**Placeholder, called out in code comments — next things to build:**
- `deep-dive.ts`'s scoring is a stand-in (`momentum_rank_pct` as a fake
  "conviction score"). Replace with real multi-signal confirmation / the
  skew-adjusted-expectation (CEV) approach from the research once there's
  evaluation history to tune against.
- `factor_state.sue` / `est_revision_30d` / `book_to_market` etc. are never
  populated — Alpaca's data API doesn't cover fundamentals/estimates. The
  `earnings_surprise_drift` trigger is seeded but inert until a fundamentals
  vendor (Polygon, Finnhub, etc.) is added as a small extra step in `eod-scan`.
  vol_percentile_252d, amihud_illiq, and the fundamentals fields in
  `factor_state` are also not yet computed.
- Volume-vs-average in `intraday-scan` uses the daily bar as a rough proxy;
  a proper same-time-of-day comparison needs `bars_intraday` populated first.
- Universe is 8 symbols. Expanding it just means adding rows to `symbols`
  (or a script that syncs from an index constituent list) — nothing else
  changes.
- Edge-function-level auth gating (blocking the page load itself, not just
  data) — noted as a TODO in `AuthGuard.tsx`. Current gate is client-side
  redirect + RLS as the actual security boundary, which is enough for a
  single-user password-protected tool but not a hardened multi-tenant gate.

## Backtesting

`netlify/functions/lib/indicators.ts` and `triggers.ts` have no I/O
dependencies by design — a future `scripts/backtest.ts` can import them
directly, replay historical `bars_daily` rows, and evaluate the same
trigger definitions to score hit rate / forward return before enabling a
trigger live.
