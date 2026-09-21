"""
Buy-catalyst event study on the SIP warehouse + SEC EDGAR + corporate actions.

Question: are there public events after which in-band stocks do better than
a random in-band day, net of costs? Every event is point-in-time:

  filing events   entry at the CLOSE of the session AFTER the first session
                  on/after the filing date — the filing is public by then
                  whatever time of day it was accepted.
  technical       entry at the close of the signal day (known at the close).

Events
  8k_agreement       8-K item 1.01 (material definitive agreement)
  8k_earnings        8-K item 2.02 (results of operations)
  8k_earnings_gapup  8-K 2.02 and the next session opens >= +5% (gap known at
                     entry, which is that session's close)
  sc13d_new          SC 13D (new >5% holder with intent — activist)
  sc13g_new          SC 13G (new >5% passive holder)
  offering_priced    424B4 (an offering priced) — does the overhang clearing
                     bring a bounce?
  reverse_split      reverse split ex-date (corporate actions)
  high52w_vol        close at a new 252-session closing high on >= 2x volume

Gates at entry: raw close $0.10-$10 (band widened 2026-09-21; every result
published before that date was produced at $0.10-$5) and 20-day SIP dollar
volume >= --floor.
Returns: 1/5/20 sessions from the entry close, net of max(1%, one tick).
NOTE: this cost model has no spread term, unlike bigmove_study.py, which
charges max(1%, tick, Abdi-Ranaldo spread). Wide-spread names are therefore
undercharged here relative to the project's headline cost model (~1.22%).
Variants: all | excl_flags (drop nano-cap, shares +50% YoY, <=2Q runway, or
an offering filed in the prior 30 days). Baseline: every gated in-band day.
Periods 2016-21 and 2022+ reported separately.

    research/.venv/bin/python research/catalyst_study.py [--floor 2500000]
"""
import argparse
import datetime as dt
from pathlib import Path

import duckdb
import numpy as np
import pyarrow as pa
from numpy.lib.stride_tricks import sliding_window_view as swv

from daily_trigger_study import rolling_mean

ROOT = Path(__file__).resolve().parent
WAREHOUSE = ROOT / "data" / "stackslash.duckdb"
EDGAR = ROOT / "data" / "edgar"
CA = ROOT / "data" / "corporate_actions"
OUT = ROOT / "data" / "study_outputs"
HORIZONS = (1, 5, 20)


