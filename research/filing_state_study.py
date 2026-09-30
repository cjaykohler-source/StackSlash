"""
Does a company's filing state -- cash runway, dilution, recent offering
and 8-K activity -- predict its stock's next 20/60 sessions in the
$0.10-$5 band? The price/volume family is exhausted here (breakout-study.md,
swing_backtest.py, the README's intraday schema results); this is the
causally separate family the breakout study's data audit pointed at.

Every feature is point-in-time: EDGAR facts join on `filed` (the date the
number became public), filings on filing_date <= the row's date.

FEATURES (per symbol-day)
  runway_q     cash / quarterly operating burn (latest filed of each)
  share_yoy    shares outstanding now vs one year ago (as filed)
  mcap         shares x raw close
  offer_30d    S-1/S-3/F-1/F-3 registration, or 424B4/424B5 priced
               offering, filed in the prior 30 days (split by type)
  item_302_30d 8-K item 3.02 (unregistered equity sale) in the prior 30 days
  item_101_30d 8-K item 1.01 (material agreement) in the prior 30 days

OUTCOME
  split-adjusted return, next 20 and 60 sessions from the close,
  artifact-guarded (no >=10x / <=0.1x day inside the window), reported as
  EXCESS over the same day's in-band average (removes market regime), with
  the mean winsorized at 1%/99% so a few lottery tickets can't carry it.
  Also P(ret20 <= -30%): the blow-up rate.

BAR
  Every bucket is shown. A finding needs the same sign in 2016-21 and
  2022+ independently, and a symbol-clustered bootstrap 90% interval that
  excludes zero in both. 2022+ is printed only with --holdout.

    research/.venv/bin/python research/filing_state_study.py [--floor 250000] [--holdout]
"""
import argparse
import datetime as dt
from pathlib import Path

import duckdb
import numpy as np

ROOT = Path(__file__).resolve().parent
WAREHOUSE = ROOT / "data" / "stackslash.duckdb"
EDGAR = ROOT / "data" / "edgar"
OUT = ROOT / "data" / "study_outputs"


