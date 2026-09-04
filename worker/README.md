# Realtime Outlier Worker

A persistent process, separate from the main Netlify+Supabase app, that
holds an open websocket to Alpaca's market data stream and flags outlier
trades the instant they print — no polling, no scheduled-function
1-minute cron floor. This exists specifically for "catch it faster than
others," which the serverless scheduled functions (`eod-scan`,
`intraday-scan`) structurally can't do (Netlify cron has a 1-minute
granularity floor; this needs a genuinely long-lived connection instead).

Everything downstream is unchanged: this worker only inserts a row into
`trigger_events`, same as the scheduled functions do. The existing
`deep_dive_webhook` Postgres trigger (see the main project's Supabase
migrations) picks it up automatically and runs the same dossier + Discord
alert pipeline — this worker doesn't duplicate any of that.

## How outliers are detected

Per symbol, an EWMA (exponentially weighted moving average) of tick-to-tick
log returns is updated on every trade — mean and variance, no stored
history, O(1) per tick. Once a symbol has enough ticks to trust the stats
(`MIN_TICKS_BEFORE_EVAL`), each new tick's return is turned into a
z-score against that rolling mean/stddev. A tick crossing
`Z_SCORE_THRESHOLD` (default 3.0, matching the "3 standard deviations"
method from the Black Swan paper referenced in the research this project
is built on) fires an outlier event, subject to the trigger's
`cooldown_minutes` so a sustained move doesn't spam repeated fires.

This is relative to each symbol's *own recent* volatility (the EWMA
adapts continuously), not a fixed percentage move — a 2% tick in a
normally-sleepy utility stock is a very different signal than a 2% tick
in something already running hot, and this detector treats them
differently by design.

## One-time setup

1. **Seed the trigger row** (run once against the Supabase project — via
   the Supabase SQL editor, or ask Claude to apply it as a migration):

   ```sql
   insert into triggers (name, description, definition, category, cooldown_minutes)
   values (
     'realtime_outlier_zscore',
     'Streaming tick flagged >=3 EWMA standard deviations from its own recent rolling mean return. Evaluated incrementally by worker/, not the declarative triggers.ts evaluator the scheduled functions use — definition here is informational only.',
     '{"note": "evaluated in worker/src/rollingStats.ts, not by triggers.ts"}'::jsonb,
     'outlier',
     15
   )
   on conflict (name) do nothing;
   ```

   The `definition` column isn't read by this worker (unlike the
   scheduled functions' triggers, which go through `triggers.ts`'s
   declarative evaluator) — it's there so `trigger_events.trigger_id`
   has something to point at and the dashboard's trigger feed can show a
   real name/category. `cooldown_minutes` **is** read live, and governs
   how often the same symbol can re-fire.

2. **Copy `.env.example` to `.env`** and fill in the same Supabase
   service-role key and Alpaca keys used by the main app (`.env` in the
   repo root) — this is a separate deployable with its own env, not
   shared automatically with Netlify's.

## Running locally

```bash
cd worker
npm install
npm run dev
```

Runs against real Alpaca data and the real Supabase project immediately
— there's no "local mode." Watch the console for `OUTLIER ...` log lines
and check Discord for alerts once one fires. Stop with Ctrl+C (handled
gracefully — marks its `job_runs` row `ok` on exit rather than leaving it
stuck at `running`).

## Deploying (Fly.io)

```bash
cd worker
flyctl launch   # first time only — creates the app from fly.toml
flyctl secrets set \
  SUPABASE_URL=https://your-project-ref.supabase.co \
  SUPABASE_SERVICE_ROLE_KEY=... \
  ALPACA_API_KEY_ID=... \
  ALPACA_API_SECRET_KEY=...
flyctl deploy
```

Fly.io is the assumed target (`fly.toml`/`Dockerfile` are set up for it),
but the Docker image is portable — Railway or any other host that runs a
container and lets it hold outbound connections works the same way; just
skip `fly.toml` and set the same env vars in that platform's UI.

## Operational notes

- **No HTTP server, no port binding.** This process only makes outbound
  connections (Alpaca websocket, Supabase REST). Don't add a
  `[[services]]` block to `fly.toml` expecting a health-check port — this
  isn't a web app, and adding one is more likely to cause a bad deploy
  than help.
- **Health visibility:** `job_runs` gets one row per process lifetime
  (not one per tick), `job_name = 'realtime-outlier-worker'`, with
  `finished_at`/`rows_processed` (cumulative tick count) bumped every
  `HEARTBEAT_INTERVAL_MS`. A row stuck at `status = 'running'` with a
  stale `finished_at` means the process died without a clean shutdown —
  check the host's logs.
- **Reconnects automatically** on any socket close/error with
  exponential backoff (capped at 30s). A prolonged Alpaca-side outage
  will show as a stale heartbeat even though the process itself is
  alive and retrying — that's expected, not a bug to chase.
- **IEX feed limitation still applies** (same as the main app): this is
  one exchange's tape, not the full consolidated SIP feed. An outlier
  print that happens first on another exchange may reach this worker a
  beat later than it would on a paid SIP subscription.
