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

**Most recent work: session of 2026-09-09 — see the section immediately
below.** The rest of this handoff (research bundles, universe growth,
the eod-scan scaling fix, worker status) is from earlier sessions and is
still accurate.

### Session 2026-09-09 — what shipped (PRs #18–#31, all merged & deployed)

The account is now trading a real **$40** balance on **sub-$3 penny
stocks**, so this session's throughline was: make the feed actually
produce penny-tier signals, wrap every signal in enough context (news,
fundamentals, risk flags) to not get run over, and give the user a
screener to hunt setups directly. Netlify was upgraded to **Pro** partway
through (unlocks background functions, lifts the build-minute cap that
was queuing deploys).

**Fundamentals — two free sources, wired end to end**

- **#18 — FMP moved to the `/stable/` API.** The legacy `/v3/` endpoints
  are dead for accounts created after Aug 2025. `lib/fmp.ts` now uses
  `/stable/profile?symbol=X` (one symbol per call — batch form returns
  `[]`) and `/stable/earnings-calendar` (no `from`/`to` on the free tier:
  a trailing ~3-month window of *reported* quarters, no forward
  calendar). `fundamentals-sync.ts` reworked: one calendar call →
  `earnings.surprise_pct`; a ~90-symbol/run profile sweep into
  `symbols.sector/industry/market_cap/is_etf/is_fund/is_adr`.
  `deep-dive.ts` fetches a symbol's profile on demand if it fired before
  the sweep reached it. Migration `fmp_free_tier_profile_and_surprise`
  adds `factor_state.surprise_pct`, `symbols.is_adr/is_fund`, and re-keys
  `earnings_surprise_drift` off `surprise_pct >= 0.10` (full SUE needs
  per-symbol history, a paid endpoint). **No forward earnings calendar on
  FMP free** → the "earnings in N days" flag and `suppress_earnings_days`
  can't work from FMP.
- **#28 — DoltHub financials.** The `post-no-preference/earnings` dataset
  (Zacks-derived, ~10k US symbols, updated weekly, CC BY-SA 4.0) covers
  the gap. `lib/dolthub.ts` reads it over the public SQL-over-HTTP API
  (no auth; optional `DOLTHUB_TOKEN` env for rate-limit headroom;
  responses cap at 1,000 rows so every pull paginates).
  `lib/fundamentalsDolt.ts` pulls quarterly balance sheets, income &
  cash-flow statements, the **forward earnings calendar**, and Zacks
  analyst ranks for the active universe (~100 requests, ~2 min) and
  reduces to one `fundamentals` row per symbol: cash, net cash, book
  equity, **cash runway in quarters** (cash ÷ avg quarterly operating-
  cash burn), **share dilution YoY**, revenue growth YoY,
  net-cash-to-market-cap, book-to-market, next earnings date, Zacks rank
  + value/growth grades. Forward earnings dates also upsert into
  `earnings` (revives the imminent-earnings flag + `suppress_earnings_days`).
  Runs as `refresh-fundamentals-background.ts` — a Netlify **background**
  function (15-min ceiling) triggered by a weekly launchd job
  (`scripts/launchd/com.stackslash.refresh-fundamentals.plist`, Mondays)
  and the **"Refresh financials" button on `/settings`** (polls
  `job_runs` for completion). Migration `add_fundamentals_table`. First
  sync: 4,869 symbols, 1,555 with a runway estimate.