def build_days(con, P: float = 10.0) -> pa.Table:
    print("loading SIP daily bars for band symbols...", flush=True)
    data = con.execute(
        """
        with band_syms as (
          select symbol from sip_bars_daily_raw
          where date >= date '2016-01-01' and close between 0.10 and {P}
          group by symbol having count(*) >= 60
        )
        select s.symbol, s.date, s.open o, s.high h, s.low l, s.close c, s.volume v, r.close cr
        from sip_bars_daily_split s
        join sip_bars_daily_raw r using (symbol, date)
        join band_syms using (symbol)
        where s.date >= date '2015-01-01'
          and not (s.volume <= 0 and s.open = s.high and s.high = s.low and s.low = s.close)
        order by s.symbol, s.date
        """.replace("{P}", repr(P))
    ).fetchnumpy()
    sym = data["symbol"]
    D = data["date"].astype("datetime64[D]")
    O, H, L, C, V, CR = (data[k].astype(float) for k in ("o", "h", "l", "c", "v", "cr"))
    N = len(C)
    print(f"  {N:,} bars", flush=True)

    out = {k: np.full(N, np.nan) for k in ("dollar20", "vol_ratio", "gap", "next_cr", "next_dollar20",
                                          "next_gap", "spread_est", "next_spread")}
    out["hi252"] = np.zeros(N, dtype=bool)
    for h in HORIZONS:
        out[f"r{h}"] = np.full(N, np.nan)   # from close t
        out[f"rn{h}"] = np.full(N, np.nan)  # from close t+1

    starts = np.flatnonzero(np.r_[True, sym[1:] != sym[:-1]])
    ends = np.r_[starts[1:], N]
    for a, b in zip(starts, ends):
        n = b - a
        c, v, o, cr, d = C[a:b], V[a:b], O[a:b], CR[a:b], D[a:b]
        hh, ll = H[a:b], L[a:b]
        dollar20 = rolling_mean(c * v, 20)
        prior = np.full(n, np.nan)
        if n > 20:
            prior[20:] = rolling_mean(v, 20)[19:-1]
        with np.errstate(divide="ignore", invalid="ignore"):
            vol_ratio = np.where(prior > 0, v / prior, np.nan)
            gap = np.r_[np.nan, o[1:] / c[:-1] - 1]
        # Abdi-Ranaldo (2017) spread estimate, matching bigmove_study.py:
        # s^2 = 4 * E[(ln c_t - eta_t)(ln c_t - eta_t+1)], eta = mid log range.
        # Averaged over the 20 sessions STRICTLY BEFORE t, so a row's spread
        # uses only data available at its own close.
        spread = np.full(n, np.nan)
        with np.errstate(divide="ignore", invalid="ignore"):
            ok = (hh > 0) & (ll > 0) & (c > 0)
            eta = np.where(ok, (np.log(np.where(ok, hh, 1.0)) + np.log(np.where(ok, ll, 1.0))) / 2.0, np.nan)
            lc = np.where(ok, np.log(np.where(ok, c, 1.0)), np.nan)
            ar = np.full(n, np.nan)
            if n > 1:
                ar[1:] = 4.0 * (lc[:-1] - eta[:-1]) * (lc[:-1] - eta[1:])
            ar_pos = np.where(np.isfinite(ar), np.maximum(ar, 0.0), np.nan)
            if n > 20:
                spread[20:] = np.sqrt(rolling_mean(np.nan_to_num(ar_pos), 20)[19:-1])

        hi = np.zeros(n, dtype=bool)
        if n > 252:
            prior_max = swv(c[:-1], 252).max(axis=1)  # max of the 252 closes before t
            hi[252:] = c[252:] > prior_max
        daily = np.r_[np.nan, c[1:] / c[:-1]]
        artifact = (daily >= 10) | (daily <= 0.1)
        for h in HORIZONS:
            r = np.full(n, np.nan)
            if n > h:
                span = (d[h:] - d[:-h]).astype(int)
                bad = swv(np.r_[artifact[1:], False], h).any(axis=1)[: n - h]
                r[: n - h] = np.where((span <= h * 2 + 7) & ~bad, c[h:] / c[:-h] - 1, np.nan)
            out[f"r{h}"][a:b] = r
            rn = np.full(n, np.nan)
            rn[:-1] = r[1:]
            out[f"rn{h}"][a:b] = rn
        out["dollar20"][a:b] = dollar20
        out["vol_ratio"][a:b] = vol_ratio
        out["gap"][a:b] = gap
        out["spread_est"][a:b] = spread
        ns = np.full(n, np.nan); ns[:-1] = spread[1:]; out["next_spread"][a:b] = ns
        out["hi252"][a:b] = hi
        nc = np.full(n, np.nan); nc[:-1] = cr[1:]; out["next_cr"][a:b] = nc
        nd = np.full(n, np.nan); nd[:-1] = dollar20[1:]; out["next_dollar20"][a:b] = nd
        ng = np.full(n, np.nan); ng[:-1] = gap[1:]; out["next_gap"][a:b] = ng

    cols = {"symbol": pa.array(sym.astype(str)), "date": pa.array(D), "cr": pa.array(CR)}
    for k, arr in out.items():
        cols[k] = pa.array(arr, from_pandas=True) if arr.dtype != bool else pa.array(arr)
    return pa.table(cols)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--floor", type=float, default=2_500_000)
    ap.add_argument("--max-price", type=float, default=5.0,
                    help="upper price bound. Defaults to the live band. Anything above 5 leaves "
                         "it (docs/research-audit-plan.md 1.3c).")
    ap.add_argument("--no-spread-cost", action="store_true",
                    help="reproduce the pre-2026-09-21 cost model: max(1%%, tick) with no "
                         "spread term. For comparison only -- it undercharges wide-spread names.")
    args = ap.parse_args()
    F = args.floor
    P = args.max_price
    SPREAD_EV = '0' if args.no_spread_cost else 'coalesce(b1.spread, 0)'
    SPREAD_BASE = '0' if args.no_spread_cost else 'coalesce(spread_est, 0)'

    con = duckdb.connect()
    con.execute(f"attach '{WAREHOUSE}' as wh (read_only)")
    con.execute("use wh")
    days = build_days(con, P)
    con.execute("use memory")
    con.register("days_arrow", days)
    con.execute("create temp table days as select * from days_arrow order by symbol, date")
    e = str(EDGAR)

    con.execute(f"""
      create temp table ticker_cik as
      select ticker, min(cik) cik from (
        select ticker, cik from read_parquet('{e}/edgar_tickers.parquet')
        union select unnest(tickers) ticker, cik from read_parquet('{e}/edgar_companies.parquet')
      ) group by ticker
    """)

    print("building events...", flush=True)
    # Filing events -> first session on/after the filing date (E); entry at E+1 close.
    con.execute(f"""
      create temp table filing_events as
      with f as (
        select distinct tc.ticker symbol, fl.filing_date::date fdate,
          case
            when fl.form = '8-K' and regexp_matches(coalesce(fl.items, ''), '(^|,)1\\.01(,|$)') then '8k_agreement'
            when fl.form = '8-K' and regexp_matches(coalesce(fl.items, ''), '(^|,)2\\.02(,|$)') then '8k_earnings'
            when fl.form = 'SC 13D' then 'sc13d_new'
            when fl.form = 'SC 13G' then 'sc13g_new'
            when fl.form = '424B4' then 'offering_priced'
          end catalyst
        from read_parquet('{e}/edgar_filings.parquet') fl
        join ticker_cik tc on tc.cik = fl.cik
        where fl.form in ('8-K', 'SC 13D', 'SC 13G', '424B4') and fl.filing_date >= '2016-01-01'
      )
      select f.catalyst, d.symbol, d.date edate, d.next_cr price, d.next_dollar20 dollar20, d.next_gap,
             d.next_spread spread, d.rn1 r1, d.rn5 r5, d.rn20 r20
      from f asof join days d on f.symbol = d.symbol and f.fdate <= d.date
      where f.catalyst is not null
    """)
    con.execute("""
      insert into filing_events
      select '8k_earnings_gapup', symbol, edate, price, dollar20, next_gap, spread, r1, r5, r20
      from filing_events where catalyst = '8k_earnings' and next_gap >= 0.05
    """)
    con.execute(f"""
      insert into filing_events
      with rs as (
        select distinct symbol, ex_date::date xdate
        from read_parquet('{CA}/*.parquet', union_by_name = true)
        where type = 'reverse_splits' and ex_date between '2016-01-01' and '2030-01-01'
      )
      select 'reverse_split', d.symbol, d.date, d.next_cr, d.next_dollar20, d.next_gap, d.next_spread, d.rn1, d.rn5, d.rn20
      from rs asof join days d on rs.symbol = d.symbol and rs.xdate <= d.date
    """)
    con.execute(f"""
      insert into filing_events
      select 'high52w_vol', symbol, date, cr, dollar20, next_gap, spread_est, r1, r5, r20
      from days where hi252 and vol_ratio >= 2
    """)
    con.execute(f"""
      create temp table events as
      select distinct * from filing_events
      where price between 0.10 and {P} and dollar20 >= {F}
    """)
    for ev, n in con.execute("select catalyst, count(*) from events group by 1 order by 1").fetchall():
        print(f"  {ev:<20}{n:>8,}")

    # Point-in-time red flags at the catalyst date (as in daily_trigger_study.py).
    con.execute(f"""
      create temp table sh as select cik, filed::date filed, max(val) shares from read_parquet('{e}/edgar_facts.parquet')
      where concept in ('EntityCommonStockSharesOutstanding', 'CommonStockSharesOutstanding') and unit = 'shares' and val > 0 group by 1, 2
    """)
    con.execute(f"""
      create temp table cash as select cik, filed::date filed, max(val) cash from read_parquet('{e}/edgar_facts.parquet')
      where concept = 'CashAndCashEquivalentsAtCarryingValue' and unit = 'USD' group by 1, 2
    """)
    con.execute(f"""
      create temp table burn as select cik, filed::date filed,
        max(case when val < 0 then -val * 91.0 / date_diff('day', "start"::date, "end"::date) end) burn_q
      from read_parquet('{e}/edgar_facts.parquet')
      where concept = 'NetCashProvidedByUsedInOperatingActivities' and unit = 'USD' and "start" is not null
        and date_diff('day', "start"::date, "end"::date) between 80 and 370 group by 1, 2
    """)
    con.execute(f"""
      create temp table offers as select cik, filing_date::date fd from read_parquet('{e}/edgar_filings.parquet')
      where form in ('S-1', 'S-3', 'F-1', 'F-3', '424B4', '424B5')
    """)
    con.execute(f"""
      create temp table ev as
      with b as (select e.*, tc.cik, e.edate - interval 365 day as d1y from events e left join ticker_cik tc on tc.ticker = e.symbol),
      s1 as (select b.*, sh.shares from b asof left join sh on b.cik = sh.cik and b.edate >= sh.filed),
      s2 as (select s1.*, sh.shares shares_1y from s1 asof left join sh on s1.cik = sh.cik and s1.d1y >= sh.filed),
      c1 as (select s2.*, cash.cash from s2 asof left join cash on s2.cik = cash.cik and s2.edate >= cash.filed),
      b1 as (select c1.*, burn.burn_q from c1 asof left join burn on c1.cik = burn.cik and c1.edate >= burn.filed),
      o as (
        select b1.catalyst, b1.symbol, b1.edate, count(offers.fd) > 0 as offer30
        from b1 left join offers on offers.cik = b1.cik and offers.fd between b1.edate - interval 30 day and b1.edate
        group by 1, 2, 3
      )
      select b1.*, o.offer30,
        coalesce(b1.shares * b1.price < 50e6, false)
          or coalesce(b1.shares_1y > 0 and b1.shares / b1.shares_1y - 1 >= 0.5, false)
          or coalesce(b1.burn_q > 0 and b1.cash / b1.burn_q <= 2, false)
          or o.offer30 as flagged,
        greatest(case when b1.price >= 1 then 0.01 else 0.0001 end / b1.price, 0.01, {SPREAD_EV}) as cost
      from b1 join o using (catalyst, symbol, edate)
    """)

    def per(date_col: str) -> str:
        return f"case when {date_col} < date '2022-01-01' then '2016-21' else '2022+' end"

    union = " union all ".join(
        f"select catalyst, 'all' variant, {per('edate')} period, {h} h, r{h} gross, r{h} - cost net from ev where r{h} is not null and not isnan(r{h}) "
        f"union all select catalyst, 'excl_flags', {per('edate')}, {h}, r{h}, r{h} - cost from ev where not flagged and r{h} is not null and not isnan(r{h})"
        for h in HORIZONS
    )
    base_union = " union all ".join(
        f"select 'BASELINE (random in-band day)' catalyst, 'all' variant, {per('date')} period, {h} h, r{h} gross, "
        f"r{h} - greatest(case when cr >= 1 then 0.01 else 0.0001 end / cr, 0.01, {SPREAD_BASE}) net "
        f"from days where cr between 0.10 and {P} and dollar20 >= {F} and r{h} is not null and not isnan(r{h})"
        for h in HORIZONS
    )
    res = con.execute(f"""
      with x as ({union} union all {base_union}),
      q as (select catalyst, variant, period, h, quantile_cont(net, 0.99) q99 from x group by all)
      select x.catalyst, x.variant, x.period, x.h, count(*) n, avg((net > 0)::int) win, avg(net) mean_net,
        median(net) med_net, avg(case when net < q.q99 then net end) ex_top1,
        sum(case when net > 0 then net end) / nullif(-sum(case when net < 0 then net end), 0) pf,
        avg((abs(gross) >= 0.20)::int) big_move
      from x join q using (catalyst, variant, period, h)
      group by all order by 1, 2, 3, 4
    """).fetchall()

    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"catalyst_study_{int(F)}_{dt.datetime.now():%Y%m%dT%H%M%S}.csv"
    with open(path, "w") as fh:
        fh.write("catalyst,variant,period,horizon,n,win_rate,mean_net,median_net,mean_net_ex_top1,pf_net,big_move_20pct\n")
        for r in res:
            fh.write(",".join("" if v is None else str(v) for v in r) + "\n")

    def get(ev, var, period, h):
        for r in res:
            if r[0] == ev and r[1] == var and r[2] == period and r[3] == h:
                return r
        return None

    events = sorted({r[0] for r in res}, key=lambda s: (not s.startswith("BASELINE"), s))
    print(f"\nFloor ${F:,.0f}/day SIP. Net of max(1%, tick). 20d big move = share with |gross 20d| >= 20%.")
    hdr = f"  {'catalyst':<30}{'variant':<11}{'period':<9}{'n':>7}{'5d win':>8}{'5d net':>8}{'20d win':>8}{'20d net':>9}{'ex1%':>8}{'PF':>6}{'big20':>7}"
    print(hdr)
    for ev in events:
        for period in ("2016-21", "2022+"):
            for var in ("all", "excl_flags"):
                r5, r20 = get(ev, var, period, 5), get(ev, var, period, 20)
                if not r20:
                    continue
                w5 = f"{r5[5]*100:.0f}%" if r5 else "-"
                n5 = f"{r5[6]*100:.2f}%" if r5 else "-"
                print(f"  {ev:<30}{var:<11}{period:<9}{r20[4]:>7,}{w5:>8}{n5:>8}{r20[5]*100:>7.0f}%{r20[6]*100:>8.2f}%"
                      f"{(r20[8] or 0)*100:>7.2f}%{(r20[9] or 0):>6.2f}{r20[10]*100:>6.0f}%")
        print()
    print(f"full results: {path}")


if __name__ == "__main__":
    main()
