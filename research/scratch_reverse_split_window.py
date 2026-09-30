"""
One-off diagnostic (2026-09-25, not a standing instrument): does the
reverse-split forward-return edge catalyst_study.py measured (-17% to -22%
at 20 sessions) hold across the WHOLE window production's avoid_reverse_split
trigger actually fires on (ex_date - 28d .. ex_date + 30d, eod-scan.ts
fetchReverseSplits(shift(-28), shift(30))), or only at the single ex-date
entry catalyst_study.py itself tested (an ASOF join taking the first session
on/after xdate)?

Reuses catalyst_study.build_days() for the identical r1/r5/r20 definitions
and cost-free (gross) comparison; bucketed by trading-day offset from the
ex-date so every day in the live trigger's firing window gets its own read.
"""
import duckdb
from pathlib import Path

from catalyst_study import build_days, WAREHOUSE, CA

P = 5.0  # live band

con = duckdb.connect()
con.execute(f"attach '{WAREHOUSE}' as wh (read_only)")
con.execute("use wh")
days = build_days(con, P)
con.execute("use memory")
con.register("days_arrow", days)
con.execute("create temp table days as select * from days_arrow order by symbol, date")

con.execute(f"""
  create temp table rs as
  select distinct symbol, ex_date::date xdate
  from read_parquet('{CA}/*.parquet', union_by_name = true)
  where type = 'reverse_splits' and ex_date between '2016-01-01' and '2030-01-01'
""")

# Trading-day offset from the ex-date for every in-band session within the
# live trigger's window, via a row_number over each symbol's sessions
# (exact calendar offset would count weekends; this counts sessions, which
# is what the trigger's daily eod-scan cadence actually steps through).
con.execute(f"""
  create temp table windowed as
  with sess as (
    select symbol, date, row_number() over (partition by symbol order by date) rn
    from days
  ),
  rs_sess as (
    select rs.symbol, rs.xdate, s.rn xrn
    from rs join sess s on s.symbol = rs.symbol and s.date = rs.xdate
  )
  select d.symbol, d.date, rs_sess.xdate, (s2.rn - rs_sess.xrn) as session_offset,
         d.r1, d.r5, d.r20, d.dollar20
  from rs_sess
  join sess s2 on s2.symbol = rs_sess.symbol
  join days d on d.symbol = s2.symbol and d.date = s2.date
  where s2.date between rs_sess.xdate - interval 45 day and rs_sess.xdate + interval 45 day
""")

print("Reverse-split forward returns, gross, $0.10-$5, $2.5M 20d-$ floor, by session offset from ex-date")
print("(production's avoid_reverse_split fires across roughly [-20, +21] trading sessions -- ~28/~30 calendar days)")
print()
print(f"{'bucket':>18} {'n':>7} {'mean r1':>9} {'mean r5':>9} {'mean r20':>9} {'med r20':>9}")

buckets = [
    ("-28..-15 cal", -20, -11),
    ("-14..-1 cal", -10, -1),
    ("0 (ex-date)", 0, 0),
    ("+1..+15 cal", 1, 10),
    ("+16..+30 cal", 11, 21),
]
for label, lo, hi in buckets:
    row = con.execute(f"""
      select count(*) n,
             avg(r1) filter (where dollar20 >= 2500000) mr1,
             avg(r5) filter (where dollar20 >= 2500000) mr5,
             avg(r20) filter (where dollar20 >= 2500000) mr20,
             median(r20) filter (where dollar20 >= 2500000) medr20
      from windowed where session_offset between {lo} and {hi}
    """).fetchone()
    n, mr1, mr5, mr20, medr20 = row
    fmt = lambda v: f"{v*100:8.2f}%" if v is not None else "     n/a"
    print(f"{label:>18} {n:>7} {fmt(mr1):>9} {fmt(mr5):>9} {fmt(mr20):>9} {fmt(medr20):>9}")
