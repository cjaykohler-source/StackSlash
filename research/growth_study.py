"""
Does point-in-time revenue growth RANK catalyst candidates?

Pre-registered in docs/growth-prereg.md on 2026-09-22, before any return
was computed. Read that first; this script implements it and nothing else.

This is docs/selection-logic.md M.1 ("does relative quality beat absolute
flagging?") with revenue growth in place of cash runway. Growth is tested
as a RANKING input inside the existing 8-K 2.02 pool -- never as a reason
for a name to appear on the list. A standalone growth screen would be a
new mechanism and is out of scope.

Population: identical to catalyst_study.py's `8k_earnings` event, so the
numbers are directly comparable to the audited catalyst result. Entry at
the close of the session after the first session on/after the filing
date; raw close $0.10 to --max-price; 20-day SIP dollar volume >= --floor;
costs max(1%, one tick, Abdi-Ranaldo spread).

Feature (all of it strictly filed <= the event date):
  quarterly facts only (80-100 day duration, USD)
  first-reported value per (cik, concept, period end) -- no restatement leak
  Q0    latest period end among facts filed by the event
  Q-4   SAME concept, period end within +-45d of Q0.end - 365d
  gates Q-4 > 0, and Q0.end within --max-stale days of the event
An 8-K 2.02 IS the earnings release, so the quarter being announced is not
yet in XBRL. Q0 is the PREVIOUSLY filed quarter -- what a reader could know
before the open, and the only point-in-time honest version.

    research/.venv/bin/python research/growth_study.py
    research/.venv/bin/python research/growth_study.py --negative-control
"""
import argparse
import datetime as dt
from pathlib import Path

import duckdb

from catalyst_study import EDGAR, HORIZONS, OUT, WAREHOUSE, build_days

