"""Layer 3 audit, auditor A: 8-K item 2.02 catalyst study, rebuilt from spec.

Run: research/.venv/bin/python research/audit/catalyst_l3_a.py
Writes research/data/audit/catalyst_l3_a.csv
"""
import os
import time
import csv
import math
import duckdb

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # research/
DB = os.path.join(ROOT, "data", "stackslash.duckdb")
EDGAR = os.path.join(ROOT, "data", "edgar")
OUT = os.path.join(ROOT, "data", "audit", "catalyst_l3_a.csv")

PX_LO, PX_HI = 0.10, 5.00
DV_MIN = 2_500_000.0
DV_WIN = 20
HORIZONS = (1, 5, 20)
COST_PCT = 0.01
TICK = 0.01


def connect():
    for i in range(60):
        try:
            return duckdb.connect(DB, read_only=True)
        except duckdb.IOException as e:  # locked by writer
            print(f"db locked ({e}); retry {i}")
            time.sleep(10)
    raise SystemExit("could not open warehouse")


con = connect()


def n(sql):
    return con.sql(sql).fetchone()[0]


def step(label, table):
    k = n(f"select count(*) from {table}")
    print(f"[{label}] {table}: {k:,}")
    return k


# ---------------------------------------------------------------- price panel
con.execute("""
create temp table cal as
select date, row_number() over (order by date) as cidx
from (select distinct date from sip_bars_daily_raw)
""")
step("calendar sessions (distinct dates in raw SIP)", "cal")

n_raw = n("select count(*) from sip_bars_daily_raw")
n_split = n("select count(*) from sip_bars_daily_split")
assert n("select count(*) from (select symbol,date from sip_bars_daily_raw group by all having count(*)>1)") == 0
assert n("select count(*) from (select symbol,date from sip_bars_daily_split group by all having count(*)>1)") == 0
con.execute("""
create temp table panel0 as
select r.symbol, r.date, r.close as raw_close, r.volume as raw_volume, s.close as adj_close
from sip_bars_daily_raw r join sip_bars_daily_split s using (symbol, date)
""")
n_p0 = step("raw INNER JOIN split on (symbol,date)", "panel0")
print(f"   raw rows {n_raw:,}, split rows {n_split:,}; raw-only dropped {n_raw - n_p0:,}, "
      f"split-only dropped {n_split - n_p0:,}")
n_bad = n("select count(*) from panel0 where raw_close is null or adj_close is null or adj_close<=0 or raw_close<=0")
print(f"   rows with null/non-positive close (excluded from panel): {n_bad:,}")

con.execute(f"""
create temp table panel as
with p as (select * from panel0 where raw_close>0 and adj_close>0 and raw_volume is not null)
select p.*, c.cidx,
  avg(raw_close*raw_volume) over w20 as dv20,
  count(*) over w20 as dv_nbars,
  {", ".join(f"lead(adj_close,{h}) over ws as adj_fwd{h}, lead(date,{h}) over ws as d_fwd{h}" for h in HORIZONS)}
from p join cal c using (date)
window ws as (partition by symbol order by date),
       w20 as (partition by symbol order by date rows between {DV_WIN-1} preceding and current row)
""")
n_panel = step("panel with dv20 + forward closes", "panel")
assert n_panel == n_p0 - n_bad, "calendar join dropped rows"

con.execute(f"""
create temp table gated as
select * from panel
where raw_close between {PX_LO} and {PX_HI} and dv_nbars = {DV_WIN} and dv20 >= {DV_MIN}
""")
step("gated in-band symbol-days (baseline universe, before horizon availability)", "gated")
print(f"   in-band days lacking a full {DV_WIN}-bar window: "
      f"{n(f'select count(*) from panel where raw_close between {PX_LO} and {PX_HI} and dv_nbars<{DV_WIN}'):,}")

