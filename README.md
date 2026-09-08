# StackSlash Scanner

Two-tier market scanner: a wide, cheap Tier-1 surface over the whole
universe, and Tier-2 triggers (momentum, earnings drift, technical entry
timing, real-time outlier detection, regime kill-switch) that fire a
deep-dive dossier and a dedup'd alert.

## Session handoff — full project state

Written to stand on its own: a fresh conversation pointed at this repo
shouldn't need the original chat history to pick this up. Everything
below reflects the real, verified state of the system as of this commit
— not aspirational. Where something is fixed-but-not-yet-confirmed, it
says so explicitly rather than claiming success.

### The research this was built on

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
(motivates the skew-adjusted "CEV" scoring concept referenced in
`trigger_stats`).

### Infrastructure, as deployed right now

| Piece | Where | Status |
|---|---|---|
| Frontend + functions | Netlify, site `stackslash` → https://stackslash.netlify.app | Live, auto-deploys from GitHub `main` |
| Repo | https://github.com/cjaykohler-source/StackSlash | `main`, clean and pushed |
| Database | Supabase project `wnzxvdfskmivbyqadtll` (org StackSlash) | Live — see current counts below |
| Market data | Alpaca, **paper** keys (IEX feed) | No funded account needed for data-only use |
| Alerts | Discord webhook, channel showing as `#heating_up` (bot name "HeatBot") | Working, verified with real fires |
| Auth | Single Supabase Auth user, `cjaykohler@gmail.com` | Working |
| Realtime outlier worker (`worker/`) | Running via `launchd` on the always-on Mac mini (hostname `stackslash-worker-host`, serial `QLPQFQPRXP`) | Redeployed 2026-09-08 on the confluence-gate code; watches the top ~28 by liquidity + any tracked symbols (Alpaca free IEX websocket caps subscriptions ~30 — it can't watch the whole universe). Fires route through `confluence-gate`, verified via `pending_fires` |

Current DB snapshot (live query, not from memory):
**1,911 active symbols**, 2,222,635 `bars_daily` rows (443 MB total DB
size), 9 enabled triggers, 228 `trigger_events`, 27 `trigger_stats`
rows, 21 open `shadow_positions`.

### Universe — S&P 500 + NYSE common stock (grown from 8 → 512 → 1,911 across this project's history)

The universe started at 8 hand-picked tickers, was expanded to the full
S&P 500 (512 symbols) in an earlier session, and most recently to
**all NYSE-listed common stock** (1,399 additional symbols, ingested
this session).

**Data quality caveat, by design, not an oversight:** Alpaca's asset API
has no security-type field anywhere — common stock, ETFs, closed-end
funds, SPAC shells, LPs, and preferred shares are all indistinguishable
except by parsing the company name string. The NYSE ingestion used a
best-effort name-keyword filter (excludes "preferred", "fund", "trust",
"etf", "acquisition corp", "merger corp", bond/note/certificate
language, etc.) that got ~1,737 of 2,924 raw NYSE assets down to
plausible common stock. It's known to still leak a small number of
edge cases (e.g. one structured-note ticker slipped through) and could
theoretically exclude a legitimate name that happens to match a filter
keyword. The user explicitly chose to ship this heuristic list over
pausing to add a proper security-master data vendor — see chat history
for that decision. `symbols.name` is populated for all 1,911 via
Alpaca's asset endpoint (that part is reliable, unlike security type).

One known real gap: **`BRK.A`** (Berkshire Hathaway Class A) returns
zero bars from Alpaca's free IEX feed at any date range tested —
confirmed via direct API calls, not a bug in this project's code. Its
extreme per-share price likely puts it outside IEX's free-tier
coverage. No fix applied; flagging so it isn't mistaken for a pipeline
bug later.

### `eod-scan` at the ~1,911-symbol scale — fixed and CONFIRMED

**Two real bugs were found and fixed in `netlify/functions/eod-scan.ts`
and `netlify/functions/lib/alpaca.ts` (committed in `0abdbb2`), and a
clean end-to-end run has now been confirmed** — `job_runs` id 416
(2026-09-08 14:26 UTC): `status='ok'`, `rows_processed=1906`, 3m19s, no
error, run locally against the committed code while the intraday jobs
were concurrently hitting Alpaca. 13,950 `trigger_evaluations` rows were
written in batches with no statement timeout. 1,906 of 1,911 active
symbols got a `factor_state` row for 2026-09-08; the 5 missing are all
expected — `BRK.A` (known zero-bars issue) plus four very recent
listings with 14–28 bars of history, far short of the 200/252-day factor
lookbacks. No further action needed here; the section below is kept for
the record.

Note: the `factor_state` upsert does not refresh `computed_at` on the
UPDATE path (the column default only fires on INSERT), so `computed_at`
is not a reliable "last run" marker — use `job_runs` instead.

**Bug 1 — PostgREST's silent ~1,000-row cap** (the exact same class of
bug already found once this session in `MarketBreadth.tsx`): `eod-scan`'s
initial `symbols` query had no `.range()` pagination, so at 1,911 active
symbols it silently returned only ~1,000 of them with no error. Fixed
with the same `.range()`-loop pattern already used elsewhere in this
codebase.

