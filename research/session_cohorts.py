#!/usr/bin/env python
"""
Session cohort analyzer.

Isolates every session matching an open-to-close outcome, then asks
whether anything knowable *before the trade* distinguishes those sessions
from the rest.

The framing matters and is deliberately the reverse of everything else in
this project. `backtest-triggers` asks "our trigger fired — what happened
next?", which can only ever evaluate logic we already wrote. This asks
"a big move happened — what preceded it?", across every band session
with no trigger logic biasing the sample.

STRICT NO-LOOKAHEAD RULE: every feature is computed from sessions strictly
before the one being classified, with exactly one exception — the
overnight gap (open vs prior close), which is genuinely known at 09:30 and
is therefore legitimate input to an open-to-close trade. Nothing else from
the session itself is allowed anywhere near a feature.

WHY IT REPORTS LIFT AND PRECISION, NOT JUST GROUP MEANS: with ~930k rows
and a dozen candidate features you will always find something that
separates. The +20% cohort is ~0.46% of sessions, so a feature that
triples your hit rate still leaves you wrong ~98.6% of the time. "Cohort
differs from average" is not a finding; "flagging X gives you N% precision
against a 0.46% base rate, and it held on data it wasn't fitted on" is.

THE TIME SPLIT IS THE WHOLE POINT, SO NOTHING IS FITTED ACROSS IT: decile
cutoffs and the "best" decile per feature are both chosen on sessions
before --split-date only, then that same fixed bucket is scored on
sessions from --split-date onward. Each side's lift is against its own
period's base rate — the base rate itself moves with regime, and dividing
test precision by the full-sample base rate would credit a feature for a
hot market.

KNOWN LIMITATION — the band is on ADJUSTED prices. bars_daily is
split-adjusted as of fetch time (alpaca.ts, adjustment: "split"), so a
name that later reverse-split 1:10 shows 10x its real historical price and
drops out of the $0.10-$5 band for sessions where it actually traded in
it (and forward-splitters drift in). Returns are ratios and unaffected;
band *membership* is not. This matters in proportion to how many band
names are serial reverse-splitters — the integrity check counts 195
symbols with split scale breaks — and it cannot be fixed without an
unadjusted price history, which this project does not store.

Usage:
    research/.venv/bin/python research/session_cohorts.py --build
    research/.venv/bin/python research/session_cohorts.py --threshold 0.20
    research/.venv/bin/python research/session_cohorts.py --threshold -0.20 --direction down
"""

import argparse
from pathlib import Path

import duckdb

DB_PATH = Path(__file__).resolve().parent / "data" / "stackslash.duckdb"

# Band definition, matching scan_config (price_min/price_max and
# min_dollar_vol_20d). Without the liquidity floor the cohort fills up with
# sessions nobody could have traded.
PRICE_MIN, PRICE_MAX = 0.10, 5.00
MIN_DOLLAR_VOL_20D = 50_000

# A prior session further back than this means a halt or delisting gap;
# lagged features across one are stale and the return across it isn't a
# real overnight move. Same guard as netlify/functions/backtest-triggers.ts.
MAX_PRIOR_GAP_DAYS = 7

# A >=10x close-to-close move is a split scale break, not a price (same
# rule as backtest-triggers' hasSplitArtifact). Any session with one in its
# lookback window has fictional features. The 1e-6 slack is deliberate:
# an exact 1:10 reverse split lands a hair above 0.1 in DOUBLE while
# Postgres numeric evaluates it as exactly 0.1 (MSS, BQ).
SCALE_BREAK = 10.0
LOOKBACK_BARS = 60