# ---------------------------------------------------------------- events
F = os.path.join(EDGAR, "edgar_filings.parquet")
T = os.path.join(EDGAR, "edgar_tickers.parquet")
con.execute(f"""
create temp table f202 as
select distinct cik, accession, filing_date::date as filing_date, acceptance_datetime, items
from '{F}'
where form = '8-K' and list_contains(string_split(replace(items,' ',''), ','), '2.02')
""")
step("8-K (form exactly '8-K') with item 2.02", "f202")
q_amend = f"select count(*) from '{F}' where form='8-K/A' and items like '%2.02%'"
print(f"   8-K/A with 2.02 not used: {n(q_amend):,}")
# Joint filings (parent + subsidiary co-registrants) share one accession across CIKs;
# the unit is (cik, accession) and each CIK is mapped to its own ticker(s).
assert n("select count(*) - count(distinct (cik, accession)) from f202") == 0
print(f"   distinct accessions {n('select count(distinct accession) from f202'):,}; "
      f"accessions filed jointly by >1 CIK: {n('select count(*) from (select accession from f202 group by 1 having count(*)>1)'):,}")

con.execute(f"""
create temp table tick as
select cik, ticker,
  case when regexp_matches(ticker, '^[A-Z0-9]+$') then ticker
       when regexp_matches(ticker, '^[A-Z0-9]+-[A-Z]$') then replace(ticker, '-', '.')
       else null end as symbol
from '{T}'
""")
step("SEC ticker map rows", "tick")
print(f"   tickers not mapped (preferred/warrant/unit/right suffix): {n('select count(*) from tick where symbol is null'):,}")

con.execute("""
create temp table ev_map as
select f.*, t.ticker, t.symbol from f202 f join tick t using (cik) where t.symbol is not null
""")
k_map = step("filings x mapped tickers", "ev_map")
print(f"   filings whose CIK has no mappable ticker: "
      f"{n('select count(*) from f202 where cik not in (select cik from tick where symbol is not null)'):,}")
print(f"   filings mapped to >1 ticker (fan-out): "
      f"{n('select count(*) from (select accession from ev_map group by 1 having count(*)>1)'):,}")

con.execute("""
create temp table ev_sym as
select * from ev_map where symbol in (select distinct symbol from panel)
""")
step("mapped filings whose symbol exists in SIP bars", "ev_sym")

# The calendar starts 2016-01-04; 2015-12-31 was a session, so filings dated
# 2016-01-01..03 legitimately get D0 = 2016-01-04. Earlier filings have D0 outside the data.
con.execute("""
create temp table ev_cal as
select e.*,
  (select min(c.cidx) from cal c where c.date >= e.filing_date) as d0_idx
from ev_sym e where e.filing_date >= date '2016-01-01'
""")
q_pre = "select count(*) from ev_sym where filing_date < date '2016-01-01'"
print(f"   filings dated before 2016-01-01 (D0 before price data; out of scope): {n(q_pre):,}")
con.execute("""
create temp table ev_dates as
select e.*, c.date as entry_date, c.cidx as entry_idx
from ev_cal e join cal c on c.cidx = e.d0_idx + 1
""")
k = step("filing -> D0 (first session on/after filing date) -> entry = D0+1 session", "ev_dates")
print(f"   dropped (filing before calendar start / D0+1 beyond data end): "
      f"{n('select count(*) from ev_cal') - k:,}")

con.execute("""
create temp table ev_ded as
select symbol, entry_date, count(*) as n_filings, min(filing_date) as first_filing
from ev_dates
group by 1, 2
""")
step("dedup to unique (symbol, entry_date)", "ev_ded")
print(f"   (symbol,entry_date) with >1 filing collapsed: "
      f"{n('select count(*) from ev_ded where n_filings>1'):,}")