**Bug 2 — unbatched `trigger_evaluations` insert**: at the new scale
this is ~8,000-9,500 rows per run, each carrying a full factor_state
JSON snapshot, inserted as one unbatched statement — confirmed hitting
Postgres's `statement timeout` (error code `57014`) once bug 1 was
fixed and the full universe actually flowed through. Chunked into
5,000-row batches, same pattern already used for `bars_daily`.

**Also changed** (defensive, not confirmed necessary on their own,
but reasonable given the same investigation): the Alpaca chunk-fetch
step's concurrency was unbounded (`Promise.all` over every chunk at
once) — capped at 3 concurrent via a small `mapWithConcurrency` helper.
`fetchBars` in `lib/alpaca.ts` had zero retry logic — a single
transient 429 used to abort the *entire* scan, throwing away every
chunk already fetched; it now retries with exponential backoff before
failing. Chunk size was also dropped from 100 to 25 tickers after
directly observing that very-large-multi-symbol/many-page Alpaca
requests silently returned incomplete symbol coverage (confirmed via
direct API calls: a 100-ticker chunk returned data for only ~52% of its
own tickers with no error and a `next_page_token` still present, while
the exact same tickers requeried as a 10-symbol/3-page request all came
back complete) — this may turn out to be redundant with bug 1's fix
once verified, but was evidence-based at the time and is safe either way.

**How it was verified (2026-09-08):** ran the function locally against
the committed code, mid-session, while the intraday jobs were still
hitting Alpaca — `job_runs` id 416 came back `status='ok'`,
`rows_processed=1906`, and `factor_state`/`trigger_evaluations` for the
day matched (see the summary at the top of this section). The scheduled
cron (`30 21 * * 1-5`, ~30 min after market close) exercises the same
path daily; check `job_runs` if anything looks off.

Note: this can also be tested by running the function locally (bypasses
Netlify's scheduled-function access restriction — direct HTTP calls to
`/.netlify/functions/eod-scan` return 403 for non-Netlify-internal
callers, which is correct security behavior, not a bug):
```bash
npx tsx -e "import runEodScan from './netlify/functions/eod-scan'; runEodScan().then(r=>r.text()).then(console.log).catch(console.error)"
```
(needs `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ALPACA_API_KEY_ID`,
`ALPACA_API_SECRET_KEY` in the environment — source `.env` first).

### Worker status — resolved in an earlier session, one manual step still pending, one re-check needed

`worker/` (the persistent Alpaca-websocket outlier detector) **must run
on the one dedicated, always-on Mac mini** — not on any laptop, and not
on Netlify (see `worker/README.md` for why it structurally can't run
there). A prior session hit a real hostname collision between two
machines both reporting `Chris-Ks-Mac-Mini`; the correct host was
positively identified as hostname `Mac-mini`, serial `QLPQFQPRXP`,
model Mac14,12 (M2 Pro). Re-verify by serial, not hostname, if there's
ever doubt again.

