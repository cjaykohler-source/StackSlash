"""
Broad, honest-about-multiple-comparisons scan: across the whole $0.10-$5
in-band universe, 2016-2026, does any single daily metric's bucket
predict a validated 75%+ single-session breakout (see breakout_events.py)
in the next --forward sessions, better than the unconditional base rate?

This is deliberately exploratory and reports the WHOLE family of tested
cells, not just the best-looking one -- research-audit-plan.md's own F5
finding ("score>=3 is the best of 17 candidates, uncorrected") is exactly
the failure mode a scan like this invites if only the winner gets
reported. Every cell here is shown, in both periods, and nothing gets
called a finding unless it clears the SAME lift, SAME sign, in 2016-21
and 2022+ independently -- this project's own established bar, not a
merged number.

Metrics tested (all point-in-time, prior-session-only, no lookahead):
  vol_ratio_20d        today's volume / 20d trailing average
  streak_under_1x       consecutive sessions under 1.0x that average
  ret_Nd                 split-adjusted return, trailing N sessions (artifact-guarded)
  dist_sma20/50/200      close vs trailing simple moving average
  atr14_pct              14-session ATR as % of price (contraction/expansion)
  range_pct_20d          today's day-range as % of the 20-session average range (squeeze)
  pct_of_52w_high        close vs trailing 252-session high
  pct_of_52w_low         close vs trailing 252-session low
  dollar_vol_20d bucket  liquidity tier
  price bucket           price level itself
  has_8k_7d              an 8-K (any item) in the trailing 7 calendar days

Still exploratory: no permutation-based noise floor here yet (that's the
natural next step for whatever survives the both-periods bar). This scan
answers "what's worth taking to that stage," not "what's proven."

    research/.venv/bin/python research/breakout_scan.py [--forward 20]
"""
import argparse
import datetime as dt
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent
WAREHOUSE = ROOT / "data" / "stackslash.duckdb"
EDGAR = ROOT / "data" / "edgar"
OUT = ROOT / "data" / "study_outputs"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("events_csv")
    ap.add_argument("--forward", type=int, default=20, help="forward sessions checked for a breakout")
    ap.add_argument("--min-lift", type=float, default=1.5, help="minimum lift, both periods, to flag a cell")
    args = ap.parse_args()

    con = duckdb.connect(str(WAREHOUSE), read_only=True)
    con.execute(f"create temp table events as select symbol, event_date::date as event_date from read_csv_auto('{args.events_csv}')")

    con.execute("""
      create temp table band as
      select symbol from sip_bars_daily_raw
      where date >= date '2016-01-01' and close between 0.10 and 5.00
      group by symbol having count(*) >= 60
    """)

    print("Building full-universe daily feature table (this is the slow part)...", flush=True)
    con.execute("""
      create temp table d as
      select r.symbol, r.date, r.volume as v, r.close as raw_close, r.high as h_raw, r.low as l_raw,
             s.close as adj_close, s.high as h_adj, s.low as l_adj,
             row_number() over w as rn,
             (r.close / nullif(lag(r.close, 1) over w, 0)) as raw_daily_ratio
      from sip_bars_daily_raw r
      join sip_bars_daily_split s using (symbol, date)
      join band using (symbol)
      where r.date >= date '2016-01-01'
      window w as (partition by r.symbol order by r.date)
    """)

    con.execute("""
      create temp table feat as
      select *,
        avg(v) over (partition by symbol order by date rows between 20 preceding and 1 preceding) as adv20,
        avg(raw_close * v) over (partition by symbol order by date rows between 20 preceding and 1 preceding) as dollar20,
        v::double / nullif(avg(v) over (partition by symbol order by date rows between 20 preceding and 1 preceding), 0) as vol_ratio,
        avg(h_adj - l_adj) over (partition by symbol order by date rows between 20 preceding and 1 preceding) as avg_range20,
        avg(adj_close) over (partition by symbol order by date rows between 20 preceding and 1 preceding) as sma20,
        avg(adj_close) over (partition by symbol order by date rows between 50 preceding and 1 preceding) as sma50,
        avg(adj_close) over (partition by symbol order by date rows between 200 preceding and 1 preceding) as sma200,
        max(h_adj) over (partition by symbol order by date rows between 252 preceding and 1 preceding) as hi252,
        min(l_adj) over (partition by symbol order by date rows between 252 preceding and 1 preceding) as lo252,
        lag(adj_close, 5) over (partition by symbol order by date) as adj_close_5,
        lag(adj_close, 10) over (partition by symbol order by date) as adj_close_10,
        lag(adj_close, 20) over (partition by symbol order by date) as adj_close_20,
        lag(adj_close, 45) over (partition by symbol order by date) as adj_close_45,
        min(raw_daily_ratio) over (partition by symbol order by date rows between 44 preceding and 0 following) as min_ratio_45,
        max(raw_daily_ratio) over (partition by symbol order by date rows between 44 preceding and 0 following) as max_ratio_45
      from d
    """)

    con.execute("""
      create temp table feat2 as
      select *,
        greatest(h_adj - l_adj, abs(h_adj - lag(adj_close,1) over (partition by symbol order by date)),
                 abs(l_adj - lag(adj_close,1) over (partition by symbol order by date))) as tr
      from feat
    """)
    con.execute("""
      create temp table feat3 as
      select *,
        avg(tr) over (partition by symbol order by date rows between 15 preceding and 2 preceding) as atr14
      from feat2
    """)

    con.execute("""
      create temp table streaks as
      select *,
        case when vol_ratio < 1.0 then row_number() over (partition by symbol, grp order by date) else 0 end as streak_len
      from (
        select *, sum(case when vol_ratio < 1.0 then 0 else 1 end) over (partition by symbol order by date) as grp
        from feat3
      )
    """)

    # 8-K activity, any item, trailing 7 calendar days -- coarse "was
    # something recently filed" flag, not the precise "since prior
    # session" window (that's a separate, already-tested question).
    e = str(EDGAR)
    con.execute(f"""
      create temp table ticker_cik as
      select ticker, min(cik) cik from (
        select ticker, cik from read_parquet('{e}/edgar_tickers.parquet')
        union select unnest(tickers) ticker, cik from read_parquet('{e}/edgar_companies.parquet')
      ) group by ticker
    """)
    con.execute(f"""
      create temp table filings as
      select tc.ticker as symbol, fl.filing_date::date as fdate
      from read_parquet('{e}/edgar_filings.parquet') fl
      join ticker_cik tc on tc.cik = fl.cik
      join band b on b.symbol = tc.ticker
      where fl.form = '8-K'
    """)

    print("Labeling forward outcomes and joining metrics...", flush=True)
    con.execute(f"""
      create temp table labeled as
      select s.*,
        (s.min_ratio_45 >= 0.1 and s.max_ratio_45 <= 10) as clean_45,
        case when s.adv20 > 0 then s.dollar20 end as dollar20_clean,
        exists(
          select 1 from filings f
          where f.symbol = s.symbol and f.fdate between s.date - 6 and s.date
        ) as has_8k_7d,
        exists(
          select 1 from events e
          where e.symbol = s.symbol and e.event_date > s.date
            and e.event_date <= (select d2.date from feat3 d2 where d2.symbol = s.symbol and d2.rn = s.rn + {args.forward})
        ) as breaks_out
      from streaks s
    """)

    def scan(label, expr, buckets_sql, n_min=2000):
        q = f"""
          with x as (
            select case when extract(year from date) < 2022 then '2016-21' else '2022+' end as period,
                   {buckets_sql} as bucket,
                   breaks_out
            from labeled
            where {expr} is not null
          )
          select period, bucket, count(*) n, round(100.0*avg(breaks_out::int), 4) hit_rate
          from x
          group by period, bucket
          having count(*) >= {n_min}
          order by period, bucket
        """
        rows = con.execute(q).fetchall()
        baselines = {p: con.execute(f"select round(100.0*avg(breaks_out::int),4) from labeled where extract(year from date) {'< 2022' if p=='2016-21' else '>= 2022'}").fetchone()[0] for p in ("2016-21", "2022+")}
        print(f"\n--- {label} (forward {args.forward}d; baseline 2016-21={baselines['2016-21']}%, 2022+={baselines['2022+']}%) ---")
        by_bucket = {}
        for period, bucket, n, hr in rows:
            by_bucket.setdefault(bucket, {})[period] = (n, hr)
            print(f"  {period:<8} {str(bucket):<18} n={n:>9,}  hit={hr:>7}%  lift={round(hr/baselines[period],2) if baselines[period] else None}x")
        flagged = []
        for bucket, periods in by_bucket.items():
            if "2016-21" in periods and "2022+" in periods:
                l1 = periods["2016-21"][1] / baselines["2016-21"] if baselines["2016-21"] else 0
                l2 = periods["2022+"][1] / baselines["2022+"] if baselines["2022+"] else 0
                if l1 >= args.min_lift and l2 >= args.min_lift:
                    flagged.append((label, bucket, round(l1, 2), round(l2, 2)))
        return flagged

    all_flagged = []
    all_flagged += scan("vol_ratio_20d", "vol_ratio",
        "case when vol_ratio<0.5 then 'q1 <0.5x' when vol_ratio<1 then 'q2 0.5-1x' when vol_ratio<2 then 'q3 1-2x' when vol_ratio<5 then 'q4 2-5x' else 'q5 >=5x' end")
    all_flagged += scan("streak_under_1x (days)", "streak_len",
        "case when streak_len=0 then '0' when streak_len<=5 then '1-5' when streak_len<=10 then '6-10' when streak_len<=20 then '11-20' else '20+' end")
    all_flagged += scan("ret_5d", "(adj_close/nullif(adj_close_5,0)-1)",
        "case when (adj_close/nullif(adj_close_5,0)-1)<=-0.20 then 'down>=20%' when (adj_close/nullif(adj_close_5,0)-1)<=-0.05 then 'down5-20%' when (adj_close/nullif(adj_close_5,0)-1)<0.05 then 'flat' when (adj_close/nullif(adj_close_5,0)-1)<0.20 then 'up5-20%' else 'up>=20%' end")
    all_flagged += scan("ret_10d", "(adj_close/nullif(adj_close_10,0)-1)",
        "case when (adj_close/nullif(adj_close_10,0)-1)<=-0.20 then 'down>=20%' when (adj_close/nullif(adj_close_10,0)-1)<=-0.05 then 'down5-20%' when (adj_close/nullif(adj_close_10,0)-1)<0.05 then 'flat' when (adj_close/nullif(adj_close_10,0)-1)<0.20 then 'up5-20%' else 'up>=20%' end")
    all_flagged += scan("ret_20d (clean)", "case when clean_45 then (adj_close/nullif(adj_close_20,0)-1) end",
        "case when (adj_close/nullif(adj_close_20,0)-1)<=-0.20 then 'down>=20%' when (adj_close/nullif(adj_close_20,0)-1)<=-0.05 then 'down5-20%' when (adj_close/nullif(adj_close_20,0)-1)<0.05 then 'flat' when (adj_close/nullif(adj_close_20,0)-1)<0.20 then 'up5-20%' else 'up>=20%' end")
    all_flagged += scan("ret_45d (clean)", "case when clean_45 then (adj_close/nullif(adj_close_45,0)-1) end",
        "case when (adj_close/nullif(adj_close_45,0)-1)<=-0.30 then 'down>=30%' when (adj_close/nullif(adj_close_45,0)-1)<=-0.10 then 'down10-30%' when (adj_close/nullif(adj_close_45,0)-1)<0.10 then 'flat' when (adj_close/nullif(adj_close_45,0)-1)<0.30 then 'up10-30%' else 'up>=30%' end")
    all_flagged += scan("dist_sma20", "(adj_close/nullif(sma20,0)-1)",
        "case when (adj_close/nullif(sma20,0)-1)<=-0.20 then 'far below' when (adj_close/nullif(sma20,0)-1)<0 then 'below' when (adj_close/nullif(sma20,0)-1)<0.20 then 'above' else 'far above' end")
    all_flagged += scan("dist_sma50", "(adj_close/nullif(sma50,0)-1)",
        "case when (adj_close/nullif(sma50,0)-1)<=-0.20 then 'far below' when (adj_close/nullif(sma50,0)-1)<0 then 'below' when (adj_close/nullif(sma50,0)-1)<0.20 then 'above' else 'far above' end")
    all_flagged += scan("dist_sma200", "(adj_close/nullif(sma200,0)-1)",
        "case when (adj_close/nullif(sma200,0)-1)<=-0.30 then 'far below' when (adj_close/nullif(sma200,0)-1)<0 then 'below' when (adj_close/nullif(sma200,0)-1)<0.30 then 'above' else 'far above' end")
    all_flagged += scan("atr14_pct (squeeze)", "(atr14/nullif(adj_close_5,0))",
        "case when (atr14/nullif(adj_close_5,0))<0.03 then 'tight <3%' when (atr14/nullif(adj_close_5,0))<0.06 then 'normal 3-6%' when (atr14/nullif(adj_close_5,0))<0.10 then 'wide 6-10%' else 'very wide >=10%' end")
    all_flagged += scan("range_pct_20d (squeeze)", "((h_adj-l_adj)/nullif(avg_range20,0))",
        "case when ((h_adj-l_adj)/nullif(avg_range20,0))<0.5 then 'compressed <0.5x' when ((h_adj-l_adj)/nullif(avg_range20,0))<1.0 then 'below avg' when ((h_adj-l_adj)/nullif(avg_range20,0))<2.0 then 'above avg' else 'expanded >=2x' end")
    all_flagged += scan("pct_of_52w_high", "(adj_close/nullif(hi252,0))",
        "case when (adj_close/nullif(hi252,0))<0.25 then '<25% of high' when (adj_close/nullif(hi252,0))<0.5 then '25-50%' when (adj_close/nullif(hi252,0))<0.75 then '50-75%' else '>=75%' end")
    all_flagged += scan("pct_of_52w_low (proximity)", "(adj_close/nullif(lo252,0))",
        "case when (adj_close/nullif(lo252,0))<1.25 then '<125% of low' when (adj_close/nullif(lo252,0))<2 then '125-200%' when (adj_close/nullif(lo252,0))<4 then '200-400%' else '>=400%' end")
    all_flagged += scan("dollar_vol_20d (liquidity tier)", "dollar20_clean",
        "case when dollar20_clean<100000 then '<100K' when dollar20_clean<800000 then '100K-800K' when dollar20_clean<2500000 then '800K-2.5M' else '>=2.5M' end")
    all_flagged += scan("price level", "raw_close",
        "case when raw_close<0.5 then '0.10-0.50' when raw_close<1 then '0.50-1' when raw_close<2 then '1-2' else '2-5' end")
    all_flagged += scan("has_8k_7d", "has_8k_7d",
        "case when has_8k_7d then 'filed' else 'none' end")

    print("\n\n=== Cells clearing the bar: same sign, both periods, lift >= "
          f"{args.min_lift}x independently ===")
    if not all_flagged:
        print("  none")
    else:
        for label, bucket, l1, l2 in sorted(all_flagged, key=lambda r: min(r[2], r[3]), reverse=True):
            print(f"  {label:<26} {str(bucket):<18} 2016-21 lift={l1}x  2022+ lift={l2}x")

    OUT.mkdir(parents=True, exist_ok=True)
    ts = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    with open(OUT / f"breakout_scan_flagged_{ts}.txt", "w") as fh:
        for label, bucket, l1, l2 in all_flagged:
            fh.write(f"{label}\t{bucket}\t{l1}\t{l2}\n")


if __name__ == "__main__":
    main()