con.execute("""
create temp table ev_bar as
select e.symbol, e.entry_date, p.* exclude (symbol, date)
from ev_ded e join panel p on p.symbol = e.symbol and p.date = e.entry_date
""")
k_bar = step("events with a bar for the symbol on the entry session", "ev_bar")
print(f"   events with no bar on entry session (dropped): {n('select count(*) from ev_ded') - k_bar:,}")

con.execute(f"""
create temp table ev_gated as
select * from ev_bar
where raw_close between {PX_LO} and {PX_HI} and dv_nbars = {DV_WIN} and dv20 >= {DV_MIN}
""")
step("events passing gates", "ev_gated")
print(f"   fail price band: {n(f'select count(*) from ev_bar where not raw_close between {PX_LO} and {PX_HI}'):,}; "
      f"in band but <{DV_WIN} bars: {n(f'select count(*) from ev_bar where raw_close between {PX_LO} and {PX_HI} and dv_nbars<{DV_WIN}'):,}; "
      f"in band but dv20<2.5M: {n(f'select count(*) from ev_bar where raw_close between {PX_LO} and {PX_HI} and dv_nbars={DV_WIN} and dv20<{DV_MIN}'):,}")
# events must be a subset of baseline
assert n("select count(*) from ev_gated e anti join gated g on g.symbol=e.symbol and g.date=e.entry_date") == 0

# ---------------------------------------------------------------- returns + stats
cal_max = n("select max(cidx) from cal")
rows = []
for kind, tbl, dcol in (("event", "ev_gated", "entry_date"), ("baseline", "gated", "date")):
    for h in HORIZONS:
        tot = n(f"select count(*) from {tbl}")
        past_end = n(f"select count(*) from {tbl} where adj_fwd{h} is null and cidx + {h} > {cal_max}")
        sym_end = n(f"select count(*) from {tbl} where adj_fwd{h} is null and cidx + {h} <= {cal_max}")
        gap = n(f"select count(*) from {tbl} t join cal c on c.date=t.d_fwd{h} where c.cidx <> t.cidx + {h}")
        print(f"[{kind} h={h}] gated {tot:,}; no fwd bar: past data end {past_end:,}, "
              f"symbol stopped trading {sym_end:,}; usable {tot - past_end - sym_end:,}; "
              f"exit bar is later than calendar session +{h} (symbol gap): {gap:,}")
        q = f"""
        with r as (
          select case when {dcol} < date '2022-01-01' then '2016-2021' else '2022+' end as period,
                 adj_fwd{h}/adj_close - 1 - greatest({COST_PCT}, {TICK}/raw_close) as net
          from {tbl} where adj_fwd{h} is not null)
        select period, count(*), avg((net>0)::int), avg(net), median(net),
               sum(case when net>0 then net else 0 end), sum(case when net<0 then -net else 0 end)
        from r group by 1 order by 1
        """
        got = con.sql(q).fetchall()
        assert sum(g[1] for g in got) == tot - past_end - sym_end
        for period, cnt, wr, mean, med, pos, neg in got:
            pf = pos / neg if neg > 0 else math.inf
            rows.append(dict(kind=kind, period=period, horizon=h, n=cnt, win_rate=wr,
                             mean_net=mean, median_net=med, pf_net=pf))

assert len(rows) == 12, len(rows)  # 2 kinds x 2 periods x 3 horizons
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", newline="") as fh:
    w = csv.DictWriter(fh, fieldnames=list(rows[0]))
    w.writeheader()
    for r in rows:
        w.writerow(r)
print(f"\nwrote {OUT}")
print(f"{'kind':9}{'period':11}{'h':>3}{'n':>10}{'win':>8}{'mean':>10}{'median':>10}{'pf':>7}")
for r in rows:
    print(f"{r['kind']:9}{r['period']:11}{r['horizon']:>3}{r['n']:>10,}{r['win_rate']:>8.4f}"
          f"{r['mean_net']:>10.5f}{r['median_net']:>10.5f}{r['pf_net']:>7.3f}")