def build(con, floor):
    e = str(EDGAR)
    print("building daily rows with forward returns...", flush=True)
    con.execute(f"""
      create temp table d as
      with band as (
        select symbol from wh.sip_bars_daily_raw
        where date >= date '2016-01-01' and close between 0.10 and 5
        group by symbol having count(*) >= 60
      ),
      b as (
        select s.symbol, s.date, s.close c, r.close cr, r.volume v,
               s.close / nullif(lag(s.close) over w, 0) ratio
        from wh.sip_bars_daily_split s
        join wh.sip_bars_daily_raw r using (symbol, date)
        join band using (symbol)
        where s.date >= date '2015-06-01'
          and not (s.volume <= 0 and s.open = s.high and s.high = s.low and s.low = s.close)
        window w as (partition by s.symbol order by s.date)
      )
      select symbol, date, cr,
        avg(cr * v) over (partition by symbol order by date rows between 19 preceding and current row) dollar20,
        lead(c, 20) over w / c - 1 as r20,
        lead(c, 60) over w / c - 1 as r60,
        max(ratio) over (partition by symbol order by date rows between 1 following and 60 following) mx60,
        min(ratio) over (partition by symbol order by date rows between 1 following and 60 following) mn60,
        max(ratio) over (partition by symbol order by date rows between 1 following and 20 following) mx20,
        min(ratio) over (partition by symbol order by date rows between 1 following and 20 following) mn20
      from b
      window w as (partition by symbol order by date)
    """)
    con.execute(f"""
      create temp table rows as
      select symbol, date, cr,
        case when mx20 < 10 and mn20 > 0.1 then r20 end r20,
        case when mx60 < 10 and mn60 > 0.1 then r60 end r60
      from d
      where date >= date '2016-01-01' and cr between 0.10 and 5 and dollar20 >= {floor}
    """)

    print("joining point-in-time EDGAR state...", flush=True)
    con.execute(f"""
      create temp table ticker_cik as
      select ticker, min(cik) cik from (
        select ticker, cik from read_parquet('{e}/edgar_tickers.parquet')
        union select unnest(tickers) ticker, cik from read_parquet('{e}/edgar_companies.parquet')
      ) group by ticker
    """)
    con.execute(f"""
      create temp table sh as
      select cik, filed::date filed, max(val) shares from read_parquet('{e}/edgar_facts.parquet')
      where concept in ('EntityCommonStockSharesOutstanding', 'CommonStockSharesOutstanding') and unit = 'shares' and val > 0
      group by 1, 2 order by 1, 2
    """)
    con.execute(f"""
      create temp table cash as
      select cik, filed::date filed, max(val) cash from read_parquet('{e}/edgar_facts.parquet')
      where concept = 'CashAndCashEquivalentsAtCarryingValue' and unit = 'USD'
      group by 1, 2 order by 1, 2
    """)
    con.execute(f"""
      create temp table burn as
      select cik, filed::date filed,
             max(-val * 91.0 / date_diff('day', "start"::date, "end"::date)) burn_q
      from read_parquet('{e}/edgar_facts.parquet')
      where concept = 'NetCashProvidedByUsedInOperatingActivities' and unit = 'USD'
        and start is not null and date_diff('day', "start"::date, "end"::date) between 80 and 370
      group by 1, 2 order by 1, 2
    """)
    con.execute(f"""
      create temp table fl as
      select cik, filing_date::date fd,
        form in ('S-1', 'S-3', 'F-1', 'F-3') as reg,
        form in ('424B4', '424B5') as priced,
        form = '8-K' and items like '%3.02%' as i302,
        form = '8-K' and items like '%1.01%' as i101
      from read_parquet('{e}/edgar_filings.parquet')
      where form in ('S-1', 'S-3', 'F-1', 'F-3', '424B4', '424B5', '8-K')
    """)
    con.execute("""
      create temp table ev as
      select cik, fd, bool_or(reg) reg, bool_or(priced) priced, bool_or(i302) i302, bool_or(i101) i101
      from fl where reg or priced or i302 or i101 group by 1, 2
    """)
    con.execute("""
      create temp table t as
      with base as (
        select r.*, tc.cik, r.date - interval 365 day as date_1y
        from rows r left join ticker_cik tc on tc.ticker = r.symbol
      ),
      a as (select b.*, sh.shares from base b asof left join sh on b.cik = sh.cik and b.date >= sh.filed),
      b2 as (select b.*, sh.shares shares_1y from a b asof left join sh on b.cik = sh.cik and b.date_1y >= sh.filed),
      c as (select b.*, cash.cash from b2 b asof left join cash on b.cik = cash.cik and b.date >= cash.filed),
      bn as (select b.*, burn.burn_q from c b asof left join burn on b.cik = burn.cik and b.date >= burn.filed),
      f30 as (
        select bn.symbol, bn.date,
          coalesce(bool_or(ev.reg), false) reg30, coalesce(bool_or(ev.priced), false) priced30,
          coalesce(bool_or(ev.i302), false) i302_30, coalesce(bool_or(ev.i101), false) i101_30
        from bn left join ev on ev.cik = bn.cik and ev.fd between bn.date - interval 30 day and bn.date
        group by 1, 2
      )
      select bn.*, f30.reg30, f30.priced30, f30.i302_30, f30.i101_30,
        bn.shares * bn.cr as mcap,
        case when bn.shares_1y > 0 then bn.shares / bn.shares_1y - 1 end as share_yoy,
        case when bn.burn_q <= 0 then 99 when bn.burn_q > 0 and bn.cash is not null then bn.cash / bn.burn_q end as runway_q
      from bn join f30 using (symbol, date)
    """)
    # winsorize 1/99 within each period FIRST, then excess over the same
    # day's in-band average of the winsorized returns -- so the benchmark
    # and the buckets are trimmed the same way
    con.execute("""
      create temp table x as
      with p as (select *, extract(year from date) < 2022 as early from t),
      q as (select early, quantile_cont(r20, 0.01) a20, quantile_cont(r20, 0.99) b20,
                          quantile_cont(r60, 0.01) a60, quantile_cont(r60, 0.99) b60 from p group by 1),
      w as (select p.*, greatest(least(r20, b20), a20) w20, greatest(least(r60, b60), a60) w60 from p join q using (early))
      select *,
        w20 - avg(w20) over (partition by date) as x20,
        w60 - avg(w60) over (partition by date) as x60
      from w
    """)
    cov = con.execute("select count(*), avg((cik is not null)::int), avg((shares is not null)::int), avg((runway_q is not null)::int) from x").fetchone()
    print(f"  {cov[0]:,} rows; mapped to a filer {cov[1]:.0%}, shares {cov[2]:.0%}, runway {cov[3]:.0%}", flush=True)