BUILD_FEATURES = f"""
create or replace table session_features as
with
-- Symbols whose adjusted history contains an impossible price are
-- excluded wholesale: partial split adjustment interleaves two price
-- scales and every derived feature on them is fiction. This is a
-- data-quality filter over the symbol's full history, not a feature.
bad_syms as (
  select distinct symbol_id from bars_daily where close > 10000
),
clean as (
  select b.symbol_id, b.date, b.open, b.high, b.low, b.close, b.volume
  from bars_daily b
  where b.symbol_id not in (select symbol_id from bad_syms)
    and b.open > 0 and b.high > 0 and b.low > 0 and b.close > 0
),
seq as (
  select *,
    lag(close)     over w as prev_close,
    lag(date)      over w as prev_date,
    lag(volume)    over w as prev_volume,
    lag(close, 5)  over w as close_5b,
    lag(close, 20) over w as close_20b,
    avg(volume)          over w20 as avg_vol20,
    avg(close * volume)  over w20 as avg_dollar_vol20,
    max(high)            over w20 as hi20,
    max(high)            over w60 as hi60,
    min(low)             over w20 as lo20
  from clean
  window
    w   as (partition by symbol_id order by date),
    w20 as (partition by symbol_id order by date rows between 20 preceding and 1 preceding),
    w60 as (partition by symbol_id order by date rows between 60 preceding and 1 preceding)
),
-- Per-row flags first: window calls cannot be nested, so anything that
-- aggregates a lag() has to read it from a prior CTE.
rets as (
  select *,
    (close / nullif(prev_close, 0)) - 1 as daily_ret,
    case when close < prev_close then 1 else 0 end as is_down,
    case when prev_close > 0
          and (close / prev_close >= {SCALE_BREAK}
               or close / prev_close <= {1 / SCALE_BREAK} + 1e-6)
         then 1 else 0 end as is_scale_break
  from seq
),
volw as (
  select *,
    stddev_samp(daily_ret) over (partition by symbol_id order by date rows between 20 preceding and 1 preceding) as vol20,
    sum(is_down)           over (partition by symbol_id order by date rows between 5 preceding and 1 preceding)  as down_days_5,
    -- includes the current row: a break on the session itself corrupts gap_pct
    max(is_scale_break)    over (partition by symbol_id order by date rows between {LOOKBACK_BARS} preceding and current row) as break_in_window
  from rets
)
select
  symbol_id,
  date,
  open,
  close,
  -- OUTCOME: the thing being predicted. Never a feature.
  (close / nullif(open, 0)) - 1 as oc_ret,
  -- Known at 09:30: the overnight gap.
  (open / nullif(prev_close, 0)) - 1 as gap_pct,
  -- Everything below is strictly prior-session.
  prev_close,
  (prev_close / nullif(close_5b, 0)) - 1  as prior_ret_5d,
  (prev_close / nullif(close_20b, 0)) - 1 as prior_ret_20d,
  vol20                                    as prior_vol20,
  prev_volume / nullif(avg_vol20, 0)       as prior_rvol,
  prev_close * prev_volume                 as prior_dollar_vol,
  avg_dollar_vol20                         as prior_dollar_vol20,
  prev_close / nullif(hi20, 0)             as pct_of_hi20,
  prev_close / nullif(hi60, 0)             as pct_of_hi60,
  prev_close / nullif(lo20, 0)             as pct_of_lo20,
  down_days_5                              as prior_down_days_5
from volw
where prev_close is not null
  and date_diff('day', prev_date, date) <= {MAX_PRIOR_GAP_DAYS}
  and open between {PRICE_MIN} and {PRICE_MAX}
  and avg_dollar_vol20 >= {MIN_DOLLAR_VOL_20D}
  and break_in_window = 0
  and vol20 is not null
  and avg_vol20 > 0
"""

FEATURES = [
    "gap_pct",
    "prior_ret_5d",
    "prior_ret_20d",
    "prior_vol20",
    "prior_rvol",
    "prior_dollar_vol",
    "prior_dollar_vol20",
    "pct_of_hi20",
    "pct_of_hi60",
    "pct_of_lo20",
    "prior_down_days_5",
    "open",
]

# Buckets thinner than this on the training side are skipped when picking
# the best one — a 40-session bucket with 3 hits is a 7.5% "precision".
MIN_TRAIN_BUCKET = 1000


def build(con):
    print("Building session_features (no-lookahead)...")
    con.execute(BUILD_FEATURES)
    n = con.execute("select count(*) from session_features").fetchone()[0]
    rng = con.execute("select min(date), max(date) from session_features").fetchone()
    print(f"  {n:,} band sessions, {rng[0]} to {rng[1]}")


def cohort_clause(threshold, direction):
    return f"oc_ret >= {threshold}" if direction == "up" else f"oc_ret <= {threshold}"


def bucket_expr(feat, cuts):
    """CASE assigning `feat` to 1..len(cuts)+1 by the training-period cutoffs."""
    if not cuts:
        return "1"
    whens = " ".join(f"when {feat} <= {c!r} then {i + 1}" for i, c in enumerate(cuts))
    return f"case {whens} else {len(cuts) + 1} end"


