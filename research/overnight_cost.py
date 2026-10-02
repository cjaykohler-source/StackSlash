"""
Overnight cost check (README item 40). overnight_cycle.py found a ~+0.6-0.9%
gross close -> next-open return on lead-up-flagged stocks that a flat 1% round
trip erased. Here the cost is each stock's OWN estimated spread, and the
question is whether any price x liquidity bucket keeps a net overnight edge.

Fixed before running. 2016-2021 only; 2022+ stays sealed.

TRADE      buy at day t's close (market-on-close), sell at t+1's open; split-adjusted;
           nights with a >= 10x or <= 0.1x close-to-close ratio dropped
GROUPS     all  = every eligible stock-day: raw close $0.10-$5 and 20-day dollar volume
                  >= $250k at t, >= 60 sessions of history
           flag = the overnight_cycle.py lead-up flag on top (ATR14 >= 8% of price, close
                  <= 60% of the 252-session high, volume building) -- identical definition
COST       round-trip spread estimate from the stock's own last 20 sessions through t
           (Abdi & Ranaldo 2017, as the production refresh-spread-estimates job):
             s^2 = mean over t-19..t of 4 (c_d - eta_d)(c_d - eta_{d+1}) with log prices,
             eta = (log high + log low) / 2, negatives floored at 0 per pair;
           cost = max(s, one tick / raw close) -- half the spread paid each way
BUCKETS    raw close $0.10-0.50 / 0.50-1 / 1-2 / 2-5  x  20-day dollar volume
           $250k-1M / 1-5M / 5-25M / >= 25M
STAGE A (2016-19): per bucket and group, mean net return with a day-clustered bootstrap
           90% interval. A bucket is carried if the mean net > 0 and the lower bound > 0.
STAGE B (2020-21, once): the carried buckets only. PASS = mean net > 0, lower 90% bound
           > 0, and the median gross return > the median cost (the typical night, not
           only the average, clears its own spread).

    research/.venv/bin/python research/overnight_cost.py
"""
import datetime as dt
import sys
from pathlib import Path

import duckdb
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view as swv

ROOT = Path(__file__).resolve().parent
WAREHOUSE = ROOT / "data" / "stackslash.duckdb"
OUT = ROOT / "data" / "study_outputs"
PRICE = [(0.10, 0.50), (0.50, 1), (1, 2), (2, 5)]
DV = [(250e3, 1e6), (1e6, 5e6), (5e6, 25e6), (25e6, np.inf)]
BOOT, SEED = 1000, 7
# --minute-cost (exploratory, after the pre-set run): the daily estimator above overstated spreads 5-15x
# for these stocks, so each bucket's cost is replaced by its mean 1-minute Abdi-Ranaldo spread from a
# 2019 sample (overnight_minute_spread.py). Prints both periods; no pass/fail.
MINUTE_COST = {  # (price bucket, $vol bucket) -> mean round-trip spread
    (0, 0): 0.0078, (0, 1): 0.0075, (0, 2): 0.0059, (0, 3): 0.0059,
    (1, 0): 0.0059, (1, 1): 0.0061, (1, 2): 0.0057, (1, 3): 0.0026,
    (2, 0): 0.0049, (2, 1): 0.0042, (2, 2): 0.0043, (2, 3): 0.0043,
    (3, 0): 0.0038, (3, 1): 0.0027, (3, 2): 0.0023, (3, 3): 0.0018,
}


