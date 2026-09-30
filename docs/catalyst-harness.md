# Catalyst harness — crawl sources, test every catalyst type the same way

Started 2026-09-29. Code in `research/catalysts/`. Exploratory: nothing
here is a shipped trigger.

## Why

The price/volume family is exhausted in the $0.10-$15 range (see
`docs/breakout-study.md`, `docs/filing-state-study.md`). The one validated
result so far — dilution as an avoid rule — came from a non-price source.
This tool tests catalysts from every reachable source through one
standard event study, logs every test, and judges winners against how
many things were tried.

## Pieces

| file | role |
|---|---|
| `sources.py` | adapters → `research/data/catalysts/<source>.parquet`, one shared schema (symbol, event_date, event_ts, source, type, detail) |
| `harness.py` | the event study; logs every result to `research/data/catalysts/registry.duckdb` |
| `news_crawl.py` | resumable month-by-month crawl of Alpaca/Benzinga news, 2016+ |
| `reddit_collect.py` | forward-only Reddit attention snapshots via ApeWisdom (launchd `com.stackslash.reddit-collect`, hourly) |
| `form4_crawl.py` | resumable Form 4 fetch + parse (open-market buys vs sales) |
| `../publish_research.py` | publishes types, tests, a 365-day event window, studies and Reddit counts to the `research_*` Supabase tables behind `/research` |

**Nightly**: `scripts/run-research-publish.sh` (launchd
`com.stackslash.research-publish`, 05:30 ET daily) refreshes every source
incrementally — EDGAR `submissions.zip` nightly and `companyfacts.zip`
Sundays, news for the current and previous month, going-concern search
for the last two months, DoltHub earnings on Mondays, new Form 4s — then
rebuilds the event tables and publishes. Log:
`~/Library/Logs/stackslash-research-publish/research-publish.log`. The
harness itself is not re-run nightly: results only change when a study
changes, and every run adds to the registry's tested-types count.

```
research/.venv/bin/python research/catalysts/sources.py [edgar corporate_actions earnings going_concern news]
research/.venv/bin/python research/catalysts/harness.py [--types a,b] [--holdout]
```

### Sources

- **edgar** — local bulk EDGAR (refreshed 2026-09-29): 44 types, every
  8-K item (except 9.01), 13D/13G new and amended, Form 4, 144,
  S-1/S-3/S-8, 424B3/4/5, NT 10-Q/K, 10-Q/10-K, proxies, 425, tender
  offers, 25-NSE, 15-12G/B, EFFECT. 4.0M events.
- **corporate_actions** — local Alpaca feed. Two-thirds of reverse splits
  are OTC names not in the SIP warehouse, so most drop out.
- **earnings** — DoltHub `eps_history` (Zacks-derived reported vs
  consensus, 2016-07+, cached in `raw/dolt_eps_history.parquet`). No
  announcement date in the source and its calendar starts 2020, so each
  quarter is dated by the first 8-K item 2.02 within 120 days after period
  end. ~91k of 169k quarters date this way. Types: beat, miss, inline,
  big beat/miss (|surprise| >= 25% of max(|estimate|, $0.02)), turned
  profitable.
- **going_concern** — EDGAR full-text search for three phrasings of
  "substantial doubt about ... ability to continue as a going concern" in
  10-Ks and 10-Qs, month windows 2016+. Hypothetical risk-factor wording
  can match too.
- **news** — Alpaca/Benzinga headlines, <= 3 symbols per headline, 24
  regex types fixed up front (FDA approval/setback, trial positive/
  negative, contract, partnership, acquired, offering, up/downgrade,
  initiation, PT raise/cut, guidance raise/cut, buyback, listing
  deficiency, reverse split, uplisting, bankruptcy, investigation, short
  report, halt, patent, insider buy) plus `news_any`. Known noise: analyst
  forecast cuts match `guidance_cut`; contract headlines tag both parties.
- **reddit** — hourly ApeWisdom snapshots of r/pennystocks, r/stocks and
  r/wallstreetbets (rolling 24-hour mention counts, rank, upvotes per
  ticker). No Reddit credentials and no Reddit content stored — chosen over
  Reddit's own API, whose Data API terms require purging deleted user
  content. Forward only; untestable until months of snapshots exist.

### The test (`harness.py`)