BUCKETS = {
    "runway (quarters)": ("runway_q",
        "case when runway_q is null then 'no data' when runway_q = 99 then 'cash-flow positive' when runway_q < 1 then '<1q' "
        "when runway_q < 2 then '1-2q' when runway_q < 4 then '2-4q' else '4q+' end"),
    "shares YoY": ("share_yoy",
        "case when share_yoy is null then 'no data' when share_yoy < 0.05 then '<5%' when share_yoy < 0.25 then '5-25%' "
        "when share_yoy < 1 then '25-100%' when share_yoy < 3 then '1-3x more' else '3x+ more' end"),
    "market cap": ("mcap",
        "case when mcap is null then 'no data' when mcap < 10e6 then '<$10M' when mcap < 50e6 then '$10-50M' "
        "when mcap < 250e6 then '$50-250M' else '$250M+' end"),
    "registration S-1/S-3 30d": ("reg30", "case when reg30 then 'filed' else 'none' end"),
    "priced offering 424B 30d": ("priced30", "case when priced30 then 'filed' else 'none' end"),
    "8-K 3.02 30d": ("i302_30", "case when i302_30 then 'filed' else 'none' end"),
    "8-K 1.01 30d": ("i101_30", "case when i101_30 then 'filed' else 'none' end"),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--floor", type=float, default=250_000)
    ap.add_argument("--boot", type=int, default=300)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--holdout", action="store_true")
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)

    con = duckdb.connect()
    con.execute(f"attach '{WAREHOUSE}' as wh (read_only)")
    build(con, args.floor)

    lines = []

    def out(s=""):
        print(s, flush=True)
        lines.append(s)

    periods = [("2016-21", True)] + ([("2022+", False)] if args.holdout else [])
    out(f"floor=${args.floor:,.0f}; excess = return minus same-day in-band mean, winsorized 1/99; CI symbol-clustered")
    for label, (_, bucket_sql) in BUCKETS.items():
        out(f"\n--- {label} ---")
        out(f"  {'period':<9}{'bucket':<20}{'n':>10}{'syms':>6}{'x20':>8}{'90% CI':>18}{'x60':>8}{'90% CI':>18}{'med r20':>9}{'P(r20<=-30%)':>13}")
        for pname, early in periods:
            q = con.execute(f"""
              select {bucket_sql} as bucket, symbol, x20, x60, r20
              from x where early = {early} and x20 is not null
            """).fetchnumpy()
            bk, sy = q["bucket"].astype(str), q["symbol"].astype(str)
            x20, x60, r20 = (np.asarray(q[k], float) for k in ("x20", "x60", "r20"))
            for bname in sorted(set(bk)):
                m = bk == bname
                if m.sum() < 1000:
                    continue
                res = []
                for arr in (x20, x60):
                    ok = m & ~np.isnan(arr)
                    us, inv = np.unique(sy[ok], return_inverse=True)
                    tot, cnt = np.bincount(inv, weights=arr[ok]), np.bincount(inv)
                    bm = [(w @ tot) / max(w @ cnt, 1) for w in
                          (np.bincount(rng.integers(0, len(us), len(us)), minlength=len(us)) for _ in range(args.boot))]
                    lo, hi = np.percentile(bm, [5, 95])
                    res.append((arr[ok].mean(), lo, hi))
                (m20, l20, h20), (m60, l60, h60) = res
                out(f"  {pname:<9}{bname:<20}{m.sum():>10,}{len(set(sy[m])):>6,}{m20*100:>7.2f}% [{l20*100:>6.2f},{h20*100:>6.2f}]"
                    f"{m60*100:>7.2f}% [{l60*100:>6.2f},{h60*100:>6.2f}]{np.nanmedian(r20[m])*100:>8.1f}%{np.nanmean(r20[m] <= -0.30)*100:>12.1f}%")

    OUT.mkdir(parents=True, exist_ok=True)
    ts = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    path = OUT / f"filing_state_study_{ts}.txt"
    path.write_text("\n".join(lines) + "\n")
    print(f"\nwrote {path}")


if __name__ == "__main__":
    main()