REV = ("Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--floor", type=float, default=2_500_000)
    ap.add_argument("--max-price", type=float, default=5.0)
    ap.add_argument("--max-stale", type=int, default=180,
                    help="Q0's period end must be within this many days of the event. "
                         "Pre-registered at 180: the 75th pct of the raw gap is 412 days "
                         "and the 95th is 2,317, from delinquent filers.")
    ap.add_argument("--min-base-rev", type=float, default=0.0,
                    help="secondary S1: require Q-4 revenue >= this. 0 = primary analysis.")
    ap.add_argument("--feature", choices=("growth", "opcf"), default="growth",
                    help="secondary S3: `opcf` replaces revenue growth with the most recent "
                         "quarterly operating cash flow, scaled by |revenue| to make it "
                         "comparable across sizes. Same pool, same gates, same metrics.")
    ap.add_argument("--all-8k", action="store_true",
                    help="secondary S2: every material 8-K, not just item 2.02.")
    ap.add_argument("--negative-control", action="store_true",
                    help="permute growth across events sharing an entry date. The Q4-Q1 "
                         "difference must collapse to ~0; if it survives, the run is withdrawn.")
    ap.add_argument("--seed", type=int, default=20260922)
    ap.add_argument("--control-reps", type=int, default=1,
                    help="repeat the permutation N times and report the distribution of "
                         "Q4-Q1. One draw cannot tell you the noise floor.")
    args = ap.parse_args()
    F, P, e = args.floor, args.max_price, str(EDGAR)

    con = duckdb.connect()
    con.execute(f"attach '{WAREHOUSE}' as wh (read_only)")
    con.execute("use wh")
    days = build_days(con, P)
    con.execute("use memory")
    con.register("days_arrow", days)
    con.execute("create temp table days as select * from days_arrow order by symbol, date")

    con.execute(f"""
      create temp table ticker_cik as
      select ticker, min(cik) cik from (
        select ticker, cik from read_parquet('{e}/edgar_tickers.parquet')
        union select unnest(tickers) ticker, cik from read_parquet('{e}/edgar_companies.parquet')
      ) group by ticker
    """)

    # --- the pool: 8-K 2.02, entry at E+1's close (catalyst_study's `8k_earnings`)
    item = ("regexp_matches(coalesce(fl.items, ''), '(^|,)2\\.02(,|$)')"
            if not args.all_8k else "coalesce(fl.items, '') <> ''")
    print("building the 8-K pool...", flush=True)
    con.execute(f"""
      create temp table pool as
      with f as (
        select distinct tc.ticker symbol, tc.cik, fl.filing_date::date fdate
        from read_parquet('{e}/edgar_filings.parquet') fl
        join ticker_cik tc on tc.cik = fl.cik
        where fl.form = '8-K' and {item} and fl.filing_date >= '2016-01-01'
      )
      select distinct f.cik, d.symbol, d.date edate, d.next_cr price, d.next_dollar20 dollar20,
             d.next_spread spread, d.rn20 r20, d.mfen20 mfe20, d.maen20 mae20,
             d.rn1 r1, d.rn5 r5
      from f asof join days d on f.symbol = d.symbol and f.fdate <= d.date
      where d.next_cr between 0.10 and {P} and d.next_dollar20 >= {F}
        and d.rn20 is not null and not isnan(d.rn20)
    """)
    n_pool = con.execute("select count(*) from pool").fetchone()[0]
    print(f"  {n_pool:,} events with a 20-day outcome")

    # --- the feature, strictly point-in-time
    con.execute(f"""
      create temp table rev1 as
      with q as (
        select cik, concept, filed::date filed, "end"::date pend, val
        from read_parquet('{e}/edgar_facts.parquet')
        where concept in {REV} and unit = 'USD'
          and start is not null and "end" is not null
          and date_diff('day', start::date, "end"::date) between 80 and 100
      )
      select cik, concept, pend, min(filed) filed, arg_min(val, filed) val
      from q group by 1, 2, 3
    """)
    con.execute(f"""
      create temp table growth as
      with q0 as (
        select p.symbol, p.edate, p.cik, r.concept, r.pend, r.val
        from pool p join rev1 r on r.cik = p.cik and r.filed <= p.edate
        qualify row_number() over (
          partition by p.symbol, p.edate, r.concept order by r.pend desc) = 1
      ),
      y as (
        select q.symbol, q.edate, q.concept, q.pend, q.val rev0, pr.val rev_1y,
               (q.val - pr.val) / abs(pr.val) g
        from q0 q
        join rev1 pr on pr.cik = q.cik and pr.concept = q.concept and pr.filed <= q.edate
         and abs(date_diff('day', pr.pend, q.pend - interval 365 day)) <= 45
        where pr.val > 0
          and date_diff('day', q.pend, q.edate) <= {args.max_stale}
          and pr.val >= {args.min_base_rev}
      )
      -- concept preference when both are present, pre-registered
      select symbol, edate, concept, g, rev0, rev_1y from y
      qualify row_number() over (partition by symbol, edate order by
        case when concept = 'RevenueFromContractWithCustomerExcludingAssessedTax'
             then 0 else 1 end) = 1
    """)

    if args.feature == "opcf":
        # S3. Same construction as the revenue feature: quarterly duration,
        # first-reported value, filed <= the event, same staleness gate.
        # Scaled by |revenue| so the quartiles are not just a size sort.
        con.execute(f"""
          create or replace temp table growth as
          with q as (
            select cik, filed::date filed, "end"::date pend, val
            from read_parquet('{e}/edgar_facts.parquet')
            where concept = 'NetCashProvidedByUsedInOperatingActivities' and unit = 'USD'
              and start is not null and "end" is not null
              and date_diff('day', start::date, "end"::date) between 80 and 100
          ),
          o1 as (select cik, pend, min(filed) filed, arg_min(val, filed) val from q group by 1, 2),
          o0 as (
            select p.symbol, p.edate, o.pend, o.val
            from pool p join o1 o on o.cik = p.cik and o.filed <= p.edate
            where date_diff('day', o.pend, p.edate) <= {args.max_stale}
            qualify row_number() over (partition by p.symbol, p.edate order by o.pend desc) = 1
          )
          select o0.symbol, o0.edate, 'opcf' concept,
                 o0.val / nullif(abs(g.rev0), 0) g, o0.val rev0, g.rev0 rev_1y
          from o0 join growth g using (symbol, edate)
          where g.rev0 <> 0
        """)

    con.execute(f"""
      create temp table ev as
      select p.*, g.g growth, g.rev_1y,
        greatest(case when p.price >= 1 then 0.01 else 0.0001 end / p.price, 0.01,
                 coalesce(p.spread, 0)) as cost,
        case when p.edate < date '2022-01-01' then '2016-21' else '2022+' end period
      from pool p left join growth g using (symbol, edate)
    """)
    def permute(rep: int) -> None:
        """Permute growth across the events of the same period, leaving every
        return untouched. Built as its own table: reading from `ev` while
        replacing it is self-referential and silently fans the rows out."""
        con.execute(f"select setseed({((args.seed + rep * 7919) % 997) / 997.0})")
        con.execute("drop table if exists shuffled")
        con.execute("""
          create temp table shuffled as
          with r as (select symbol, edate, period, growth,
                       row_number() over (partition by period order by symbol, edate) j
                     from ev_base where growth is not null),
          p as (select period, growth,
                  row_number() over (partition by period order by random()) j from r)
          select r.symbol, r.edate, p.growth from r join p using (period, j)
        """)
        n_ev = con.execute("select count(*) from ev_base").fetchone()[0]
        con.execute("drop table if exists ev")
        con.execute("""
          create temp table ev as
          select e.* replace (s.growth as growth)
          from ev_base e left join shuffled s using (symbol, edate)
        """)
        assert con.execute("select count(*) from ev").fetchone()[0] == n_ev, "control fanned rows out"

    con.execute("create temp table ev_base as select * from ev")
    if args.negative_control:
        permute(0)

    cov = con.execute("""
      select period, count(*) n, count(growth) with_g, count(*) - count(growth) no_g
      from ev group by 1 order by 1""").fetchall()
    print(f"\ncoverage (max-stale {args.max_stale}d, min base rev ${args.min_base_rev:,.0f}):")
    for period, n, wg, ng in cov:
        print(f"  {period:<9} {n:>6,} events   {wg:>6,} with growth ({wg/n*100:.0f}%)   {ng:>6,} without")

    con.execute("""
      create temp table q as
      select *, ntile(4) over (partition by period order by growth) quartile
      from ev where growth is not null
    """)

    def stats(where: str, label_sql: str, src: str = "q") -> list:
        return con.execute(f"""
          with x as (select {label_sql} cell, period, r20 - cost net, r20 gross,
                            mfe20, mae20, growth from {src} where {where}),
          qq as (select cell, period, quantile_cont(net, 0.99) q99 from x group by 1, 2)
          select x.cell, x.period, count(*) n,
            avg((net > 0)::int) win, avg(net) mean, median(net) med,
            avg(case when net < qq.q99 then net end) ex1,
            sum(case when net > 0 then net end) / nullif(-sum(case when net < 0 then net end), 0) pf,
            avg((mfe20 >= 0.10)::int) / nullif(avg((mae20 <= -0.10)::int), 0) ud10,
            avg((mfe20 >= 0.20)::int) / nullif(avg((mae20 <= -0.20)::int), 0) ud20,
            median(growth) medg
          from x join qq using (cell, period) group by all order by 2, 1
        """).fetchall()

    rows = stats("true", "'Q' || quartile")
    rows += stats("growth is null", "'no-data'", "ev")
    rows += stats("true", "'POOL (all events)'", "ev")

    hdr = (f"  {'cell':<20}{'period':<9}{'n':>7}{'med g':>9}{'20d win':>9}{'20d net':>9}"
           f"{'median':>9}{'ex1%':>9}{'PF':>7}{'U:D10':>7}{'U:D20':>7}")
    print(f"\nFloor ${F:,.0f}/day, <=${P}. 20-day, net of max(1%, tick, spread).")
    if args.negative_control:
        print("  *** NEGATIVE CONTROL: growth permuted within period. Q4-Q1 must be ~0. ***")
    print(hdr)
    last = None
    for c, per, n, win, mean, med, ex1, pf, ud10, ud20, medg in rows:
        if last and last != per:
            print()
        last = per
        g = f"{medg*100:>8.0f}%" if medg is not None else "        -"
        print(f"  {c:<20}{per:<9}{n:>7,}{g}{win*100:>8.0f}%{mean*100:>8.2f}%{med*100:>8.2f}%"
              f"{(ex1 or 0)*100:>8.2f}%{(pf or 0):>7.2f}{(ud10 or 0):>7.2f}{(ud20 or 0):>7.2f}")

    print("\n--- pre-registered pass conditions ---")
    by = {(r[0], r[1]): r for r in rows}
    ok = True
    for per in ("2016-21", "2022+"):
        q1, q4 = by.get(("Q1", per)), by.get(("Q4", per))
        if not q1 or not q4:
            continue
        d = (q4[3] - q1[3]) * 100
        c1 = abs(d) >= 5.0
        c2 = q4[8] >= q1[8] and q4[9] >= q1[9]
        ok &= c1 and c2
        print(f"  {per:<9} Q4-Q1 net win rate {d:+.1f}pp  (>= 5pp: {'yes' if c1 else 'NO'})"
              f"   U:D Q4>=Q1 at both thresholds: {'yes' if c2 else 'NO'}"
              f"  [{q4[8]:.2f} vs {q1[8]:.2f}, {q4[9]:.2f} vs {q1[9]:.2f}]")
    signs = [by[("Q4", p)][3] - by[("Q1", p)][3] for p in ("2016-21", "2022+") if ("Q4", p) in by]
    same = len(signs) == 2 and signs[0] * signs[1] > 0
    print(f"  same sign in both periods: {'yes' if same else 'NO'}")
    print(f"  VERDICT: {'PASS' if ok and same else 'FAIL — growth does not rank catalyst candidates'}")

    if args.negative_control and args.control_reps > 1:
        # One shuffle draw cannot tell you the noise floor. Repeat it and
        # report the distribution of the very statistic the pass threshold
        # is stated in.
        draws = {"2016-21": [], "2022+": []}
        for rep in range(args.control_reps):
            permute(rep)
            con.execute("drop table if exists q")
            con.execute("""
              create temp table q as
              select *, ntile(4) over (partition by period order by growth) quartile
              from ev where growth is not null""")
            d = {(r[0], r[1]): r for r in stats("true", "'Q' || quartile")}
            for per in draws:
                if ("Q4", per) in d and ("Q1", per) in d:
                    draws[per].append((d[("Q4", per)][3] - d[("Q1", per)][3]) * 100)
        print(f"\n--- noise floor: Q4-Q1 net win rate over {args.control_reps} permutations ---")
        for per, v in draws.items():
            v = sorted(v)
            mx = max(abs(x) for x in v)
            print(f"  {per:<9} median {v[len(v)//2]:+.1f}pp   "
                  f"p05 {v[int(len(v)*0.05)]:+.1f}pp   p95 {v[int(len(v)*0.95)]:+.1f}pp   "
                  f"largest |draw| {mx:.1f}pp")
        print("  The pre-registered bar is 5.0pp in a single period. Compare it to the"
              "\n  largest |draw| above before reading any single-period difference.")

    OUT.mkdir(parents=True, exist_ok=True)
    tag = "control" if args.negative_control else "primary"
    path = OUT / f"growth_study_{tag}_{dt.datetime.now():%Y%m%dT%H%M%S}.csv"
    with open(path, "w") as fh:
        fh.write("cell,period,n,median_growth,win_rate,mean_net,median_net,"
                 "mean_net_ex_top1,pf_net,ud_10pct,ud_20pct\n")
        for c, per, n, win, mean, med, ex1, pf, ud10, ud20, medg in rows:
            fh.write(f"{c},{per},{n},{medg},{win},{mean},{med},{ex1},{pf},{ud10},{ud20}\n")
    print(f"\nfull results: {path}")


if __name__ == "__main__":
    main()
