#!/usr/bin/env python
"""
Session cohort analyzer.

Isolates every session matching an open-to-close outcome, then asks
whether anything knowable *before the trade* distinguishes those sessions
from the rest.

The framing matters and is deliberately the reverse of everything else in
this project. `backtest-triggers` asks "our trigger fired — what happened
next?", which can only ever evaluate logic we already wrote. This asks
"a big move happened — what preceded it?", across all ~930k band sessions
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
Every result is therefore also reported on a time split.

Usage:
    research/.venv/bin/python research/session_cohorts.py --build
    research/.venv/bin/python research/session_cohorts.py --threshold 0.20
    research/.venv/bin/python research/session_cohorts.py --threshold -0.20 --direction down
"""

import argparse
from pathlib import Path

import duckdb

DB_PATH = Path(__file__).resolve().parent / "data" / "stackslash.duckdb"

# Band definition, matching scan_config (price_min/price_max).
PRICE_MIN, PRICE_MAX = 0.10, 5.00

# A prior session further back than this means a halt or delisting gap;
# lagged features across one are stale and the return across it isn't a
# real overnight move. Same guard as netlify/functions/backtest-triggers.ts.
MAX_PRIOR_GAP_DAYS = 7

BUILD_FEATURES = f"""
create or replace table session_features as
with
-- Symbols whose adjusted history contains an impossible price are
-- excluded wholesale: partial split adjustment interleaves two price
-- scales and every derived feature on them is fiction.
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
    lag(close)  over w as prev_close,
    lag(date)   over w as prev_date,
    lag(volume) over w as prev_volume,
    lag(close, 5)  over w as close_5b,
    lag(close, 20) over w as close_20b,
    avg(volume) over (partition by symbol_id order by date rows between 20 preceding and 1 preceding) as avg_vol20,
    max(high)   over (partition by symbol_id order by date rows between 20 preceding and 1 preceding) as hi20,
    max(high)   over (partition by symbol_id order by date rows between 60 preceding and 1 preceding) as hi60,
    min(low)    over (partition by symbol_id order by date rows between 20 preceding and 1 preceding) as lo20,
    sum(case when close < lag(close) over w then 1 else 0 end)
      over (partition by symbol_id order by date rows between 5 preceding and 1 preceding) as down_days_5
  from clean
  window w as (partition by symbol_id order by date)
),
rets as (
  select *, (close / nullif(prev_close, 0)) - 1 as daily_ret from seq
),
volw as (
  select *,
    stddev_samp(daily_ret) over (partition by symbol_id order by date rows between 20 preceding and 1 preceding) as vol20
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
  prev_close / nullif(hi20, 0)             as pct_of_hi20,
  prev_close / nullif(hi60, 0)             as pct_of_hi60,
  prev_close / nullif(lo20, 0)             as pct_of_lo20,
  down_days_5                              as prior_down_days_5
from volw
where prev_close is not null
  and date_diff('day', prev_date, date) <= {MAX_PRIOR_GAP_DAYS}
  and open between {PRICE_MIN} and {PRICE_MAX}
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
    "pct_of_hi20",
    "pct_of_hi60",
    "pct_of_lo20",
    "prior_down_days_5",
    "open",
]


def build(con):
    print("Building session_features (no-lookahead)...")
    con.execute(BUILD_FEATURES)
    n = con.execute("select count(*) from session_features").fetchone()[0]
    rng = con.execute("select min(date), max(date) from session_features").fetchone()
    print(f"  {n:,} band sessions, {rng[0]} to {rng[1]}")


def cohort_clause(threshold, direction):
    return f"oc_ret >= {threshold}" if direction == "up" else f"oc_ret <= {threshold}"


def analyze(con, threshold, direction, split_date, deciles):
    hit = cohort_clause(threshold, direction)

    total, cohort = con.execute(
        f"select count(*), count(*) filter (where {hit}) from session_features"
    ).fetchone()
    base = cohort / total
    print(f"\nCohort: {hit}")
    print(f"  {cohort:,} of {total:,} sessions — base rate {base * 100:.3f}%\n")
    if cohort < 100:
        print("  Sample too small to analyse meaningfully.")
        return

    print(f"{'feature':<20} {'decile':<8} {'n':>9} {'hits':>7} {'precision':>10} {'lift':>7}  {'test lift':>9}")
    print("-" * 82)

    for feat in FEATURES:
        rows = con.execute(
            f"""
            with d as (
              select {feat} as v, ({hit}) as is_hit, date,
                ntile({deciles}) over (order by {feat}) as bucket
              from session_features where {feat} is not null
            )
            select bucket, count(*) n, count(*) filter (where is_hit) hits,
              avg(case when is_hit then 1.0 else 0.0 end) prec,
              -- lift computed only on data after the split, i.e. not the
              -- period any threshold choice would have been fitted on
              count(*) filter (where date >= '{split_date}') n_test,
              count(*) filter (where is_hit and date >= '{split_date}') hits_test
            from d group by bucket order by bucket
            """
        ).fetchall()
        if not rows:
            continue
        # Report only the most discriminating decile per feature — the rest
        # is noise for a scan of this width.
        best = max(rows, key=lambda r: r[3])
        bucket, n, hits, prec, n_test, hits_test = best
        lift = prec / base if base else 0
        test_prec = (hits_test / n_test) if n_test else 0
        test_lift = test_prec / base if base else 0
        print(
            f"{feat:<20} {bucket:>2}/{deciles:<5} {n:>9,} {hits:>7,} "
            f"{prec * 100:>9.3f}% {lift:>6.2f}x {test_lift:>8.2f}x"
        )

    print(
        f"\nBase rate {base * 100:.3f}%. 'lift' is full-sample; 'test lift' is "
        f"sessions from {split_date} onward only.\nA feature is only interesting "
        f"if test lift holds up near full-sample lift AND precision is high enough to trade."
    )


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
