"""Diagnostic for item 40 (overnight_cost.py): effective-spread estimates from 1-minute bars for a sample
of 2019 stock-days per price x liquidity bucket, vs the daily Abdi-Ranaldo estimate. Minute bars carry
far less volatility per bar, so the Abdi-Ranaldo estimator applied to consecutive minutes is much closer
to the true bid-ask spread than the daily version. Not a study; see docs/overnight-cost.md."""
import duckdb
import numpy as np
from pathlib import Path

ROOT = Path(__file__).resolve().parent
M = ROOT / "data" / "charter" / "daily_metrics"
MIDX = ROOT / "data" / "charter" / "minute_index.parquet"
PRICE = [(0.10, 0.50), (0.50, 1), (1, 2), (2, 5)]
DV = [(250e3, 1e6), (1e6, 5e6), (5e6, 25e6), (25e6, 1e15)]
con = duckdb.connect()
cases = " ".join(f"when raw_close >= {p0} and raw_close < {p1} then {i}" for i, (p0, p1) in enumerate(PRICE))
dcases = " ".join(f"when dollar20 >= {d0} and dollar20 < {d1} then {i}" for i, (d0, d1) in enumerate(DV))
con.execute(f"""
  create temp table s as select * from (
    select symbol, date, raw_close, dollar20, case {cases} end pb, case {dcases} end db,
      row_number() over (partition by (case {cases} end), (case {dcases} end) order by hash(symbol || date::varchar)) rn
    from read_parquet('{M}/year=2019/*.parquet') where raw_close between 0.10 and 5 and dollar20 >= 250000 and not coalesce(is_fund, false)
  ) where rn <= 300 and pb is not null and db is not null
""")
con.execute(f"""create temp table f as select distinct s.symbol, s.date, i.file from s join read_parquet('{MIDX}') i
  on i.symbol = s.symbol and (i.day = s.date or (i.day is null and i.month = date_trunc('month', s.date)::date))""")
files = [r[0] for r in con.execute("select distinct file from f").fetchall() if Path(r[0]).exists()]
con.execute("create temp table mb (symbol varchar, date date, ts timestamp, high double, low double, close double)")
for k in range(0, len(files), 400):
    con.execute(f"""insert into mb select m.symbol, (m.ts at time zone 'America/New_York')::date, m.ts at time zone 'America/New_York', m.high, m.low, m.close
      from read_parquet({files[k:k + 400]!r}, union_by_name = true) m join (select distinct symbol, date from s) e
      on e.symbol = m.symbol and e.date = (m.ts at time zone 'America/New_York')::date
      where (m.ts at time zone 'America/New_York')::time between time '09:30' and time '15:59'""")
r = con.execute("""
  with b as (select symbol, date, ln(close) lc, (ln(high) + ln(low)) / 2 eta,
               lead((ln(high) + ln(low)) / 2) over (partition by symbol, date order by ts) eta1 from mb where low > 0),
  d as (select symbol, date, sqrt(avg(greatest(4 * (lc - eta) * (lc - eta1), 0))) ms, count(*) bars from b where eta1 is not null group by 1, 2 having count(*) >= 30)
  select s.pb, s.db, count(*) n, median(d.ms) med_minute_spread, avg(d.ms) mean_minute_spread, median(d.bars) bars
  from s join d using (symbol, date) group by 1, 2 order by 1, 2
""").fetchall()
for pb, db, n, med, mean, bars in r:
    print(f"  price ${PRICE[pb][0]:g}-{PRICE[pb][1]:g}  $vol {DV[db][0] / 1e6:g}M+  n={n:3d}  minute-AR spread median {med:.2%} mean {mean:.2%}  (median {bars:.0f} bars)")