**Still pending — needs an interactive terminal (sudo password):**
```bash
sudo scutil --set ComputerName "StackSlash-Worker-Host"
sudo scutil --set HostName "stackslash-worker-host"
sudo scutil --set LocalHostName "stackslash-worker-host"
```

**Newly relevant given the universe expansion:** the worker was last
verified subscribing to Alpaca's websocket for the original 8-symbol
list. Whether it subscribes to the *current* active universe (now
1,911 symbols) dynamically or needs a restart/resubscribe logic check
has not been re-verified since the S&P 500 or NYSE expansions — worth
confirming its subscription list matches `symbols` before trusting
`realtime_outlier_zscore` fires across the full universe.

### Open decisions — need a human call, not a default

1. **NYSE ingestion's name-keyword filter is imperfect** (see "Universe"
   above) — ship as-is and clean up noise if/when it shows up in the
   feed, or invest in a real security-master data source later.
2. **Fundamentals/estimates data source** (Polygon, Finnhub, etc.) is
   still needed before `earnings_surprise_drift` can ever fire — Alpaca
   doesn't cover this.
3. **Exit tracking (`shadow_positions`) only covers
   `momentum_rank_entry`/`momentum_breakout`.** The other trigger
   categories have different holding-period logic and were deliberately
   left out — manual position tracking (tying real trades to alerts)
   was the proposed next step beyond the current auto-tracked "shadow"
   approach.
4. **Two of the three short/bearish triggers are now disabled**
   (`bb_rsi_confluence_short`, one other) after the backtest showed
   negative historical expectancy for shorting "overbought" signals in
   this universe — `volatility_squeeze_breakout_short` (squeeze) was
   left enabled per an explicit user call. Revisit if the backtest
   picture changes with the much larger universe.

### Outstanding items — everything not finished, in one place

Action items:
- [x] **Verify `eod-scan` completes cleanly at the ~1,911-symbol scale
  and commit the pending fixes** — done: fixes committed in `0abdbb2`,
  clean run confirmed 2026-09-08 (`job_runs` id 416).
- [x] Redeploy the realtime worker on the confluence-gate code and give
  it a sane subscription set — done 2026-09-08. It had been streaming
  only the original 8 mega-caps (subscribed back when the universe *was*
  8 symbols and never re-queried); asking for all ~1,900 got the Alpaca
  free-IEX stream rejected ("symbol limit exceeded"). Now watches
  `WORKER_MAX_STREAM_SYMBOLS` (28): tracked symbols + top dollar-volume.
  Fires confirmed routing through `confluence-gate` → `pending_fires`.
  Open sub-item: a paid Alpaca SIP plan would lift the ~30-symbol cap if
  full-universe realtime coverage is ever wanted.
- [x] Give the worker host a distinct hostname — done (`stackslash-worker-host`).
- [ ] Clean up stale `job_runs` row id 365 (`realtime-outlier-worker`,
  stuck at `status='running'` from a failed 12:02 UTC process on
  2026-09-08 — a one-line `update job_runs set status='error' …`).
- [ ] Add a fundamentals/estimates data vendor to unblock
  `earnings_surprise_drift` (still the only enabled trigger with no
  backtest history, and now also the only long trigger that can never be
  a confluence partner)
- [x] Run `backtest-triggers` against the full expanded universe — done
  2026-09-08 (local chunked re-run; `finalize_backtest_stats` doesn't
  bump `trigger_stats.computed_at` so that column still reads 09-04, but
  the numbers are fresh). Two stale rows remain for the disabled
  `bb_rsi_confluence_short` / `macd_bearish_cross` (finalize doesn't
  prune stat rows whose raw returns were cleared) — harmless, they can't
  fire, but worth a one-line `delete from trigger_stats …` cleanup.