**Isolator screener — `/isolator` (#23)**

A screener over the whole tracked universe. A screen's `spec` is a list
of AND-ed conditions, each either `snapshot` (a current `factor_state`
column) or `window` (a trailing 20- or 40-session aggregate). Backed by:

- `screen_symbols(spec jsonb)` — Postgres, `security invoker`, granted to
  `authenticated`; ~0.5 s for a full-universe run. Helper `screen_cmp`.
- `factor_window_stats` — one scalar row per `symbol × window_len ×
  metric` (~180k rows, ~25 MB), rebuilt nightly by
  `refresh_factor_window_stats()` (all ~18 metrics recomputed from
  `bars_daily` OHLCV — return, range position, volume delta/slope, price
  slope, realized vol, up-day %, avg/now/Δ Bollinger width, avg/now RSI,
  …). `refresh-window-stats.ts` scheduled 23:00 UTC weekdays.
- `screens` table (RLS: `is_preset` rows read-only) + **7 seeded presets**
  — coiled spring, quiet accumulation, volatility contraction, washout
  bounce, range breakout watch, fresh momentum leader, penny setups for a
  $40 account.
- `src/lib/screenFields.ts` (field catalogue + spec ↔ RPC helpers),
  `src/pages/Isolator.tsx` (builder, saved searches, CSV export).

Deferred: trailing aggregates of *non-price* factor columns (avg
momentum-rank over 40 sessions, etc.) — `factor_state` only started
keeping daily history this month, so there's nothing to aggregate yet.
The nightly job and schema are ready for it.

**intraday-scan was 100% dead during market hours — fixed (#24, #25)**

`intraday-scan` queried `factor_state` / `regime_state` with `as_of =
today`, but `eod-scan` only writes the current date *after the close*.
So during every session the candidate query returned nothing and the job
silently no-op'd (`rows_processed: 0`) — it had effectively never
produced a technical-trigger fire during live hours. Now it resolves the
latest `as_of` and merges three candidate sources: top-third
cross-sectional momentum (the original design), **the liquid in-band
universe** (`last_close <= scan_config.price_max AND dollar_vol_20d >=
the floor`, top 800 by $ volume — the tradeable penny tier, which never
ranks by momentum) and tracked symbols. `trigger_evaluations` insert
batched. Verified against prod: produces sub-$3 oversold fires that
weren't happening before.

**News (#26, #27)**

Alpaca's `/v1beta1/news` (Benzinga) works on the paper keys.
`lib/alpaca.ts` gets `fetchNews()` — best-effort, returns `[]` on any
failure. Three consumers: `deep-dive.ts` attaches the symbol's last ~4
headlines to the dossier + the newest to the Discord alert, and a
"fresh news (Nh ago)" risk flag fires when the latest headline is within
24h; a public `news.ts` function (`GET ?symbol=X`, 5-min cache) feeds a
"Recent news" panel on the symbol page (`SymbolNews.tsx`). #27 puts the
symbol page's "Trigger status" and "Recent news" in an even 50/50 grid.

**Chart overhaul (#19, #20, #22)**

New `src/components/PriceChart.tsx` — gradient area fill, themed
grid/axes, dark tooltip with no series label. `src/lib/marketTime.ts` —
DST-correct ET helpers + a **piecewise intraday axis**: the "Day" chart
spans 4:00a–8:00p ET, but each extended-hours hour is drawn at **1/3 the
width** of a regular-session hour, hourly tick labels are fixed, and the
price line fills in from the left through the day. Week/Month/Year/Max
keep the categorical date axis.

**Trigger feed + flags (#21, #30, #31)**

- **#21** — the feed split by surface. Dashboard shows **today only** in
  one always-open frame (no per-day dropdown, no date header), the
  "Trigger feed" label moved inside the frame so it lines up with the
  Top-movers column. The Reports page (`/reports`) gets a "Trigger feed —
  earlier days" section with the collapsed per-day dropdowns.
- **#30** — dropped the **Trigger** (name) column (specifics are on the
  symbol page; **Category** kept), added a **Flags** column between Symbol
  and Price. It shows the confluence badge, a `Sub-$1` chip, and the
  linked dossier's **risk flags** as chips (feed query projects just
  `dossiers(risk_flags:analysis->risk_flags)`, not the whole analysis
  JSON). Flags are now **tri-colour by meaning, not severity**:
  `RiskFlag.level` gained `"green"` — positives (Zacks Buy/Strong Buy,
  revenue +25%+ YoY, net cash ≥35% of market cap) are green, clear
  negatives (offering-sized volume, nano-cap, ≤2Q runway, ≥50% dilution)
  red, two-sided/situational (earnings, news, biotech, parabolic, ADR,
  sub-$1) amber. Confluence badges are all green now (3+ signals was red).
- **#31** — de-dupe the sub-$1 chip (client-computed vs dossier flag) and
  stop sub-$1 from triggering the red row highlight (it's amber now).

Note: dossier flags only appear in the feed for events whose `deep-dive`
ran *after* the fundamentals/news code deployed — older rows show `—`.

**UI polish (#29)**

Settings form is a 2-column grid (was a 520px column pinned left). The
StackSlash wordmark links home on the Dashboard / Settings / Isolator
headers. Symbol page: a large last-price + `▲ +$0.04 (2.31%) today`
block replaces the small inline quote tag, and the quote polls every 30s
(was: once on load). Tracking-panel quote poll 60s → **15s** (chart-
series reload decoupled to 90s); `quotes` function edge cache 30s → 15s.

**Price-update cadence** (post-session): symbol page 30s, tracking panel
15s, trigger feed on load + on realtime insert, top movers 5 min.
Underlying feed is Alpaca IEX with a 15s edge cache. Alpaca's free limit
is 200 req/min — the frontend polls have enormous headroom (one batched
call each); `intraday-bars-scan` (every 5 min, ~50–150 chunked requests/
run) is the dominant consumer and should **not** be sped up.

**Manual steps still pending on the Mac mini / Netlify**

- Install the fundamentals launchd job:
  `cp scripts/launchd/com.stackslash.refresh-fundamentals.plist
  ~/Library/LaunchAgents/ && launchctl load
  ~/Library/LaunchAgents/com.stackslash.refresh-fundamentals.plist`.
  (`com.stackslash.eod-scan` and the worker are already loaded.) The
  `/settings` button covers the refresh until then.
- Optional: create a free `DOLTHUB_TOKEN` (dolthub.com → settings → API
  Tokens) and add it to the Netlify env + local `.env`. Not required.
- Confirm the Netlify `FMP_API_KEY` env var is the full 32-char value.

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
| Frontend + functions | Netlify **Pro**, site `stackslash` → https://stackslash.netlify.app | Live, auto-deploys from GitHub `main`. Pro unlocks background functions + lifts the build-minute cap. |
| Repo | https://github.com/cjaykohler-source/StackSlash | `main`, clean and pushed (through PR #31) |
| Database | Supabase project `wnzxvdfskmivbyqadtll` (org StackSlash), **free plan (500 MB)** | Live — see counts below. 419 MB used (of the 500 MB free-plan cap). |
| Market data | Alpaca, **paper** keys (IEX feed, ~200 req/min) | No funded account needed for data-only use |
| News | Alpaca `/v1beta1/news` (Benzinga) — same keys | Real-time headlines, headline-only on free tier |
| Fundamentals | FMP `/stable/` (free) + DoltHub `post-no-preference/earnings` (free) | Profiles + trailing calendar from FMP; balance sheet / cash flow / forward calendar / Zacks ranks from DoltHub → the `fundamentals` table |
| Alerts | Discord webhook, channel `#heating_up` (bot "HeatBot") | Working, verified with real fires |
| Auth | Single Supabase Auth user, `cjaykohler@gmail.com` | Working |
| Realtime outlier worker (`worker/`) | `launchd` on the Mac mini (`stackslash-worker-host`, serial `QLPQFQPRXP`) | Watches top ~28 by liquidity + tracked symbols (Alpaca free IEX websocket caps subs ~30). Fires route through `confluence-gate`. |
| eod-scan | `launchd` on the same Mac mini (`com.stackslash.eod-scan`, 17:45 ET weekdays) | Off Netlify — the scheduled function times out (~3-4 min) at ~5,000 symbols. `scripts/run-eod-scan.sh` + `scripts/launchd/`. |
| refresh-fundamentals | `launchd` on the same Mac mini (`com.stackslash.refresh-fundamentals`, Mondays) — **plist not yet installed** | POSTs the deployed background function weekly. Also driven by the `/settings` button. |

Current DB snapshot: **~5,000 active symbols** (NYSE 1,744 + NASDAQ 3,024
+ AMEX 231), `bars_daily` held to a rolling ~18-month window, 9 enabled
triggers. New tables this session: `screens`, `factor_window_stats`
(~25 MB), `fundamentals`.

### Universe — NYSE + NASDAQ + AMEX common stock (grown 8 → 512 → 1,911 → ~5,000)

Started at 8 hand-picked tickers → full S&P 500 (512) → all NYSE-listed
common stock (1,911 total) → **NASDAQ + NYSE American added** (2,858 +
230 more, 2026-09-08). `symbols.exchange` records the listing venue.

**Storage tradeoff:** the free Supabase plan caps the database at 500 MB.
A 5-year daily history for ~5,000 symbols doesn't fit, so `bars_daily` /
`bars_weekly` were pruned to a rolling ~18 months (from 2025-03-01) and
`prune-bars-daily.ts` (scheduled) holds that window. Consequences: the
symbol chart's "Max" range is ~18 months, and `backtest-triggers` runs
on ~1 evaluable year (after the 252-day factor warmup) instead of ~4.
Momentum ranking and all live triggers are unaffected. A Supabase Pro
upgrade ($25/mo, 8 GB) would restore the full 5-year depth.

**Data quality caveat, by design, not an oversight:** Alpaca's asset API
has no security-type field anywhere — common stock, ETFs, closed-end
funds, SPAC shells, LPs, and preferred shares are all indistinguishable
except by parsing the company name string. The NYSE and the later NASDAQ/AMEX ingestions both used a
best-effort name-keyword filter (excludes "preferred", "fund", "trust",
"etf"/"etn", "acquisition corp"/"merger corp", warrant/right/unit,
bond/note/debenture/certificate language, a "N%" coupon, etc.). It's
known to still leak a small number of edge cases and could theoretically
exclude a legitimate name that matches a keyword. The user chose to ship
this heuristic list over adding a proper security-master data vendor.
`symbols.name` and `symbols.exchange` come from Alpaca's asset endpoint
(reliable, unlike security type).

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
- [x] **Add a fundamentals/estimates data vendor** — done 2026-09-09 (PR
  #18 FMP `/stable/`, PR #28 DoltHub). `earnings_surprise_drift` is
  re-keyed off `surprise_pct` and the forward earnings calendar now comes
  from DoltHub. `est_revision_30d` / `book_to_market` on `factor_state`
  are still empty — the values live on the `fundamentals` table now, and
  wiring them onto `factor_state` (or joining `fundamentals` into
  `screen_symbols`) is the follow-up.
- [ ] **Install the `com.stackslash.refresh-fundamentals` launchd plist**
  on the Mac mini (see the 2026-09-09 session section). Until then the
  weekly financials refresh only happens if someone hits the `/settings`
  button.
- [ ] **Isolator × fundamentals** — join the `fundamentals` table into
  `screen_symbols` and add a `fundamental` scope to `screenFields.ts` so
  screens can filter on runway / dilution / Zacks rank / net-cash-to-
  mktcap.
- [ ] Parse gross margin from the DoltHub income statement (column pulled
  but `fundamentals.gross_margin` currently always null).
- [ ] Dossier flags in the trigger feed only populate for events whose
  `deep-dive` ran after the 2026-09-09 deploy — not a bug, just a data
  cutover; no action unless backfilling old dossiers is wanted.
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
  multi-tenant. RLS audit 2026-09-08: all 18 tables have RLS on,
  every read policy is `authenticated`-only, no `anon` access;
  `tracked_symbols` insert/delete use `USING (true)` (single-user trust
  model — needs `user_id = auth.uid()` scoping for multi-tenant, the way
  the unused legacy `watchlists` table already does it). Fixed the same
  day: 4 internal functions (`notify_deep_dive`, `rls_auto_enable`,
  `finalize_backtest_stats`, `refresh_bars_weekly`) were exposed as
  public PostgREST RPCs — `EXECUTE` revoked from anon/authenticated;
  `search_path` pinned on the two that lacked it; `bars_weekly` given
  the standard `authenticated read` policy.
- [ ] Drop the orphaned `public.watchlists` table (0 rows, nothing
  references it — the Tracking panel uses `tracked_symbols`). One-liner,
  just needs running: `drop table public.watchlists;`
- [ ] Enable Supabase Auth leaked-password protection (dashboard toggle)
- [ ] Outlier worker's small-sample z-score reliability at low tick
  counts (`worker/README.md` has the tuning knobs)

Backlog (research-identified, not started):
- [ ] Multi-Timeframe Trend Agreement
- [ ] Candlestick Reversal at a Level
- [ ] Estimate-Revision Breakout — DoltHub `eps_estimate` / `sales_estimate`
  (weekly) could feed this now; not yet wired into `fundamentalsDolt.ts`.

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
    column): the day's Top-35 gainers / Top-35 losers via the
    `top_movers()` Postgres RPC over `bars_intraday` (% from the open,
    5-min refresh, no Alpaca call — coverage = intraday-bars-scan's
    priority set).
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
    — seeded with SPY + 22 mega-cap blue chips (NVDA, MSFT, AAPL, AMZN,
    GOOGL, GOOG, META, TSLA, AVGO, BRK.B, LLY, JPM, V, WMT, MA, XOM, JNJ,
    PG, HD, COST, ORCL, NFLX) — never produce a promoted `trigger_event`,
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
24. **NASDAQ + AMEX added** (`symbols.exchange` column; 2,858 NASDAQ +
    230 AMEX new symbols → ~5,000 total). To fit the free 500 MB Supabase
    plan, `bars_daily` / `bars_weekly` were pruned to a rolling ~18 months
    (from 2025-03-01) and `prune-bars-daily.ts` (scheduled) holds that
    window; the chart's "Max" range and the backtest window shrank to
    match. `quotes.ts` also gained chunked fetching (the feed asks for
    300+ tickers at once) and the feed hides any row it can't price.
25. **eod-scan moved to `launchd`** on the Mac mini (Netlify's ~3-4 min
    scheduled-function timeout can't run it at ~5,000 symbols — it had
    been silently truncating to ~511). Also fetches only the last ~12
    sessions from Alpaca now, reading the rest of the factor window from
    `bars_daily`. `scripts/run-eod-scan.sh` + `scripts/launchd/`.
26. **Configurable targeting band** (`scan_config` singleton table,
    `/settings` page). The confluence gate only promotes a fire to a
    dossier + alert if the symbol is inside the band: price
    `[price_min, price_max]`, `dollar_vol_20d ≥ min_dollar_vol_20d`,
    `rsi14 ≤ max_rsi14` (longs), and `≥ min_confluence` distinct
    same-direction triggers. Tuned for the live experiment: a ~$40
    account trading **sub-$3** names, so `price_max = 3`,
    `min_dollar_vol_20d = 50k` (penny stocks are inherently thin), and
    `min_confluence = 1` (multi-trigger confluence on sub-$3 names is
    near-zero — the trigger set is tuned for normal equities; 2+/3+
    still flag as higher priority). Widen the band via `/settings` (or
    `update scan_config …`) as the account grows.

## Stack

- **Supabase** (`wnzxvdfskmivbyqadtll`, org StackSlash) — Postgres, Auth, Realtime
- **Netlify** — static/SSR frontend + Scheduled Functions as the job runner for daily/intraday scans
- **Alpaca Market Data API** — paper keys are sufficient (no funded account needed for data-only use)
- **`worker/`** — a separate always-on process (Mac mini via `launchd`, or Fly.io) holding a live Alpaca websocket for real-time outlier detection; see `worker/README.md`. Not part of the Netlify deploy.

## Repo layout

```
src/                      Frontend (Vite + React + Supabase client)
  pages/                  Login, Dashboard, SymbolDetail, Reports, Settings,
                           Isolator (screener), About
  components/             AuthGuard, RegimeBanner, TriggerFeed, DossierCard,
                           SymbolSearch, SymbolProfile, QuoteTag (+useQuotes),
                           PriceChart (range-toggle chart, intraday +
                           calendar variants), SymbolNews (Benzinga panel),
                           TopMovers (sidebar, top_movers() RPC),
                           TrackingPanel (watchlist + live mini charts),
                           MarketBreadth (built, not currently rendered),
                           InfoTooltip, ProximityBar, CompanyDescription
  lib/                    Supabase client, shared TS types, screenFields.ts
                           (Isolator field catalogue + spec helpers),
                           marketTime.ts (DST-correct ET + the piecewise
                           intraday chart axis), triggerEval.ts
                           (client-side port of triggers.ts, display-only),
                           triggerProximity.ts, triggerInfo.ts (plain-English
                           labels, single source of truth), factorFormat.ts
                           (field labels/formatters, shared with dossiers).
                           Confluence is no longer computed client-side —
                           it's recorded on the trigger_event by the
                           confluence gate (see below); the UI just reads
                           snapshot.confluence.

netlify/functions/
  eod-scan.ts             Job A — factor_state, momentum ranking,
                           regime_state, non-technical/non-exit trigger
                           evaluation, shadow_positions open/close. Fires go
                           through the confluence gate, not straight to
                           trigger_events. Scheduled ~30min after close.
                           At ~5,000 symbols it fetches only the last ~12
                           sessions from Alpaca (a 400-day pull was ~1,600
                           requests and reliably 429'd) and reads the rest
                           of the factor window from bars_daily.
  confluence-gate.ts     HTTP entry point for lib/confluenceGate.ts — used
                           by the realtime worker (which can't import the
                           lib). eod-scan / intraday-scan call the lib
                           in-process instead.
  intraday-scan.ts        Job B — evaluates technical-category triggers on a
                           bounded candidate set from the LATEST factor_state
                           (not as_of=today — that row doesn't exist mid-
                           session): top-third momentum ∪ liquid in-band
                           (price <= band ceiling, $ vol >= floor, top 800)
                           ∪ tracked. Cooldown-gated, batched inserts.
                           Scheduled every 10min during market hours.
  intraday-bars-scan.ts   1-min bars every 5min during market hours for a
                           PRIORITY set only (tracked symbols + today's
                           feed symbols + top ~300 by dollar volume, cap
                           1200) — a full ~5,000-symbol 1-min pull every
                           5min is thousands of Alpaca requests. Symbols
                           outside the set have no intraday history; the
                           Day chart and tracking cards fall back to daily.
  onboard-symbol.ts       On-demand symbol onboarding (search box) — validates
                           via Alpaca, backfills history, runs eod-scan
                           in-process so the new symbol gets real
                           cross-sectionally-ranked factors immediately.
  backfill-history.ts     Manually-triggered historical pull for the chart
                           range (`{start,tickers}` body; default 5y back,
                           but the retention window is ~18mo now).
  prune-bars-daily.ts     Scheduled daily — trims bars_daily / bars_weekly
                           to a rolling ~550-day window so the ~5,000-symbol
                           universe fits the free 500 MB Supabase plan.
  refresh-window-stats.ts Scheduled weeknights (23:00 UTC, after eod-scan) —
                           invokes refresh_factor_window_stats() to rebuild
                           factor_window_stats, the Isolator's trailing-window
                           metric table.
  refresh-fundamentals-background.ts
                           Background function (15-min ceiling). Pulls
                           quarterly financials + forward earnings + Zacks
                           ranks from DoltHub into the `fundamentals` table.
                           Triggered by a weekly launchd job and the
                           /settings "Refresh financials" button.
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
                           tags. Chunked (120/call), 30s edge cache.
  news.ts                 GET ?symbol=X -> recent Benzinga headlines for
                           one symbol (Alpaca /v1beta1/news). Public,
                           5-min edge cache. Feeds the symbol page's
                           "Recent news" panel.
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
    fmp.ts                     Financial Modeling Prep /stable/ client
                                (profile, trailing earnings calendar)
    dolthub.ts                 DoltHub SQL-over-HTTP read client (paginates
                                past the 1,000-row cap; optional DOLTHUB_TOKEN)
    fundamentalsDolt.ts        syncFundamentalsFromDolt() — pulls statements +
                                forward calendar + Zacks ranks -> `fundamentals`
    riskFlags.ts               riskFlags() (tri-colour red/amber/green) +
                                tradeSuggestion() — pure, feeds deep-dive
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

**Real and functional:** schema/RLS/~5,000-symbol universe across 9
enabled triggers; `eod-scan`/`intraday-scan` real factor computation,
cross-sectional ranking, regime signal, cooldown-gated trigger evaluation
(eod-scan confirmed clean at scale 2026-09-08; **intraday-scan's
market-hours bug fixed 2026-09-09** — it had been silently producing zero
fires during every live session, see the session section above);
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
blended across the cluster). **`trigger_stats` are now weak** — the
free-plan 18-month history window leaves only ~8 evaluable months after
the 260-day factor warmup, and the ~5,000-symbol universe is much
noisier than the S&P 500 it was tuned on. The 2026-09-08 re-run has
`momentum_rank_entry` at a *negative* 10-day expectancy (43.8% win,
-0.42% avg, 4.2k samples) vs ~0.53/+1.3% in the old 4-year/512-symbol
run; `bb_rsi_confluence_long` looks great (60.6%/+2.18%) but on the same
thin window. Treat all of these as directional, not reliable, until
there's either more history (Supabase Pro) or more elapsed time.
Symbol search/on-demand onboarding; per-symbol profile
workups with live proximity bars; PNG performance reports; per-symbol
`$price | ±x%` quote tags (feed + symbol page, the symbol page now with a
large price/change block that polls every 30s); the dashboard's live
Top-35 gainers / Top-35 losers sidebar (`top_movers_v2` Postgres function
over `bars_intraday`, % from the open, 5-min refresh, price-band-scoped);
the Tracking watchlist panel (15s quote poll); hover tooltips; company
name/description. (Market breadth is built but pulled from the dashboard
for now.)

**Fundamentals (FMP `/stable/`, free tier):** the legacy `/v3/` API is
dead for accounts created after Aug 2025; `lib/fmp.ts` uses `/stable/`.
Two things work on the free tier:
- `/stable/profile?symbol=X` — one symbol per call (batch form returns
  `[]`). `fundamentals-sync.ts` sweeps ~90 never-synced/stalest symbols
  per run into `symbols.sector/industry/market_cap/is_etf/is_fund/is_adr`;
  `deep-dive.ts` fills any gap on demand for a symbol that fires first.
- `/stable/earnings-calendar` — one no-param call, a trailing ~3-month
  window of **reported** quarters (no `from`/`to`, no forward calendar on
  this tier). Upserted into `earnings` with `surprise_pct` (epsActual vs
  epsEstimated). `eod-scan` copies the most recent report per symbol to
  `factor_state.surprise_pct` / `days_since_earnings`, which
  **activates `earnings_surprise_drift`** (keyed off `surprise_pct >=
  0.10` — full SUE needs per-symbol history, which is a paid endpoint).

FMP itself has no forward earnings calendar on the free tier — but the
**forward calendar comes from DoltHub now** (see "Financials" below), so
the "earnings in N days" flag and `suppress_earnings_days` do work.
FMP is down to just the profile + trailing surprise. Needs `FMP_API_KEY`
in the env.

**Isolator (`/isolator`):** a screener over the whole tracked universe.
A screen's `spec` (JSON) is a list of AND-ed conditions, each either
`snapshot` (a current `factor_state` column — RSI now, momentum rank now,
…) or `window` (a trailing aggregate over a 20- or 40-session lookback —
avg Bollinger width, volume high/low spread, window return, realized vol,
range position, price/volume slope, …). `screen_symbols(spec jsonb)`
(Postgres, `security invoker`, granted to `authenticated`) evaluates it
and returns the matches plus a `metrics` blob so the UI can show what
matched. Window metrics live in `factor_window_stats`
(one scalar row per symbol × window × metric), rebuilt nightly by
`refresh_factor_window_stats()` — all recomputed from `bars_daily` OHLCV,
so they carry the full ~18-month depth immediately (the `refresh-window-stats`
scheduled function just invokes it after eod-scan). ~25 MB. Saved and
preset screens are rows in `screens` (`is_preset` rows are read-only via
RLS); 7 presets seeded (coiled spring, quiet accumulation, volatility
contraction, washout bounce, range breakout watch, fresh momentum leader,
penny setups for a $40 account). Trailing aggregates of *non-price*
factor columns (avg momentum rank over 40 sessions, etc.) are a future
add — `factor_state` only started accumulating daily history in Sept 2026,
so there's nothing to aggregate yet.

**Financials (DoltHub, free):** `refresh-fundamentals-background.ts` +
`lib/fundamentalsDolt.ts` pull quarterly balance sheets, income &
cash-flow statements, the forward earnings calendar, and Zacks analyst
ranks from the DoltHub `post-no-preference/earnings` dataset
(CC BY-SA 4.0, updated weekly). Read-only SQL over HTTP —
`lib/dolthub.ts`; public repo needs no auth, an optional `DOLTHUB_TOKEN`
just raises rate-limit headroom. The API caps responses at 1,000 rows so
every pull paginates; a full sync is ~100 requests / ~2 min, so it's a
Netlify **background** function (15-min ceiling), triggered by a weekly
launchd job (`scripts/launchd/com.stackslash.refresh-fundamentals.plist`,
Mondays) and the "Refresh financials" button on `/settings` (which polls
`job_runs` for completion). One `fundamentals` row per symbol: cash, net
cash, book equity, **cash runway in quarters** (cash ÷ avg quarterly
burn), **share dilution YoY**, revenue growth, net-cash-to-market-cap,
book-to-market, next earnings date, Zacks rank + value/growth grades.
`deep-dive.ts` reads it → new risk flags (**≤2Q runway** red, **shares
+20%/+50% YoY**, negative book value) and a `📊` line on the alert;
forward earnings dates also land in `earnings`, reviving the
imminent-earnings flag + `suppress_earnings_days`.

**Placeholder / not yet built:** `factor_state.est_revision_30d` /
`book_to_market` unpopulated *on `factor_state`* (the values live on
`fundamentals` now — the Isolator will join that table in a follow-up);
gross margin not yet parsed from the Dolt income statement; exit
tracking only covers `momentum_rank_entry`/`momentum_breakout`;
intraday-scan's volume-vs-average still proxies off the daily bar;
edge-function-level auth gating (client-side + RLS is the real boundary
today); the name-keyword common-stock filter has known small
imperfections (see "Universe" above).

**News (Alpaca `/v1beta1/news`, Benzinga):** works on the paper keys —
real-time headlines, limited historical depth, headline-only (no body).
`lib/alpaca.ts`'s `fetchNews()` is best-effort (returns `[]` on any
failure, never blocks). Wired in three places: `deep-dive.ts` attaches
the symbol's last ~4 headlines to the dossier and the newest to the
Discord alert; a "fresh news (Nh ago)" risk flag fires when the latest
headline is within 24h (red ≤ 6h) — a catalyst-driven move has a
different risk profile than a quiet technical drift; the `news` function
(`GET ?symbol=X`, public, 5-min edge cache) feeds a "Recent news" panel
on the symbol page.

**Risk flags & risk-defined sizing:** every dossier + alert carries flags
from `lib/riskFlags.ts`, **tri-coloured by meaning** (red = negative for
the trade, amber = neutral / two-sided, green = positive):

- red: offering-sized volume (5× normal), nano-cap (< $50M), ≤2Q cash
  runway, ≥50% YoY dilution
- amber: fresh news (< 24h), imminent earnings (+ optional alert
  suppression), extreme volatility, parabolic run, > 100% above the
  200-DMA, sub-$1, foreign ADR, biotech, crypto-AI sector, negative book
  value, moderate runway (≤4Q) / dilution (≥20%)
- green: Zacks Buy / Strong Buy, revenue +25%+ YoY, net cash ≥ 35% of
  market cap

Plus a suggested stop + position size from `scan_config` (`account_size`,
`max_risk_pct`, `default_stop_pct`). In the trigger feed the dossier's
flags render in a **Flags column** (red → amber → green order). The
scanner still only sees price action; the flags don't substitute for a
thesis, but they colour-code the context around each fire.

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