def analyze(con, threshold, direction, split_date, deciles):
    hit = cohort_clause(threshold, direction)
    train = f"date < '{split_date}'"
    test = f"date >= '{split_date}'"

    n_tr, h_tr, n_te, h_te = con.execute(
        f"""select count(*) filter (where {train}), count(*) filter (where {train} and {hit}),
                   count(*) filter (where {test}),  count(*) filter (where {test} and {hit})
            from session_features"""
    ).fetchone()
    base_tr = h_tr / n_tr if n_tr else 0
    base_te = h_te / n_te if n_te else 0
    print(f"\nCohort: {hit}   split at {split_date}")
    print(f"  train: {h_tr:,} of {n_tr:,} sessions — base rate {base_tr * 100:.3f}%")
    print(f"  test:  {h_te:,} of {n_te:,} sessions — base rate {base_te * 100:.3f}%\n")
    if h_tr < 100 or h_te < 30:
        print("  Sample too small on one side of the split to analyse meaningfully.")
        return

    qs = [i / deciles for i in range(1, deciles)]
    print(
        f"{'feature':<20} {'bkt':>6} {'range (train cutoffs)':>27} "
        f"{'n_tr':>8} {'prec_tr':>8} {'lift_tr':>7} {'n_te':>8} {'hits_te':>7} {'prec_te':>8} {'lift_te':>7}"
    )
    print("-" * 124)

    for feat in FEATURES:
        cuts = con.execute(
            f"select quantile_disc({feat}, {qs}) from session_features where {train} and {feat} is not null"
        ).fetchone()[0]
        # Discrete features (down days, ties) collapse into fewer buckets.
        cuts = sorted(set(c for c in (cuts or []) if c is not None))
        rows = con.execute(
            f"""
            with d as (
              select {bucket_expr(feat, cuts)} as bucket, ({hit}) as is_hit, date
              from session_features where {feat} is not null
            )
            select bucket,
              count(*) filter (where {train})              as n_tr,
              count(*) filter (where {train} and is_hit)   as hits_tr,
              count(*) filter (where {test})               as n_te,
              count(*) filter (where {test} and is_hit)    as hits_te
            from d group by bucket order by bucket
            """
        ).fetchall()
        eligible = [r for r in rows if r[1] >= MIN_TRAIN_BUCKET]
        if not eligible:
            continue
        # Chosen on TRAIN precision only; the test columns are then read off
        # that same fixed bucket.
        bucket, n_b_tr, hits_b_tr, n_b_te, hits_b_te = max(eligible, key=lambda r: r[2] / r[1])
        prec_tr = hits_b_tr / n_b_tr
        prec_te = hits_b_te / n_b_te if n_b_te else 0
        lo = cuts[bucket - 2] if bucket >= 2 else None
        hi = cuts[bucket - 1] if bucket - 1 < len(cuts) else None
        rng = f"({_fmt(lo, '-inf')}, {_fmt(hi, '+inf')}]"
        print(
            f"{feat:<20} {bucket:>2}/{len(cuts) + 1:<3} {rng:>27} "
            f"{n_b_tr:>8,} {prec_tr * 100:>7.3f}% {prec_tr / base_tr:>6.2f}x "
            f"{n_b_te:>8,} {hits_b_te:>7,} {prec_te * 100:>7.3f}% {prec_te / base_te if base_te else 0:>6.2f}x"
        )

    print(
        f"\nlift_tr = train precision / train base rate (this is where the bucket was chosen, so it is"
        f"\noptimistic by construction). lift_te = test precision / test base rate on the same fixed"
        f"\nbucket. A feature is only interesting if lift_te holds up near lift_tr, hits_te is not tiny,"
        f"\nAND prec_te is high enough to trade. Twelve features were scanned; expect one to look good by chance."
    )


def _fmt(v, unbounded):
    return unbounded if v is None else f"{v:.4g}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", action="store_true", help="rebuild the feature table")
    ap.add_argument("--threshold", type=float, default=0.20)
    ap.add_argument("--direction", choices=["up", "down"], default="up")
    ap.add_argument("--split-date", default="2025-06-01", help="out-of-sample start")
    ap.add_argument("--deciles", type=int, default=10)
    args = ap.parse_args()

    con = duckdb.connect(str(DB_PATH))
    if args.build:
        build(con)
    exists = con.execute(
        "select count(*) from information_schema.tables where table_name='session_features'"
    ).fetchone()[0]
    if not exists:
        print("No session_features table — run with --build first.")
        return
    analyze(con, args.threshold, args.direction, args.split_date, args.deciles)
    con.close()


if __name__ == "__main__":
    main()