- [ ] Confluence gate: verify a real ≥2-trigger cluster promotes and a
  ≥3 cluster sends a `HIGH PRIORITY` Discord alert, end to end, after
  deploy. The decision layer (`planClusters`) is unit-checked; the DB
  wiring and the deployed `confluence-gate` endpoint are not yet
  exercised against live fires.

Design/scope decisions (need a call before building):
- [ ] Whether to invest in a real security-type data source to clean up
  the NYSE universe's name-keyword-filter noise (Open decisions #1)
- [ ] Extend exit tracking beyond momentum triggers, or move to real
  manual position tracking (Open decisions #3)

Smaller known gaps (not blocking):
- [ ] `intraday-scan`'s volume-vs-average still uses the daily bar as a
  proxy rather than the populated `bars_intraday`
- [ ] Edge-function-level auth gating (`AuthGuard.tsx` TODO) — current
  client-side + RLS gate is fine for single-user, not hardened for
  multi-tenant
- [ ] Outlier worker's small-sample z-score reliability at low tick
  counts (`worker/README.md` has the tuning knobs)

Backlog (research-identified, not started):
- [ ] Multi-Timeframe Trend Agreement
- [ ] Candlestick Reversal at a Level
- [ ] Estimate-Revision Breakout (blocked on the fundamentals gap above)

### Everything built, roughly in the order it happened

1. Two research bundles analyzed → two-tier architecture designed
2. Repo scaffolded: Vite+React frontend, Netlify Functions backend,
   Supabase schema+RLS, 8-symbol seed universe+triggers, deployed
3. `eod-scan`/`intraday-scan` verified against real data; fixed a bug
   where `intraday-scan`'s momentum-candidate gate was bypassed by
   `eod-scan` evaluating the same triggers unrestricted
4. 5-year historical backfill + full chart range toggle
   (Day/Week/Month/Year/5-Year); Day needed its own ingestion job
   (`intraday-bars-scan.ts`)
5. Dossier display rebuilt into readable labeled cards; trigger feed
   regrouped by day; branding pass (dark-navy theme, logo)
6. Realtime outlier worker built (`worker/`) — persistent websocket,
   EWMA z-score outlier detection, `launchd` deployment
7. Three more triggers from the research backlog: Volatility Squeeze
   Breakout, Momentum Breakout, MACD Cross (bullish/bearish)
8. Exit triggers via auto-tracked `shadow_positions`; plain-English
   trigger labels (`lib/triggerInfo.ts`) + `/about` page
9. Real backtest engine (`backtest-triggers.ts` + shared
   `dailySnapshot.ts`) replacing a placeholder score with actual
   historical win-rate/expectancy, blended with live confirmation —
   surfaced the (now-resolved) unreachable-threshold issue and the
   negative-expectancy short triggers as real findings
10. **Universe expanded to the full S&P 500** (512 symbols) — storage/
    retention math done first, then the expansion + a full backfill +
    backtest re-run
11. UI polish pass: symbol search with on-demand onboarding
    (`SymbolSearch.tsx`, `onboard-symbol.ts` — validates via Alpaca,
    backfills history, runs a real `eod-scan` in-process so a newly
    searched symbol gets correctly cross-sectionally-ranked factors
    immediately), a live "profile workup" per symbol
    (`SymbolProfile.tsx` — current factor snapshot + real backtested
    stats per trigger), Day-chart last-open-session fallback, viewport
    centering/spacing pass
12. Confluence scoring (`lib/confluence.ts` — flags when multiple
    distinct triggers fire for the same symbol same day) + disabled the
    two negative-expectancy short triggers per an explicit user
    decision, left the squeeze short enabled
13. Dark-themed PNG performance report generator (`Reports.tsx`, manual
    Canvas API drawing, no new dependency)
14. Market breadth indicators on the dashboard (`MarketBreadth.tsx` —
    % above 200DMA, advancers/decliners, avg 1-week return) — surfaced
    and fixed the PostgREST 1000-row silent cap for the first time
    (client-side `.range()` pagination)
15. **Root-caused and fixed a real duplicate-data bug**: `eod-scan.ts`
    had a comment claiming a cooldown check happened per-fire, but no
    such check existed in code — every repeated scan re-inserted
    `trigger_events` unconditionally. Found via CIEN showing multiple
    identical dossiers with only the timestamp differing; confirmed 326
    of 407 `trigger_events` were redundant (125 had already gone out as
    duplicate Discord alerts); cleaned up via a `ROW_NUMBER()`-based
    migration (kept newest per symbol+trigger, cascaded to dossiers/
    alerts/shadow_positions); built `lib/cooldown.ts` and wired it into
    both `eod-scan.ts` and `intraday-scan.ts` as the real fix; verified
    the fix holds by onboarding a fresh symbol (re-triggering a full
    scan, the same mechanism that caused the bug) and confirming
    duplicate counts stayed flat
16. Hover tooltips across the UI for trigger names and factor/market
    metrics (`InfoTooltip.tsx` — portal-rendered + `position: fixed` so
    it isn't clipped by any scrolling container, pulling text from the
    existing `FIELD_META`/`TRIGGER_INFO` single sources of truth rather
    than new hardcoded strings)
17. Trigger status proximity bars (`ProximityBar.tsx`,
    `lib/triggerProximity.ts` — continuous "how close to firing" reading
    per trigger, dark→bright green for entry triggers, dark maroon→
    bright red for `momentum_exit`, shown whenever a symbol has an open
    shadow position) + company name/description on the symbol page
    (`CompanyDescription.tsx`, Wikipedia's free summary API, no new
    paid vendor) — `symbols.name` backfilled for all symbols via Alpaca
18. **Universe expanded again to all NYSE-listed common stock**
    (1,399 more symbols, name-keyword-filtered from Alpaca's raw NYSE
    listing) + full 5-year historical backfill (1.59M rows) — see
    "Universe" and "Immediate next step" above for the full story,
    including the two real `eod-scan` scale bugs this surfaced
19. **Confluence gate** (`lib/confluenceGate.ts`, `confluence-gate.ts`,
    `pending_fires` table, `triggers.direction`, `trigger_events.priority`)
    — the "trigger point" moved off the raw per-fire `trigger_events`
    insert. Every source (eod-scan, intraday-scan, worker) now stages
    fires in `pending_fires`; a fire is promoted to a single
    `trigger_event` (→ one dossier, one alert) only when ≥2 distinct
    same-direction triggers cluster on a symbol inside a ~30h window, and
    a ≥3 cluster is tagged `HIGH PRIORITY`. Also: `trigger_stats` re-run
    against the full universe; the two field-label tweaks
    (`200-DAY MAΔ`, `BMP 6MO`); `src/lib/confluence.ts` (client-side
    confluence) retired.
20. **Per-symbol quote tags** (`quotes.ts` function → Alpaca snapshots,
    `QuoteTag.tsx` + `useQuotes`) — `$price` / `±x%` since the open, green
    up / red down. On the symbol page it's a combined tag next to the
    ticker; in the trigger feed the price and change are their own
    columns. The `MarketBreadth` panel was pulled off the dashboard for
    now (component kept, just not rendered — see `Dashboard.tsx`); it had
    first been moved to a cached + manual-refresh load.
21. **Dashboard live sidebar + feed rework.** `TopMovers` (right-hand
    column): the day's Top-20 gainers / Top-20 losers via the
    `top_movers()` Postgres RPC over `bars_intraday` (% from the open,
    ~1-min refresh, no Alpaca call, ~900-name coverage).
    **Trigger feed** now merges two sources — the confluence gate's
    promoted cluster events (`trigger_events`) *and* un-promoted
    single-trigger fires (`pending_fires`, shown with a `pending` status).
    Every fire shows; rows are **flagged** by how many distinct triggers
    agreed (2 → a `2 signals` badge, 3+ → the high-priority treatment).
    Still scoped to symbols at **$50/share or less**; under **$5** gets an
    `UNDER $5` flag (feed badge, dossier badge, `🔻 UNDER $5` in the alert
    — deep-dive does one snapshot call for the price). Also: `trigger_events`
    and `pending_fires` added to the realtime publication (only
    `tracked_symbols` was in it — the feed had only ever refreshed on
    mount).
23. **Alert exclusion list** (`symbols.alert_excluded`). Flagged symbols
    — seeded with 22 mega-cap blue chips (NVDA, MSFT, AAPL, AMZN, GOOGL,
    GOOG, META, TSLA, AVGO, BRK.B, LLY, JPM, V, WMT, MA, XOM, JNJ, PG,
    HD, COST, ORCL, NFLX) — never produce a promoted `trigger_event`,
    dossier, Discord alert, or feed row, and the realtime worker skips
    streaming them. One-liner to edit:
    `update symbols set alert_excluded = <bool> where ticker = 'XYZ'`
    then restart the worker. Enforced in `confluenceGate.promotePending`,
    `deep-dive` (covers the non-gated `momentum_exit` path), `TriggerFeed`,
    and the worker's symbol selection. `TopMovers` / quote tags / symbol
    pages are unaffected — the exclusion is about signal output, not
    market data.
22. **Tracking panel** (`tracked_symbols` table, `TrackingPanel.tsx`).
    Above the trigger feed: search a ticker, hit Track, and it gets a
    persisted card with a live mini price chart that repolls every 60s
    (history from `bars_intraday`, live tip from the `quotes` function).
    `tracked_symbols` is the first client-writable table — RLS
    `to authenticated` for select/insert/delete, single-user trust model.
    `useQuotes` gained an optional `pollMs`.

## Stack

- **Supabase** (`wnzxvdfskmivbyqadtll`, org StackSlash) — Postgres, Auth, Realtime
- **Netlify** — static/SSR frontend + Scheduled Functions as the job runner for daily/intraday scans
- **Alpaca Market Data API** — paper keys are sufficient (no funded account needed for data-only use)
- **`worker/`** — a separate always-on process (Mac mini via `launchd`, or Fly.io) holding a live Alpaca websocket for real-time outlier detection; see `worker/README.md`. Not part of the Netlify deploy.

## Repo layout

```
src/                      Frontend (Vite + React + Supabase client)
  pages/                  Login, Dashboard, SymbolDetail, Reports, About
  components/             AuthGuard, RegimeBanner, TriggerFeed, DossierCard,
                           SymbolSearch, SymbolProfile, QuoteTag (+useQuotes),
                           TopMovers (sidebar, top_movers() RPC),
                           TrackingPanel (watchlist + live mini charts),
                           MarketBreadth (built, not currently rendered),
                           InfoTooltip, ProximityBar, CompanyDescription
  lib/                    Supabase client, shared TS types, triggerEval.ts
                           (client-side port of triggers.ts, display-only),
                           triggerProximity.ts, triggerInfo.ts (plain-English
                           labels, single source of truth), factorFormat.ts
                           (field labels/formatters, shared with dossiers).
                           Confluence is no longer computed client-side —
                           it's recorded on the trigger_event by the
                           confluence gate (see below); the UI just reads
                           snapshot.confluence.

netlify/functions/
  eod-scan.ts             Job A — daily bars, factor_state, momentum ranking,
                           regime_state, non-technical/non-exit trigger
                           evaluation, shadow_positions open/close. Fires go
                           through the confluence gate (see below), not
                           straight to trigger_events. Scheduled ~30min
                           after close. Confirmed clean at the full
                           ~1,911-symbol scale (2026-09-08).
  confluence-gate.ts     HTTP entry point for lib/confluenceGate.ts — used
                           by the realtime worker (which can't import the
                           lib). eod-scan / intraday-scan call the lib
                           in-process instead.
  intraday-scan.ts        Job B — polls snapshots for top-momentum names,
                           evaluates technical-category triggers only, on that
                           candidate set only, cooldown-gated. Scheduled every
                           10min during market hours.
  intraday-bars-scan.ts   1-min bars, whole active universe, every 5min
                           during market hours — populates the Day chart range.
  onboard-symbol.ts       On-demand symbol onboarding (search box) — validates
                           via Alpaca, backfills history, runs eod-scan
                           in-process so the new symbol gets real
                           cross-sectionally-ranked factors immediately.
  backfill-history.ts     Manually-triggered deep historical pull (default:
                           5 years back) for the 5-Year chart range.
  backtest-triggers.ts    Manually-triggered: replays every backtestable
                           trigger against 5yr history, writes trigger_stats.
  deep-dive.ts            Job C — HTTP-triggered by a Postgres trigger on
                           every trigger_events insert. Scores from
                           trigger_stats (blended across the cluster's
                           triggers) + live confirmation, writes a dossier,
                           dispatches an alert; tags 'high' priority
                           (3+ confluent triggers) in the Discord message.
  send-alert.ts           Manual/test alert dispatch for an existing dossier.
  quotes.ts               GET ?symbols=A,B,C -> { A: {price, changePct} }
                           from Alpaca snapshots; changePct is since
                           today's open. Feeds the UI's per-symbol quote
                           tags. One batched call, 30s edge cache.
  lib/
    supabaseAdmin.ts       Service-role client (server-only, bypasses RLS)
    alpaca.ts               Alpaca REST client — bars, snapshots, asset
                             lookup (validateSymbol, now also returns name);
                             fetchBars retries with backoff on 429
    indicators.ts           Pure math: returns, SMA/EMA, RSI, Bollinger, vol,
                             percentile rank, MACD cross, 20d-high, etc.
    dailySnapshot.ts         Shared factor computation — used live by
                             eod-scan AND by backtest-triggers
    triggers.ts               Declarative trigger definition evaluator
    cooldown.ts                filterByCooldown() — real cooldown enforcement
                                against the most recent trigger_event per
                                (symbol, trigger), used by eod-scan and
                                intraday-scan
    confluenceGate.ts          stageAndPromote() / promotePending() — the
                                real trigger point. Fires land in
                                pending_fires; only a cluster of >=2 distinct
                                SAME-direction triggers for one symbol within
                                a rolling window is promoted to a single
                                trigger_event (>=3 -> priority 'high'). Pure
                                decision layer (planClusters) is separated
                                out. Shared by eod-scan, intraday-scan and
                                confluence-gate.ts.
    backfillSymbol.ts           backfillSymbolBars/backfillLatestIntradaySession
                                — shared by backfill-history and onboard-symbol
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
   don't fire automatically in dev and also refuse direct external HTTP
   calls even in production (403) — invoke them by importing and calling
   the default export directly (see "Immediate next step" above for the
   exact `tsx` one-liner), not via curl.

5. **Deploy.** Connect this repo to a new Netlify site (or `netlify init`),
   set the env vars in the Netlify UI, and push. `netlify.toml` already
   defines the build command, publish dir, SPA redirect, and the scheduled-
   function cron expressions.

6. **The deep-dive webhook is already wired — nothing to do here.** Built
   directly with `pg_net`: a Postgres trigger (`deep_dive_webhook` →
   `public.notify_deep_dive()`) fires on every `trigger_events` insert and
   POSTs to the deployed `deep-dive` function. Part of the Supabase
   migration history, not a manual step.

## What's real vs. placeholder

**Real and functional:** schema/RLS/1,911-symbol universe across 9 enabled
triggers; `eod-scan`/`intraday-scan` real factor computation, cross-
sectional ranking, regime signal, cooldown-gated trigger evaluation
(confirmed clean at the full ~1,911-symbol scale on 2026-09-08);
**the confluence gate** — a fire becomes a trigger_event/dossier/alert
only as part of a cluster of ≥2 distinct same-direction triggers for one
symbol within a rolling ~30h window, across all three fire sources; a
cluster of ≥3 is tagged 'high' priority in the Discord alert and the UI.
Standalone single-trigger fires are recorded in `pending_fires` and go no
further — including standalone momentum entries, which no longer open
shadow positions. `intraday-bars-scan` populating the Day chart; 5-year
backfill for the whole universe; the realtime outlier worker (websocket
subscription list not yet re-verified against the full universe);
shadow-position exit tracking; the dossier/alert pipeline end to end;
`backtest-triggers` + real `deep-dive.ts` scoring (per-trigger stats
blended across the cluster; `trigger_stats` re-run against the
1,911-symbol universe on 2026-09-08 — momentum win rates came down
noticeably vs the S&P-500-only run, ~0.55 → ~0.53, the bigger/noisier
universe diluting the edge); symbol search/on-demand onboarding; per-symbol profile
workups with live proximity bars; PNG performance reports; per-symbol
`$price | ±x%` quote tags (feed + symbol page); the dashboard's live
Top-20 gainers / Top-20 losers sidebar (`top_movers()` Postgres function
over `bars_intraday`, % from the open, ~1-min refresh, ~900-name
coverage); hover tooltips; company name/description. (Market breadth is
built but pulled from the dashboard for now.)

**Placeholder / not yet built:** `factor_state.sue`/`est_revision_30d`/
`book_to_market` etc. never populated (no fundamentals vendor) —
`earnings_surprise_drift` inert; exit tracking only covers
`momentum_rank_entry`/`momentum_breakout`; intraday-scan's volume-vs-
average still proxies off the daily bar; edge-function-level auth
gating (client-side + RLS is the real boundary today); the NYSE
universe's name-keyword filter has known small imperfections (see
"Universe" above).

**Confirmation logic & backtest history — real, with known shallow spots
(not placeholders):**
- `deep-dive.ts`'s live confirmation checks the same three generic
  signals (trend intact, volume confirming, favorable regime) for every
  trigger regardless of what it is. A per-category confirmation rule set
  (breakout → the level held; momentum → 12-1 rank persisted) would make
  it sharper.
- `realtime_outlier_zscore` and `momentum_exit` have no `trigger_stats`
  by design — one is tick-level (can't replay from daily bars), the
  other is position-state-dependent. deep-dive falls back to
  live-confirmation-only for them. A "realized outcomes" job that
  records the forward return N days after each real live fire would let
  their expectancy accumulate from production instead.
- The confluence blend in deep-dive is a sample-size-weighted average of
  the contributing triggers' individual stats — there's no
  backtest of "these two co-fired," which would be a materially bigger
  piece (the gate's clustering would have to be replayed against history).

## Trigger backlog

- **Multi-Timeframe Trend Agreement** — EMA stack aligned daily *and*
  weekly, pullback to the fast EMA, RSI resets to 40-50. Needs
  weekly-timeframe bars/EMAs.
- **Candlestick Reversal at a Level** — hammer / bullish engulfing /
  rising window at a support/MA level, volume-confirmed. No new data
  source needed (full OHLC already in `bars_daily`), just pattern logic.
- **Estimate-Revision Breakout** — blocked on the same fundamentals gap
  as `earnings_surprise_drift`.

## Backtesting

`backtest-triggers.ts` replays every backtestable trigger's real
declarative definition against 5 years of `bars_daily` history via the
shared `dailySnapshot.ts` factor module, and writes real win-rate/
expectancy numbers into `trigger_stats`. Not scheduled — re-run
manually whenever a trigger's definition or `dailySnapshot.ts` changes,
or when the universe changes materially (it's due for a re-run now,
post-NYSE-expansion):

```bash
curl -X POST https://stackslash.netlify.app/.netlify/functions/backtest-triggers
```

`indicators.ts` and `triggers.ts` still have no I/O dependencies by
design, which is exactly what made this reusable rather than a
duplicated implementation.
