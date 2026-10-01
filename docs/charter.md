# Charter — the data visualizer

Started 2026-09-30. `/charter` on the site: interactive exploration of the
whole local research warehouse, for finding and checking signals. Phases 1
(symbol deep dive), 2 (cross-section), 3 (event studies) and 4 (aggregates)
are live; 5 (polish) is pending (README open item 44).

## Architecture

```
browser (r10t.netlify.app/charter, or local dev)
   │  fetch + Authorization: Bearer <Supabase access token>
   ▼
Tailscale Funnel https://stackslash-worker-host.tail3d8cea.ts.net   (public; tailnet devices reach it directly)
   ▼
Charter API      127.0.0.1:8787   research/charter_api/server.py    (launchd com.stackslash.charter-api, KeepAlive)
   ▼
research/data/   stackslash.duckdb (SIP daily), minute/ (SIP 1-min, ~740k files),
                 catalysts/, edgar/, charter/daily_metrics, charter/minute_index
```

- **Why local:** the warehouse (22M daily bars, 85 GB of minute bars,
  catalysts, short history) lives only on this Mac. The page is ordinary
  site code; only the API location changes if it ever moves (tunnel ->
  public tunnel -> cloud) — no page rewrite.
- **Access:** the site reads the API URL from the Netlify env var
  `VITE_CHARTER_API_URL` (local dev defaults to `http://127.0.0.1:8787`).
  **Tailscale Funnel** (decided 2026-09-30, README item 34) publishes the
  same ts.net URL to the internet, so any signed-in device works without
  Tailscale installed and the site config is unchanged. Funnel needs the
  `funnel` node attribute in the tailnet policy (admin console, owner
  only); then `tailscale funnel --bg --https=443 http://127.0.0.1:8787`
  replaces the tailnet-only `tailscale serve` of the same port. Revert
  with `tailscale funnel --https=443 off` + the old `serve` line.
- **Security:** every request needs the signed-in Supabase session; the
  API verifies it against Supabase (`/auth/v1/user`, cached 5 min) and
  requires the user id in `CHARTER_ALLOWED_USER_IDS` (.env). Rejected
  tokens are cached 5 min so a replayed bad token never reaches Supabase;
  a client with 20 failed attempts in 5 min gets 429 until the window
  clears; a signed-in user gets 240 requests/min; `/cross` runs 2 at a
  time. Each log line has status, path, ms and client IP. Read-only;
  fixed endpoints; input validated (symbol pattern, ISO dates, numbers,
  known exchanges) and bound as parameters, never turned into SQL. CORS
  for the site and local dev only, plus Chrome's Private Network Access
  opt-in for the site. Binds 127.0.0.1.

## API endpoints (GET, JSON; `&format=csv` where noted)

| Endpoint | Returns |
|---|---|
| `/health` | liveness (no auth) |
| `/catalog` | the metric catalog (`research/charter_api/metrics.py`): id, label, group, unit, source, coverage, definition |
| `/symbols?q=` | ticker/company search with first/last date and last close |
| `/daily?symbol&start&end` (csv) | SIP daily bars + 55 derived metrics (SMA 5-200 + distances + slopes, vol ratio, ATR, 52w range, gap, candle body, close vs VWAP ...). 252-session warm-up so rolling metrics are right from `start` |
| `/events?symbol&start&end` (csv) | catalyst events (EDGAR, earnings, going concern, news types, Form 4, corporate actions) with labels, plus all raw headlines |
| `/short?symbol&start&end` | FINRA short interest (split-restated, dated ~settlement + 12 days as publication) with short float; Reg SHO daily short volume |
| `/fundamentals?symbol` (csv) | SEC shares outstanding (split-restated), public float $, cash, operating cash flow, per filing |
| `/reddit?symbol&start&end` | ApeWisdom daily mentions/upvotes per subreddit |
| `/minute?symbol&date` (csv) | SIP 1-minute bars for one session (via `minute_index`) |
| `/event_types` | every catalyst type with source, label, description, count, first/last date (cached 1 h) |
| `/event_study?kind&...` | mean/median path of `cum_ret` + up to 6 daily metrics from day -pre to +post (each 1-60) around every event; groups event / winners / losers / control; summary at day +k with events-minus-control 95% CI; the event list. See "Event studies" below |
| `/aggregate_catalog` | the fixed aggregate series: id, label, group, unit, kind (mean / count / level) |
| `/aggregates?start&end&freq&...` | every series per day / week / month over the universe, plus up to 3 formula series (`f1..f3`, `f1_how=share|median`); cached until `daily_metrics` is rebuilt. See "Aggregates" below |
| `/live?symbol` | today's **IEX** 1-min bars from Alpaca — a separate feed, never merged into SIP series |
| `/cross?date` or `?start&end&sample` (csv) | every stock on a date, or a sample of stock-days over a range (sampled **after** filtering), with all daily metrics + forward outcomes + point-in-time short / shares / market cap / share growth + trailing 20/60-day catalyst counts by family. Filters: `price_min`, `price_max`, `dollar20_min`, `exchanges`, `funds` |

