"""
Daily trigger study on the clean SIP warehouse, with point-in-time exclusions.

Replays the enabled after-close buy setups exactly as eod-scan computes them
(same indicator formulas as netlify/functions/lib/indicators.ts, same gates:
$0.10-$10 price band, 20-day dollar-volume floor, RSI(14) <= 85 for longs,
risk-on regime) over SIP consolidated daily bars 2016 -> today, zero-volume
placeholder bars removed. Scores 1/5/10/20-session close-to-close returns net
of a round-trip cost of max(1%, one tick).

Each setup is reported under five variants, to test whether removing the
known disaster tail lifts results:
  all          every fire
  excl_vol25   drop fires at >= 25x normal volume
  excl_offer   drop fires with an S-1 / S-3 / F-1 / F-3 / 424B4 / 424B5
               filed in the prior 30 days
  excl_red     drop red-flag names: nano-cap (< $50M), shares +50% YoY, or
               <= 2 quarters of cash runway (EDGAR facts filed on or before
               the fire date — point-in-time)
  excl_all     all three exclusions

Discovery (2016-2021) and holdout (2022+) are reported separately.

    research/.venv/bin/python research/daily_trigger_study.py [--floor 2500000]
"""
import argparse
import datetime as dt
from pathlib import Path

import duckdb
import numpy as np
import pyarrow as pa
from numpy.lib.stride_tricks import sliding_window_view as swv

ROOT = Path(__file__).resolve().parent
WAREHOUSE = ROOT / "data" / "stackslash.duckdb"
EDGAR = ROOT / "data" / "edgar"
OUT = ROOT / "data" / "study_outputs"
HORIZONS = (1, 5, 10, 20)
OFFER_FORMS = ("S-1", "S-3", "F-1", "F-3", "424B4", "424B5")


def rolling_mean(x: np.ndarray, n: int) -> np.ndarray:
    """Mean of the n values ending at each index (NaN until n are available)."""
    out = np.full(len(x), np.nan)
    if len(x) >= n:
        cs = np.cumsum(np.insert(x, 0, 0.0))
        out[n - 1:] = (cs[n:] - cs[:-n]) / n
    return out


def finite_ema(x: np.ndarray, p: int) -> np.ndarray:
    """indicators.ts ema(): seeded at the close p bars back, then p-1 EMA steps."""
    out = np.full(len(x), np.nan)
    if len(x) < p:
        return out
    k = 2 / (p + 1)
    w = np.array([(1 - k) ** (p - 1)] + [k * (1 - k) ** (p - 1 - i) for i in range(1, p)])
    valid = ~np.isnan(x)
    windows = swv(np.where(valid, x, 0.0), p)
    ok = swv(valid, p).all(axis=1)
    vals = windows @ w
    out[p - 1:] = np.where(ok, vals, np.nan)
    return out


def rsi(c: np.ndarray, p: int) -> np.ndarray:
    """indicators.ts rsi(): simple average gain/loss over the last p changes."""
    out = np.full(len(c), np.nan)
    if len(c) < p + 1:
        return out
    ch = np.diff(c)
    g = rolling_mean(np.clip(ch, 0, None), p) * p
    l = rolling_mean(np.clip(-ch, 0, None), p) * p
    with np.errstate(divide="ignore", invalid="ignore"):
        r = np.where(l == 0, 100.0, 100 - 100 / (1 + g / l))
    out[1:] = r
    return out


def spy_risk_on(con) -> dict:
    rows = con.execute(
        "select date, close from sip_bars_daily_split where symbol = 'SPY' order by date"
    ).fetchnumpy()
    d, c = rows["date"], rows["close"].astype(float)
    sma200 = rolling_mean(c, 200)
    lr = np.diff(np.log(c))
    vol = np.full(len(c), np.nan)
    if len(lr) >= 20:
        win = swv(lr, 20)
        vol[20:] = win.std(axis=1) * np.sqrt(252)
    on = (c > sma200) & ~(vol > 0.25) & ~np.isnan(sma200) & ~np.isnan(vol)
    return {dd: bool(o) for dd, o in zip(d.astype("datetime64[D]"), on)}