def main():
    rng = np.random.default_rng(SEED)
    con = duckdb.connect()
    con.execute(f"attach '{WAREHOUSE}' as wh (read_only)")
    print("loading bars...", flush=True)
    d = con.execute("""
      with band as (
        select symbol from wh.sip_bars_daily_raw where date >= date '2016-01-01' and close between 0.10 and 5
        group by symbol having count(*) >= 60
      )
      select r.symbol, r.date, r.close rc, r.volume v, s.open o, s.high h, s.low l, s.close c
      from wh.sip_bars_daily_raw r join wh.sip_bars_daily_split s using (symbol, date) join band using (symbol)
      where r.date >= date '2015-06-01' and r.date <= date '2021-12-31'
        and not (r.volume <= 0 and r.open = r.high and r.high = r.low and r.low = r.close)
      order by r.symbol, r.date
    """).fetchnumpy()
    b = {k: np.asarray(v) for k, v in d.items()}
    for k in ("rc", "v", "o", "h", "l", "c"):
        b[k] = b[k].astype(float)
    sym, dates = b["symbol"], b["date"].astype("datetime64[D]")
    O, Hh, L, C, V, rc = b["o"], b["h"], b["l"], b["c"], b["v"], b["rc"]
    n = len(sym)
    starts = np.flatnonzero(np.r_[True, sym[1:] != sym[:-1]])
    ends = np.r_[starts[1:], n]
    year = dates.astype("datetime64[Y]").astype(int) + 1970

    elig = np.zeros(n, bool)
    flag = np.zeros(n, bool)
    spread = np.full(n, np.nan)
    dv20 = np.full(n, np.nan)
    gross = np.full(n, np.nan)
    for a, e in zip(starts, ends):
        m = e - a
        if m < 80:
            continue
        c, h, l, v, r, o = C[a:e], Hh[a:e], L[a:e], V[a:e], rc[a:e], O[a:e]
        with np.errstate(invalid="ignore", divide="ignore"):
            pc = np.r_[np.nan, c[:-1]]
            # overnight_cycle.py's flag, verbatim in substance
            tr = np.fmax(h - l, np.fmax(np.abs(h - pc), np.abs(l - pc)))
            at = np.convolve(np.nan_to_num(tr), np.ones(14) / 14, "full")[:m]
            nv = np.full(m, np.nan)
            nv[40:] = swv(v, 20).mean(axis=1)[: m - 40]
            last3 = np.convolve(v, np.ones(3) / 3, "full")[:m]
            early = np.full(m, np.nan)
            early[19:] = swv(v, 5).mean(axis=1)[: m - 19]
            hmax = np.maximum.accumulate(h)
            if m >= 252:
                hmax[251:] = swv(h, 252).max(axis=1)
            dv = np.convolve(r * v, np.ones(20) / 20, "full")[:m]
            dv[:19] = np.nan
            ok = (np.arange(m) >= 60) & (r >= 0.10) & (r <= 5) & (dv >= 250_000)
            elig[a:e] = ok
            flag[a:e] = ok & (at / c >= 0.08) & (c / hmax <= 0.60) & (v >= nv) & (last3 > early)
            dv20[a:e] = dv
            # Abdi-Ranaldo: pair (d, d+1) uses c_d, eta_d, eta_{d+1}; the window through t uses pairs
            # (t-20, t-19) .. (t-1, t) so it only needs prices up to t
            lc, eta = np.log(c), (np.log(h) + np.log(l)) / 2
            pair = np.full(m, np.nan)
            pair[1:] = np.maximum(4 * (lc[:-1] - eta[:-1]) * (lc[:-1] - eta[1:]), 0)  # pair ending at d
            s2 = np.full(m, np.nan)
            s2[20:] = swv(pair[1:], 20).mean(axis=1)[: m - 20]
            spread[a:e] = np.sqrt(s2)
            nxt = np.r_[o[1:], np.nan]
            ratio_n = np.r_[c[1:], np.nan] / c
            g = nxt / c - 1
            gross[a:e] = np.where((ratio_n > 0.1) & (ratio_n < 10), g, np.nan)
    tick = np.where(rc >= 1, 0.01, 0.0001) / rc
    cost = np.fmax(spread, tick)
    if "--minute-cost" in sys.argv:
        cost = np.full(n, np.nan)
        for (pi, di), cst in MINUTE_COST.items():
            (p0, p1), (d0, d1) = PRICE[pi], DV[di]
            cost[(rc >= p0) & (rc < p1) & (dv20 >= d0) & (dv20 < d1)] = cst
        cost = np.fmax(cost, tick)
    net = gross - cost
    base = elig & ~np.isnan(net)

    lines = []

    def out(s=""):
        print(s, flush=True)
        lines.append(s)

    def boot_mean(ix):
        dd = dates[ix].astype("int64")
        ud, inv = np.unique(dd, return_inverse=True)
        tot, cnt = np.bincount(inv, weights=net[ix]), np.bincount(inv)
        bs = np.empty(BOOT)
        for i in range(BOOT):
            w = np.bincount(rng.integers(0, len(ud), len(ud)), minlength=len(ud))
            bs[i] = (w @ tot) / max(w @ cnt, 1)
        return np.percentile(bs, [5, 95])

    def table(period_mask, label, only=None):
        out(f"\n=== {label} ===")
        out(f"  {'group':<5}{'price':<12}{'20d $vol':<12}{'n':>9}{'gross':>9}{'cost':>8}{'net':>9}{'90% CI':>20}"
            f"{'med gross':>11}{'med cost':>10}")
        res = {}
        for gname, gm in (("all", base), ("flag", base & flag)):
            for pi, (p0, p1) in enumerate(PRICE):
                for di, (d0, d1) in enumerate(DV):
                    key = (gname, pi, di)
                    if only is not None and key not in only:
                        continue
                    m = gm & period_mask & (rc >= p0) & (rc < p1) & (dv20 >= d0) & (dv20 < d1)
                    ix = np.flatnonzero(m)
                    if len(ix) < 200:
                        continue
                    ci = boot_mean(ix)
                    res[key] = dict(n=len(ix), net=net[ix].mean(), ci=ci, med_g=np.median(gross[ix]), med_c=np.median(cost[ix]))
                    dlab = f"${d0 / 1e6:g}M-{'' if np.isinf(d1) else f'{d1 / 1e6:g}M'}" if d0 >= 1e6 else "$0.25M-1M"
                    out(f"  {gname:<5}{f'${p0:g}-{p1:g}':<12}{dlab:<12}{len(ix):>9,}{gross[ix].mean():>+9.2%}{cost[ix].mean():>8.2%}"
                        f"{net[ix].mean():>+9.2%}{f'[{ci[0]:+.2%}, {ci[1]:+.2%}]':>20}{np.median(gross[ix]):>+11.2%}{np.median(cost[ix]):>10.2%}")
        return res

    if "--minute-cost" in sys.argv:
        table((year >= 2016) & (year <= 2019), "EXPLORATORY 2016-19: net of the bucket's 1-minute spread")
        table((year >= 2020) & (year <= 2021), "EXPLORATORY 2020-21: net of the bucket's 1-minute spread")
        for y_ in range(2016, 2022):
            m = base & (year == y_) & (rc < 0.5)
            out(f"  sub-$0.50, {y_}: mean net {net[m].mean():+.2%}, median net {np.median(net[m]):+.2%} (n={m.sum():,})")
        OUT.mkdir(parents=True, exist_ok=True)
        path = OUT / f"overnight_cost_minute_{dt.datetime.now():%Y%m%dT%H%M%S}.txt"
        path.write_text("\n".join(lines) + "\n")
        print(f"\nwrote {path}")
        return
    A = table((year >= 2016) & (year <= 2019), "STAGE A 2016-19: overnight close -> open, net of own spread")
    carried = {k for k, r in A.items() if r["net"] > 0 and r["ci"][0] > 0}
    out(f"\ncarried to stage B: {len(carried)} bucket(s)")
    if carried:
        B = table((year >= 2020) & (year <= 2021), "STAGE B 2020-21 (once): carried buckets", only=carried)
        out("\n  PASS/FAIL:")
        for k in sorted(carried):
            r = B.get(k)
            if r is None:
                out(f"    {k}: too few events in 2020-21")
                continue
            ok = r["net"] > 0 and r["ci"][0] > 0 and r["med_g"] > r["med_c"]
            out(f"    {k[0]} price {PRICE[k[1]]} $vol {DV[k[2]]}: {'PASS' if ok else 'FAIL'} "
                f"(net {r['net']:+.2%}, CI [{r['ci'][0]:+.2%}, {r['ci'][1]:+.2%}], median gross {r['med_g']:+.2%} vs median cost {r['med_c']:.2%})")
    else:
        out("  no bucket clears its own spread on 2016-19.")

    # diagnostic (not pass/fail): if the overnight gain is bid-ask bounce (closes printing near the bid,
    # opens near the ask), the same stocks' open -> close return should give it back, most where spreads are widest
    intraday = C / O - 1
    out("\n=== diagnostic: overnight (t close -> t+1 open) vs the next day's intraday (t+1 open -> t+1 close), 'all', 2016-21 ===")
    nxt_intra = np.full(n, np.nan)
    nxt_intra[:-1] = intraday[1:]
    same_sym = np.r_[sym[1:] == sym[:-1], False]
    nxt_intra[~same_sym] = np.nan
    pm = (year >= 2016) & (year <= 2021)
    for pi, (p0, p1) in enumerate(PRICE):
        m = base & pm & (rc >= p0) & (rc < p1) & ~np.isnan(nxt_intra)
        out(f"  ${p0:g}-{p1:g}: overnight {gross[m].mean():+.2%} | next intraday {nxt_intra[m].mean():+.2%} | "
            f"sum {np.nanmean(gross[m] + nxt_intra[m]):+.2%} | est. spread {cost[m].mean():.2%}  (n={m.sum():,})")

    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"overnight_cost_{dt.datetime.now():%Y%m%dT%H%M%S}.txt"
    path.write_text("\n".join(lines) + "\n")
    print(f"\nwrote {path}")


if __name__ == "__main__":
    main()