## Data it builds

- `research/data/charter/daily_metrics/year=*/` —
  `research/charter_api/build_metrics.py`: 20.9M symbol-days, 15.9k
  symbols, ~6.4 GB, ~20 s; rebuilt nightly as the last step of
  `run-research-publish.sh`. Includes `fwd_ret_1/5/20`, `fwd_gap_1`,
  `fwd_max_5`, `fwd_min_5`, `fwd_hit30_5` — **future outcomes**, labelled
  "(future)" in the UI, artifact-guarded.
- `research/data/charter/minute_index.parquet` — `(symbol, month|day, file)`
  flattened from `minute_log.duckdb`; rebuilt when the load log changes.

## The page

- **Symbol deep dive:** search; presets 1M-All or custom dates; candles
  with SMA 5/10/20/40/50/60/200 and VWAP; event markers toggled by source
  (hover for details); unlimited zoom-linked panels for any metric incl.
  short float / short volume ratio / filings / Reddit; formula metrics;
  **click any day** for its minute chart (session VWAP, pre/post shaded);
  a separate live IEX panel; events + headlines table; exports.
- **Cross-section:** one date or a pooled range; universe filters;
  stackable filters on any metric; row-wise formulas; four views —
  **binned** (mean Y per X decile with 95% ranges: the "does X predict Y"
  view — use a future metric as Y), scatter (colour metric, log axes),
  histogram (split by a 0/1 flag or a median), ranked table; click any
  point/row to open that stock in the deep dive around that date; CSV.
- **Event studies:** pick a catalyst type (optionally with a day-0
  formula condition) or a formula condition alone; window, cooldown,
  universe, winner threshold; charts per metric with all events, winners,
  losers and the random-date control (mean with 95% band, or median with
  IQR); summary table at day +k; events table (click -> deep dive), CSV.
  A red note appears when the range reaches 2022+ (the sealed period).
- **Aggregates:** daily / weekly / monthly market-wide series over the
  universe — breadth, equal-weight index, big moves and breakouts,
  volatility, short float and short-volume ratio, catalyst counts by
  family, SPY regime — plus up to 3 formula series; one zoom-linked panel
  each (slider under the last), SPY-below-200-day periods shaded; CSV.
- **Saved views** (Supabase `charter_views`, own rows) store the whole
  configuration and restore the tab. The last configuration is also kept
  in the browser's localStorage.

## Formula language (both tabs)

Purpose-built parser (`src/lib/formula.ts`), never `eval`:
metric ids, numbers (`0.05`, `1e6`), `+ - * /`, `( )`, unary minus,
comparisons `> < >= <= == !=` (1/0), functions `abs log sqrt min max`,
and — deep dive only, refused in the cross-section because rows are
different stocks — `lag(x,n) sma(x,n) change(x,n) zscore(x,n)`.
Percentages are fractions. Missing / divide-by-zero -> empty, never an
error or a made-up number. "and" = multiply comparisons; "or" =
`max(a > x, b > y)`.

## Event studies (`/event_study`, `research/charter_api/formula_sql.py`)

- **Events.** `kind=catalyst&type=` (any type in `research/data/catalysts`)
  with optional `cond`, or `kind=condition&cond=`. The condition is the
  page's formula language compiled to SQL server-side (`formula_sql.py`:
  whitelisted metric names, re-rendered numbers, fixed operators — nothing
  typed is copied into SQL). Per-symbol `lag/sma/change/zscore` work here
  (window functions; not nestable; n <= 250). `fwd_*` columns are refused.
- **Day 0.** Condition: the session it is true at the close. Catalyst:
  `align=entry` (default) the first session strictly after the event date
  — the harness / `/research` convention, so a pre-market or in-session
  event's reaction is day -1 — or `align=event`, the session on/after it.
  Universe gates (raw close band, 20-day $ volume, exchanges, funds) apply
  on day 0. Warrants/units are not excluded (same as `/cross`).