def compute_fires(con, floor: float):
    print("loading SIP daily bars for band symbols...", flush=True)
    data = con.execute(
        """
        with band_syms as (
          select symbol from sip_bars_daily_raw
          where date >= date '2016-01-01' and close between 0.10 and 10
          group by symbol having count(*) >= 60
        )
        select s.symbol, s.date, s.close as c, s.volume as v, r.close as cr
        from sip_bars_daily_split s
        join sip_bars_daily_raw r using (symbol, date)
        join band_syms using (symbol)
        where s.date >= date '2015-01-01'
          and not (s.volume <= 0 and s.open = s.high and s.high = s.low and s.low = s.close)
        order by s.symbol, s.date
        """
    ).fetchnumpy()
    sym = data["symbol"]
    dates = data["date"].astype("datetime64[D]")
    C = data["c"].astype(float)
    V = data["v"].astype(float)
    CR = data["cr"].astype(float)
    print(f"  {len(C):,} bars, {len(np.unique(sym)):,} symbols", flush=True)
    risk = spy_risk_on(con)
    risk_arr = np.array([risk.get(d, False) for d in dates])

    starts = np.flatnonzero(np.r_[True, sym[1:] != sym[:-1]])
    ends = np.r_[starts[1:], len(sym)]
    cols = {k: [] for k in ("symbol", "date", "trigger", "price", "vol_ratio")}
    for h in HORIZONS:
        cols[f"r{h}"] = []

    for a, b in zip(starts, ends):
        n = b - a
        if n < 60:
            continue
        c, v, cr, d, ro = C[a:b], V[a:b], CR[a:b], dates[a:b], risk_arr[a:b]

        mid = rolling_mean(c, 20)
        var = np.clip(rolling_mean(c * c, 20) - mid * mid, 0, None)
        sd = np.sqrt(var)
        upper, lower = mid + 2 * sd, mid - 2 * sd
        with np.errstate(divide="ignore", invalid="ignore"):
            pctb = np.where(upper == lower, 0.5, (c - lower) / (upper - lower))
            width = np.where(mid == 0, 0.0, (upper - lower) / mid)
        wpct = np.full(n, np.nan)
        if n >= 126 + 19:
            ww = swv(width[19:], 126)
            wpct[19 + 125:] = (ww < ww[:, -1:]).sum(axis=1) / 126
        rsi2, rsi14 = rsi(c, 2), rsi(c, 14)
        prior_vol = np.full(n, np.nan)
        prior_vol[20:] = rolling_mean(v, 20)[19:-1]
        with np.errstate(divide="ignore", invalid="ignore"):
            vol_ratio = np.where(prior_vol > 0, v / prior_vol, np.nan)
        dollar20 = rolling_mean(c * v, 20)
        macd = finite_ema(c, 12) - finite_ema(c, 26)
        signal = finite_ema(macd, 9)
        hist = macd - signal
        cross_up = np.zeros(n, dtype=bool)
        cross_up[1:] = (hist[:-1] <= 0) & (hist[1:] > 0)

        gate = (cr >= 0.10) & (cr <= 5.0) & (dollar20 >= floor) & ~(rsi14 > 85) & ro
        fires = {
            "bb_rsi_confluence_long": gate & (pctb <= 0.05) & (rsi2 <= 10),
            "macd_bullish_cross": gate & cross_up,
            "volatility_squeeze_breakout_long": gate & (wpct <= 0.1) & (pctb >= 1) & (vol_ratio >= 2),
        }

        # forward returns with gap / split-artifact guards
        fwd = {}
        daily = np.r_[np.nan, c[1:] / c[:-1]]
        artifact = (daily >= 10) | (daily <= 0.1)
        for h in HORIZONS:
            r = np.full(n, np.nan)
            if n > h:
                span = (d[h:] - d[:-h]).astype(int)
                ok = span <= h * 2 + 7
                bad = swv(np.r_[artifact[1:], False], h).any(axis=1)[: n - h] if n - 1 >= h else np.zeros(n - h, bool)
                r[: n - h] = np.where(ok & ~bad, c[h:] / c[:-h] - 1, np.nan)
            fwd[h] = r

        for name, mask in fires.items():
            idx = np.flatnonzero(mask)
            if not len(idx):
                continue
            cols["symbol"].extend([sym[a]] * len(idx))
            cols["date"].extend(d[idx].tolist())
            cols["trigger"].extend([name] * len(idx))
            cols["price"].extend(cr[idx].tolist())
            cols["vol_ratio"].extend(vol_ratio[idx].tolist())
            for h in HORIZONS:
                cols[f"r{h}"].extend(fwd[h][idx].tolist())

    table = pa.table(cols)
    print(f"  {table.num_rows:,} fires", flush=True)
    return table


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--floor", type=float, default=2_500_000, help="20-day SIP dollar-volume floor (production alert floor)")
    args = ap.parse_args()

    con = duckdb.connect()
    con.execute(f"attach '{WAREHOUSE}' as wh (read_only)")
    con.execute("use wh")
    fires = compute_fires(con, args.floor)
    con.execute("use memory")
    con.register("fires_arrow", fires)
    con.execute("create temp table fires as select * from fires_arrow")

    e = str(EDGAR)
    con.execute(f"""
      create temp table ticker_cik as
      select ticker, min(cik) cik from (
        select ticker, cik from read_parquet('{e}/edgar_tickers.parquet')
        union
        select unnest(tickers) ticker, cik from read_parquet('{e}/edgar_companies.parquet')
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
             max(case when val < 0 then -val * 91.0 / date_diff('day', "start"::date, "end"::date) end) burn_q
      from read_parquet('{e}/edgar_facts.parquet')
      where concept = 'NetCashProvidedByUsedInOperatingActivities' and unit = 'USD'
        and start is not null and date_diff('day', "start"::date, "end"::date) between 80 and 370
      group by 1, 2 order by 1, 2
    """)
    forms = ", ".join(f"'{f}'" for f in OFFER_FORMS)
    con.execute(f"""
      create temp table offers as
      select cik, filing_date::date fd from read_parquet('{e}/edgar_filings.parquet') where form in ({forms})
    """)

    print("joining point-in-time EDGAR flags...", flush=True)
    con.execute("""
      create temp table t as
      with base as (
        select f.*, tc.cik, f.date - interval 365 day as date_1y
        from fires f left join ticker_cik tc on tc.ticker = f.symbol
      ),
      s_now as (select b.*, sh.shares from base b asof left join sh on b.cik = sh.cik and b.date >= sh.filed),
      s_1y as (select b.*, sh.shares shares_1y from s_now b asof left join sh on b.cik = sh.cik and b.date_1y >= sh.filed),
      c_now as (select b.*, cash.cash from s_1y b asof left join cash on b.cik = cash.cik and b.date >= cash.filed),
      bn as (select b.*, burn.burn_q from c_now b asof left join burn on b.cik = burn.cik and b.date >= burn.filed),
      off as (
        select b.symbol, b.date, b.trigger, count(o.fd) > 0 as offer30
        from bn b left join offers o on o.cik = b.cik and o.fd between b.date - interval 30 day and b.date
        group by 1, 2, 3
      )
      select bn.*, off.offer30,
        coalesce(bn.vol_ratio >= 25, false) as vol25,
        coalesce(bn.shares * bn.price < 50e6, false) as nano,
        coalesce(bn.shares_1y > 0 and bn.shares / bn.shares_1y - 1 >= 0.5, false) as dilution50,
        coalesce(bn.burn_q > 0 and bn.cash / bn.burn_q <= 2, false) as runway2q,
        greatest(case when bn.price >= 1 then 0.01 else 0.0001 end / bn.price, 0.01) as cost
      from bn join off using (symbol, date, trigger)
    """)
    cov = con.execute("select avg(case when cik is not null then 1 else 0 end), avg(case when shares is not null then 1 else 0 end), count(*) from t").fetchone()
    print(f"  EDGAR coverage: {cov[0]*100:.0f}% of fires mapped to a filer, {cov[1]*100:.0f}% have shares-outstanding data ({cov[2]:,} fires)")

    con.execute("""
      create temp table v as
      select *, 'all' variant from t
      union all select *, 'excl_vol25' from t where not vol25
      union all select *, 'excl_offer' from t where not offer30
      union all select *, 'excl_red' from t where not (nano or dilution50 or runway2q)
      union all select *, 'excl_all' from t where not (vol25 or offer30 or nano or dilution50 or runway2q)
    """)
    horizon_union = " union all ".join(
        f"select trigger, variant, case when date < date '2022-01-01' then '2016-21' else '2022+' end period, {h} h, r{h} gross, r{h} - cost net from v where r{h} is not null and not isnan(r{h})"
        for h in HORIZONS
    )
    res = con.execute(f"""
      with x as ({horizon_union}),
      q as (select trigger, variant, period, h, quantile_cont(net, 0.99) q99 from x group by all)
      select x.trigger, x.variant, x.period, x.h, count(*) n,
        avg((net > 0)::int) win, avg(net) mean_net, median(net) med_net,
        avg(case when net < q.q99 then net end) ex_top1, avg(gross) mean_gross,
        sum(case when net > 0 then net end) / nullif(-sum(case when net < 0 then net end), 0) pf
      from x join q using (trigger, variant, period, h)
      group by all order by 1, 3, 4, 2
    """).fetchall()

    OUT.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    path = OUT / f"daily_trigger_study_{int(args.floor)}_{stamp}.csv"
    with open(path, "w") as fh:
        fh.write("trigger,variant,period,horizon,n,win_rate,mean_net,median_net,mean_net_ex_top1,mean_gross,pf_net\n")
        for r in res:
            fh.write(",".join("" if x is None else str(x) for x in r) + "\n")

    order = ["all", "excl_vol25", "excl_offer", "excl_red", "excl_all"]
    for trig in sorted({r[0] for r in res}):
        print(f"\n=== {trig}  (floor ${args.floor:,.0f}/day SIP)")
        print(f"  {'variant':<11}{'period':<9}" + "".join(f"{'|  ' + str(h) + 'd n':>11}{'win':>6}{'net':>8}{'ex1%':>8}{'PF':>6}" for h in (5, 20)))
        for period in ("2016-21", "2022+"):
            for var in order:
                line = f"  {var:<11}{period:<9}"
                for h in (5, 20):
                    m = [r for r in res if r[0] == trig and r[1] == var and r[2] == period and r[3] == h]
                    if not m:
                        line += f"{'|':>3}{'-':>8}{'':>28}"
                        continue
                    _, _, _, _, n, win, mean_net, _, ex1, _, pf = m[0]
                    line += f"{'|':>3}{n:>8,}{win*100:>5.0f}%{mean_net*100:>7.2f}%{(ex1 or 0)*100:>7.2f}%{(pf or 0):>6.2f}"
                print(line)
    print(f"\nfull results: {path}")


if __name__ == "__main__":
    main()