- Entry at the close of the first session strictly after `event_date`.
- Gates at entry: raw close $0.10-$15, 20-day dollar volume >= $250k.
- Outcome: split-adjusted 5/20-session return, net of max(1%, tick),
  artifact-guarded, winsorized 1/99, minus the same day's gated mean.
- **Null**: each symbol's events rotated to random points (>= 60 sessions
  away) in the same symbol's history, 1,000 times. The effect is the
  **gap** between the observed excess and that null — i.e. the catalyst
  vs. the same names at random times.
- Symbol-clustered bootstrap 90% CI; Benjamini-Hochberg q across every
  type in the run (discovery, 20 sessions). Candidate = q <= 0.10 and CI
  excludes the null median on the same side.
- Returns are price-only, so dividend events are never flagged.
- Discovery 2016-21 only; `--holdout` computes 2022+.
- q values are only meaningful from a **full** run (all types together).

## Results so far (2016-21, full run, 41 types)

| type | n | gap vs random dates (20d) | q |
|---|---|---|---|
| earnings beat | 3,569 | +0.84% | 0.049 |
| 10-Q filed | 9,077 | +0.49% | 0.049 |
| 8-K 2.02 (earnings release) | 11,633 | +0.45% | 0.049 |
| 10-K filed | 2,951 | -0.82% | 0.049 |
| 10-K with going-concern language | 224 | -2.76% | 0.21 |
| 8-K 3.02 (unregistered equity sale) | 1,181 | -1.29% | 0.19 |
| 13G amendment | 9,573 | +0.52% | 0.12 |

- Earnings: a monotone surprise gradient (big beat +0.93% → big miss
  +0.17%), but even misses are positive — most of the effect is "the
  company reported", consistent with post-earnings drift in small caps.
  Estimate coverage is thin in this range (~3.5k beats in six years).
- 10-K: going-concern filers are the worst 10-Ks but explain only part of
  the effect (the rest ≈ -0.66%). Most going-concern filers (22k events)
  never pass the price/liquidity gates.
- Nothing else of 41 types separates from its random-date null: 13D
  activist stakes, material agreements, officer changes, delisting and
  late-filing notices, Form 4 (not split into buys/sells), etc.

## With news (2016-21, full run, 56 types)

The crawl finished 2026-09-29: 2.08M headlines, 1.72M typed events.

| type | n | gap (20d) | q |
|---|---|---|---|
| news: trading halt | 1,306 | -3.66% | 0.028 |
| news: price-target cut | 3,390 | +1.00% | 0.042 |
| earnings beat | 3,569 | +0.88% | 0.037 |
| news: "partnership" | 1,345 | -1.33% | 0.065 |
| 8-K 2.02 / 10-Q | ~11k / 9k | +0.45% / +0.50% | 0.056 / 0.077 |
| 10-K | 2,950 | -0.82% | 0.077 |
| 13G amendment | 9,573 | +0.51% | 0.090 |
| news: insider buy | 379 | +2.98% | 0.12 |

- Halts and promotional "partnership" headlines are avoid candidates, in
  the same family as dilution.
- PT cuts outperforming is most likely mean reversion (cuts follow
  drops), not information — needs a check that conditions on the prior
  return before it's believed.
- Insider buying is the largest positive effect but thin from headlines
  alone — the Form 4 parse (open item 4) is the highest-value data job.
- FDA/trial/contract/upgrade/guidance headlines: nothing — the widely
  watched news is priced immediately.

### Return-matched null (`--match-ret`)

The null only counts rotated dates whose trailing 20-session return is in
the same quintile as the real event's. Gaps barely move: PT cut +1.00% →
+0.95%, halt -3.66% → -3.36%, partnership -1.33% → -1.33%, earnings beat
+0.88% → +0.89%, 10-K -0.82% → -0.86%. So none of these is plain mean
reversion or momentum. p-values rise because only ~1/5 of rotated dates
match (a noisier null), so use `--match-ret` to check effect size, and
the plain full run for q.

## Open

1. Form 4: crawl running (`form4_crawl.py`); then add buy/sell event types.
2. Reddit: collecting hourly since 2026-09-30; test once there are months of snapshots.
3. Holdout (2022+) for the final forms of: earnings beat, earnings
   reporting (2.02/10-Q), 10-K.
4. Form 4: parse the XML to split open-market buys from sells/grants —
   insider buying is the literature's stronger signal, lumped here.
5. Map OTC / historical tickers (EDGAR ticker list is current-only;
   delisted companies' events drop out).