- **Clusters.** An event within `cooldown` sessions (default 20) of an
  earlier candidate of the same symbol is dropped; at most `sample`
  events (default 5,000, max 20,000; reservoir, seeded).
- **Paths.** `cum_ret` = close / day-0 close - 1 (split-adjusted). Windows
  holding a >=10x or <=0.1x day are dropped as split/reorg artifacts.
  Means winsorized 1/99 per day unless `wins=0`; bands = 95% range of the
  mean; median view uses the IQR.
- **Control.** Random in-universe days of the same symbols, more than
  `pre`/`post` sessions from any candidate event, as many as the events.
  Winners/losers split on `cum_ret` at day +`k` >= `thr` — post-day-0 paths
  diverge by construction; the lead-up is the informative part.
- **Check.** Trading halts 2016-21: -3.5% to day +5 vs -0.5% control
  (diff -2.9%, CI -4.9% to -1.0%), consistent with the harness's -3.7%.
  Day-+5 outcomes spot-checked against `daily_metrics` directly.
- Before costs; default range 2016-2021. Runs 0.5-2 s; shares the
  2-at-a-time slot with `/cross`.

## Aggregates (`/aggregates`)

- **Universe** on day t = names passing the gates (raw close band, 20-day
  $ volume, exchanges, funds) at the **previous** close. Gating on day t's
  own close drops a stock on the day it leaves the band (+33% from $4.50)
  and biased every return statistic down — the first build's equal-weight
  index fell 97%; with prior-close gating it runs 89 -> 59 over 2016-26.
- **Per day, then per period:** counts are summed over the period's
  sessions; shares, medians and formula series are averaged over its
  sessions; the equal-weight index (daily mean return clipped to
  -50%/+100%, compounded), SPY close and the regime flag take the last
  value.
- **Warm-up:** the warehouse starts 2016-01-04, so SMA 50/200, 52-week and
  20-day measures are blank until their windows fill (to 2016-12-30 for
  52-week).
- **Short float** per FINRA settlement: short interest and the latest SEC
  share count (filed <= 400 days before) restated to one split basis, as
  `/short` does; median over universe names; 2018+. **Short-volume
  ratio** = Reg SHO short volume / total, median, 2018-08+.
- **Catalysts** are dated to the first universe session on or after the
  event (within 7 days), counted by `/cross`'s families.
- **Formula series:** the formula compiled server-side (`formula_sql.py`),
  computed per symbol over its history (a year of warm-up when it uses
  lag/sma/change/zscore) before gating; `share` = share of the day's
  universe where it is non-zero, `median` = the day's median.
- **Check:** week of 2021-02-08 — breakouts 28, 416.4 stocks/day, 92.82%
  above SMA 50 — matches an independent query exactly. Full history at
  weekly frequency: ~3-6 s; repeats are cached.
- Panels have no wheel zoom (full-width charts swallowed page scrolling);
  the slider under the last panel zooms all of them. Regime shading is
  drawn on its own empty line series — on a bar series ECharts placed the
  same ranges differently.

## Operating it

- Restart: `launchctl kickstart -k gui/$(id -u)/com.stackslash.charter-api`.
  Log: `~/Library/Logs/stackslash-charter-api/charter-api.log`. The `/ops`
  page shows it under "Always on".
- The nightly warehouse update briefly locks `stackslash.duckdb`; the API
  retries, then answers "the warehouse is being updated".
- Local dev: `npm run dev -- --port 5174` (a `dev-5174` entry exists in the
  uncommitted `.claude/launch.json`); sign in on that origin separately.
- Adding a metric: add it to `metrics.py` and to the SQL in
  `server.daily_sql` + `build_metrics.py` (keep definitions identical),
  rebuild the table.
- Testing from a Claude session: the shell sandbox can't resolve MagicDNS;
  use `curl --resolve stackslash-worker-host.tail3d8cea.ts.net:443:100.111.124.95 ...`.
  Claude's embedded browser can't reach the tailnet either — verify on a
  real device or against the local API.

## Remaining phases

3. ~~Event studies~~ — done 2026-09-30 (see above).
4. ~~Aggregates over time~~ — done 2026-10-01 (see above).
5. **Polish** — "?" formula-language help next to the formula fields,
   shareable URLs if wanted (public access: decided 2026-09-30, Tailscale Funnel).
