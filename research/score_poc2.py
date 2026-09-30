"""
Points-score proof of concept, round 2: more signal families, vetoes, a
proper scorecard fit, confluence pairs, and fixed execution variants --
chosen WITHOUT touching the test years.

TARGET    max high over the next 5 sessions >= +30% above the signal close.
UNIVERSE  every session with raw close $0.10-$5, 20-day dollar volume >=
          $250k, >= 60 sessions of history.

DISCIPLINE
  develop on 2016-2018; choose L2 strength, confluence pairs and the
  execution variant on 2019; refit on 2016-2019 and score 2020-2021 ONCE.
  2022+ stays sealed.

SIGNALS (quintile levels on the fit years; missing = its own level)
  timing    vol_ratio (today), vol_ratio 3-day mean, atr_chg (vs 20 sessions
            ago), dv_chg, clv (close location in range), ret_1, ret_5,
            ret_20, gap, range_exp (range vs 20d avg), dist_sma20,
            new_20d_high (flag)
  profile   pct_52w_high, price, mcap
  catalysts news_today, earn_beat_20d, f4_buy_30d, 13d_new_30d (flags)
  short     short_float (latest published FINRA / shares), its change over
            the last 2 readings, short-volume ratio 5d
  market    spy_above_sma200, breadth (share of band stocks up that day)
  confluence (pre-set; kept only if they help on 2019)
            vol surge x high short float, vol surge x news today,
            vol surge x new 20d high, vol surge x up day
VETOES (hard filters, from the validated avoid rules)
  S-1/S-3/424B4/424B5 in 30d, shares +100% YoY, mcap < $10M, news halt in
  20d, partnership PR in 20d
WEIGHTS   L2 logistic on one-hot levels (a scorecard: points = weights),
          which splits credit between overlapping factors
EXECUTION (fixed; top 5 scores per day, cost max(1%, tick))
  E1 next open, +30% limit, else day-5 close
  E2 E1 + stop -12%
  E3 E1 + stop 1.5 x ATR14
  E4 E1, skip if the next open gaps > +15%
  E5 E2 + E4
  E6 enter at the SIGNAL close (needs a near-close decision), +30% limit / -12% stop

PASS (same four as round 1)
  1 deciles rise   2 top 5% >= 3x base   3 beats vol_ratio alone
  4 the chosen execution beats random entries on the same days

    research/.venv/bin/python research/score_poc2.py
"""
import datetime as dt

import duckdb
import numpy as np
import pyarrow as pa
from numpy.lib.stride_tricks import sliding_window_view as swv

from swing_backtest import WAREHOUSE, OUT, EDGAR, load_bars, features

ROOT = WAREHOUSE.parent.parent
CAT = ROOT / "data" / "catalysts"
TARGET, H, TOP, FLOOR = 0.30, 5, 5, 250_000
CONT = ["vol_ratio", "vr3", "atr_chg", "dv_chg", "clv", "ret_1", "ret_5", "ret_20", "gap", "range_exp", "dist_sma20",
        "pct_52w_high", "price", "mcap", "short_float", "sf_chg", "svr5", "breadth"]
FLAGS = ["new_20d_high", "news_today", "earn_beat_20d", "f4_buy_30d", "13d_new_30d", "spy_above_sma200"]
PAIRS = [("vol_surge", "sf_high"), ("vol_surge", "news_today"), ("vol_surge", "new_20d_high"), ("vol_surge", "up_day")]


def lag(a, k):
    out = np.full(len(a), np.nan)
    out[k:] = a[:-k]
    return out


def logistic(X, y, l2, iters=300, lr=0.5):
    n, k = X.shape
    w, b = np.zeros(k), np.log(y.mean() / (1 - y.mean()))
    for _ in range(iters):
        p = 1 / (1 + np.exp(-(X @ w + b)))
        g = p - y
        w -= lr * (X.T @ g / n + l2 * w)
        b -= lr * g.mean()
    return w, b


def main():
    rng = np.random.default_rng(7)
    con = duckdb.connect()
    con.execute(f"attach '{WAREHOUSE}' as wh (read_only)")
    con.execute("use wh")
    b = load_bars(con, 0.10, 5.0)
    con.execute("use memory")
    f, starts, ends = features(b)
    n = len(b["c"])
    O, Hh, L, C, V, cr, dates, sym = b["o"], b["h"], b["l"], b["c"], b["v"], b["cr"], b["date"], b["symbol"]
    sid = np.repeat(np.arange(len(starts)), ends - starts)
    local = np.arange(n) - starts[sid]

    print("price/volume features and outcomes...", flush=True)
    X = {k: np.full(n, np.nan) for k in CONT + FLAGS + ["up_day"]}
    hit = np.full(n, np.nan)
    outcome = {e: np.full(n, np.nan) for e in ("E1", "E2", "E3", "E4", "E5", "E6")}
    atr = f["atr14"]
    for a, e in zip(starts, ends):
        m = e - a
        c, h, l, o, v = C[a:e], Hh[a:e], L[a:e], O[a:e], V[a:e]
        with np.errstate(invalid="ignore", divide="ignore"):
            vr = v / f["adv20"][a:e]
            X["vol_ratio"][a:e] = vr
            X["vr3"][a:e] = (vr + lag(vr, 1) + lag(vr, 2)) / 3
            X["atr_chg"][a:e] = atr[a:e] / lag(atr[a:e], 20) - 1
            X["dv_chg"][a:e] = f["dollar20"][a:e] / lag(f["dollar20"][a:e], 20) - 1
            rngd = h - l
            X["clv"][a:e] = np.where(rngd > 0, (c - l) / rngd, 0.5)
            X["ret_1"][a:e] = c / lag(c, 1) - 1
            X["up_day"][a:e] = (c > lag(c, 1)).astype(float)
            X["ret_5"][a:e] = c / lag(c, 5) - 1
            X["ret_20"][a:e] = c / lag(c, 20) - 1
            X["gap"][a:e] = o / lag(c, 1) - 1
            avg_rng = np.r_[np.nan, np.convolve(rngd, np.ones(20) / 20, "full")[:m - 1]]
            avg_rng[:21] = np.nan
            X["range_exp"][a:e] = rngd / avg_rng
            sma20 = np.convolve(c, np.ones(20) / 20, "full")[:m]
            sma20[:19] = np.nan
            X["dist_sma20"][a:e] = c / sma20 - 1
            if m > 21:
                hi20 = np.full(m, np.nan)
                hi20[20:] = swv(h[:-1], 20).max(axis=1)[: m - 20]
                X["new_20d_high"][a:e] = (c > hi20).astype(float)
            hmax = np.maximum.accumulate(h)  # expanding max until 252 available
            if m >= 252:
                hmax[251:] = swv(h, 252).max(axis=1)
            X["pct_52w_high"][a:e] = c / hmax
            X["price"][a:e] = cr[a:e]
            if m > H + 1:
                k = m - H
                fwd_hi = swv(h[1:], H).max(axis=1)[:k]
                hit[a:a + k] = (fwd_hi / c[:k] - 1 >= TARGET).astype(float)
                cost = np.maximum(0.01, np.where(cr[a:e] >= 1, 0.01, 0.0001) / cr[a:e])[:k]
                # simulate each execution variant
                for ev in outcome:
                    if ev == "E6":
                        ent = c[:k]
                        days = range(1, H + 1)
                    else:
                        ent = np.r_[o[1:], np.nan][:k]
                        days = range(1, H + 1)
                    stop = None
                    if ev in ("E2", "E5", "E6"):
                        stop = ent * 0.88
                    elif ev == "E3":
                        stop = ent - 1.5 * atr[a:e][:k]
                    tgt = ent * (1 + TARGET)
                    res = np.full(k, np.nan)
                    done = np.zeros(k, bool)
                    for d in days:
                        hd = np.r_[h[d:], np.full(d, np.nan)][:k]
                        ld = np.r_[l[d:], np.full(d, np.nan)][:k]
                        od = np.r_[o[d:], np.full(d, np.nan)][:k]
                        if stop is not None:
                            # gap through the stop fills at the open (skip on the entry day for E1-E5: entry is that open)
                            gap_stop = ~done & (od <= stop) & ((d > 1) | (ev == "E6"))
                            res = np.where(gap_stop, od / ent - 1, res); done |= gap_stop
                            hit_stop = ~done & (ld <= stop)
                            res = np.where(hit_stop, stop / ent - 1, res); done |= hit_stop
                        hit_t = ~done & (hd >= tgt)
                        res = np.where(hit_t, TARGET, res); done |= hit_t
                    cl = np.r_[c[H:], np.full(H, np.nan)][:k]
                    res = np.where(done, res, cl / ent - 1)
                    if ev in ("E4", "E5"):
                        g = np.r_[o[1:], np.nan][:k] / c[:k] - 1
                        res = np.where(g > 0.15, np.nan, res)  # skipped: no trade
                    outcome[ev][a:a + k] = res - cost
    bad = ((f["ratio"] >= 10) | (f["ratio"] <= 0.1)).astype(np.int64)
    cb = np.r_[0, np.cumsum(bad)]
    idx = np.arange(n)
    clean = (cb[np.minimum(idx + H + 1, n)] - cb[np.maximum(idx - 20, 0)]) == 0
    hit[~clean] = np.nan
    for ev in outcome:
        outcome[ev][~clean] = np.nan

    year = dates.astype("datetime64[Y]").astype(int) + 1970
    with np.errstate(invalid="ignore"):
        base_elig = (year >= 2016) & (year <= 2021) & (cr >= 0.10) & (cr <= 5) & (f["dollar20"] >= FLOOR) \
            & (local >= 60) & ~np.isnan(hit) & ~np.isnan(X["vol_ratio"]) & ~np.isnan(X["atr_chg"])
    rows = np.flatnonzero(base_elig)
    print(f"{len(rows):,} eligible stock-days 2016-2021", flush=True)

    # breadth: share of eligible band stocks up that day
    d_ix = dates[rows].astype("int64")
    ud, inv = np.unique(d_ix, return_inverse=True)
    up = np.nan_to_num(X["up_day"][rows])
    br = np.bincount(inv, weights=up) / np.bincount(inv)
    X["breadth"][rows] = br[inv]

    # ---- joins: catalysts, EDGAR, short data, SPY (duckdb) ----
    print("joining catalysts, filings, short data, SPY...", flush=True)
    sf_arr = C / cr  # split factor per row
    con.register("r_arrow", pa.table({"rid": rows, "symbol": sym[rows], "date": dates[rows], "cr": cr[rows]}))
    con.execute("create temp table r as select * from r_arrow")
    con.register("sf_arrow", pa.table({"symbol": sym, "date": dates, "f": sf_arr}))
    con.execute("create temp table sf as select * from sf_arrow order by symbol, date")
    con.execute(f"""
      create temp table ev as select symbol, event_date d, type from read_parquet('{CAT}/*.parquet', union_by_name=true)
      where type in ('s1','s3','424b4','424b5','news_halt','news_partnership','earn_beat','f4_buy','13d_new','news_any')
        and event_date >= date '2015-10-01' and event_date <= date '2021-12-31'
    """)
    cat = con.execute("""
      select r.rid,
        count(*) filter (where type in ('s1','s3','424b4','424b5') and d > r.date - 30) > 0 offer30,
        count(*) filter (where type = 'news_halt' and d > r.date - 20) > 0 halt20,
        count(*) filter (where type = 'news_partnership' and d > r.date - 20) > 0 partner20,
        count(*) filter (where type = 'earn_beat' and d > r.date - 20) > 0 earn20,
        count(*) filter (where type = 'f4_buy' and d > r.date - 30) > 0 f4b30,
        count(*) filter (where type = '13d_new' and d > r.date - 30) > 0 d13,
        count(*) filter (where type = 'news_any' and d = r.date) > 0 news_today
      from r join ev on ev.symbol = r.symbol and ev.d <= r.date and ev.d > r.date - 30
      group by r.rid
    """).fetchnumpy()
    flags = {k: np.zeros(n) for k in ("offer30", "halt20", "partner20", "earn20", "f4b30", "d13", "news_today")}
    for k in flags:
        flags[k][np.asarray(cat["rid"])] = np.asarray(cat[k], float)
    X["news_today"], X["earn_beat_20d"], X["f4_buy_30d"], X["13d_new_30d"] = (flags["news_today"], flags["earn20"],
                                                                              flags["f4b30"], flags["d13"])
    e = str(EDGAR)
    con.execute(f"""
      create temp table tc as select ticker, min(cik) cik from (
        select ticker, cik from read_parquet('{e}/edgar_tickers.parquet')
        union select unnest(tickers) ticker, cik from read_parquet('{e}/edgar_companies.parquet')) group by ticker
    """)
    con.execute(f"""
      create temp table sh as select cik, filed::date filed, max(val) shares from read_parquet('{e}/edgar_facts.parquet')
      where concept in ('EntityCommonStockSharesOutstanding','CommonStockSharesOutstanding') and unit='shares' and val > 0
      group by 1, 2 order by 1, 2
    """)
    shr = con.execute("""
      with x as (select r.*, tc.cik, r.date - interval 365 day d1 from r left join tc on tc.ticker = r.symbol),
      a as (select x.*, sh.shares s0, sh.filed f0 from x asof left join sh on x.cik = sh.cik and x.date >= sh.filed),
      b as (select a.*, sh.shares s1, sh.filed f1 from a asof left join sh on a.cik = sh.cik and a.d1 >= sh.filed),
      c as (select b.*, s_now.f fnow from b asof left join sf s_now on s_now.symbol = b.symbol and b.date >= s_now.date),
      d as (select c.*, s_f0.f ff0 from c asof left join sf s_f0 on s_f0.symbol = c.symbol and c.f0 >= s_f0.date),
      g as (select d.*, s_f1.f ff1 from d asof left join sf s_f1 on s_f1.symbol = d.symbol and d.f1 >= s_f1.date)
      select rid, s0 * fnow / ff0 shares, s1 * fnow / ff1 shares_1y from g
    """).fetchnumpy()
    shares = np.full(n, np.nan); shares_1y = np.full(n, np.nan)
    rid = np.asarray(shr["rid"])
    shares[rid] = np.asarray(shr["shares"], float); shares_1y[rid] = np.asarray(shr["shares_1y"], float)
    X["mcap"] = shares * cr
    si_dir = CAT / "raw" / "short_interest"
    con.execute(f"create temp table si as select symbol, settlement_date, short_interest from read_parquet('{si_dir}/*.parquet') where short_interest is not null")
    pub = con.execute("select distinct settlement_date from si").fetchnumpy()["settlement_date"].astype("datetime64[D]")
    con.register("pm_arrow", pa.table({"settlement_date": pub, "pub": np.busday_offset(pub, 8, roll="forward")}))
    con.execute("create temp table sip as select si.*, pm.pub from si join pm_arrow pm using (settlement_date) order by symbol, pub")
    sq = con.execute("""
      with l as (select symbol, pub, short_interest, settlement_date,
                        lag(short_interest, 2) over (partition by symbol order by settlement_date) si_prev2 from sip),
      j as (select r.rid, r.symbol, r.date, l.short_interest, l.si_prev2, l.settlement_date sd
            from r asof left join l on l.symbol = r.symbol and r.date >= l.pub),
      k as (select j.*, a.f fnow from j asof left join sf a on a.symbol = j.symbol and j.date >= a.date),
      m as (select k.*, b.f fsd from k asof left join sf b on b.symbol = k.symbol and k.sd >= b.date)
      select rid, short_interest * fnow / fsd si_adj, si_prev2 * fnow / fsd si_prev2_adj, date - sd age from m
    """).fetchnumpy()
    rid = np.asarray(sq["rid"])
    si_adj = np.asarray(sq["si_adj"], float); si_p2 = np.asarray(sq["si_prev2_adj"], float)
    age = np.asarray(sq["age"], float)
    with np.errstate(invalid="ignore", divide="ignore"):
        fresh = age <= 45
        X["short_float"][rid] = np.where(fresh, si_adj / shares[rid], np.nan)
        X["sf_chg"][rid] = np.where(fresh, si_adj / si_p2 - 1, np.nan)
    sv_dir = CAT / "raw" / "short_volume"
    svq = con.execute(f"""
      with s as (select symbol, date, short_volume / nullif(total_volume, 0) svr,
                        avg(short_volume / nullif(total_volume, 0)) over (partition by symbol order by date rows between 4 preceding and current row) svr5
                 from read_parquet('{sv_dir}/*.parquet') where date <= date '2021-12-31')
      select r.rid, s.svr5 from r join s on s.symbol = r.symbol and s.date = r.date
    """).fetchnumpy()
    X["svr5"][np.asarray(svq["rid"])] = np.asarray(svq["svr5"], float)
    spy = con.execute("""
      select date, (close > avg(close) over (order by date rows between 199 preceding and current row))::int up
      from wh.sip_bars_daily_split where symbol = 'SPY'
    """).fetchnumpy()
    spy_map = dict(zip(np.asarray(spy["date"]).astype("datetime64[D]").astype("int64"), np.asarray(spy["up"], float)))
    X["spy_above_sma200"][rows] = np.array([spy_map.get(int(d), np.nan) for d in d_ix])

    # vetoes
    with np.errstate(invalid="ignore", divide="ignore"):
        veto = (flags["offer30"] > 0) | (flags["halt20"] > 0) | (flags["partner20"] > 0) | (X["mcap"] < 10e6) \
            | (shares / shares_1y - 1 >= 1.0)

    # ---- design matrix: quintile one-hots (+ missing), flags, confluence pairs ----
    def design(fit_mask, pairs):
        cuts = {k: np.nanquantile(X[k][fit_mask], [0.2, 0.4, 0.6, 0.8]) for k in CONT}

        def build(mask):
            cols, names = [], []
            for k in CONT:
                v = X[k][mask]
                lv = np.where(np.isnan(v), 5, np.searchsorted(cuts[k], v))
                for i in range(6):
                    if i == 2:  # middle quintile = reference level
                        continue
                    col = (lv == i).astype(float)
                    if col.any():
                        cols.append(col); names.append(f"{k}:{'Q' + str(i + 1) if i < 5 else 'missing'}")
            for k in FLAGS:
                cols.append(np.nan_to_num(X[k][mask])); names.append(k)
            vs = X["vol_ratio"][mask] >= cuts["vol_ratio"][3]
            ref = {"vol_surge": vs, "sf_high": np.nan_to_num(X["short_float"][mask]) >= np.nanquantile(X["short_float"][fit_mask], 0.8),
                   "news_today": np.nan_to_num(X["news_today"][mask]) > 0, "new_20d_high": np.nan_to_num(X["new_20d_high"][mask]) > 0,
                   "up_day": np.nan_to_num(X["up_day"][mask]) > 0}
            for p, q in pairs:
                cols.append((ref[p] & ref[q]).astype(float)); names.append(f"{p} x {q}")
            return np.column_stack(cols), names
        return build, cuts

    def fit_score(fit_mask, score_mask, l2, pairs):
        build, cuts = design(fit_mask, pairs)
        Xf, names = build(fit_mask)
        w, b0 = logistic(Xf, hit[fit_mask], l2)
        Xs, _ = build(score_mask)
        return Xs @ w + b0, dict(zip(names, w)), cuts

    def auc(s, y):
        o = np.argsort(s)
        r = np.empty(len(s)); r[o] = np.arange(1, len(s) + 1)
        n1 = y.sum(); n0 = len(y) - n1
        return (r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)

    def evaluate(mask, score, ev, label, out):
        y = hit[mask]
        base = y.mean()
        dec = np.searchsorted(np.quantile(score, np.linspace(0.1, 0.9, 9)), score)
        rates = [y[dec == i].mean() for i in range(10)]
        rises = sum(rates[i + 1] >= rates[i] for i in range(9))
        cut5 = np.quantile(score, 0.95)
        lift5 = y[score >= cut5].mean() / base
        vr = X["vol_ratio"][mask]
        lift5_vr = y[vr >= np.quantile(vr, 0.95)].mean() / base
        # trade: top 5 non-vetoed scores per day vs random non-vetoed on the same days
        ix = np.flatnonzero(mask)
        ok = ~veto[ix]
        ix2, sc2 = ix[ok], score[ok]
        d = dates[ix2]
        order = np.lexsort((-sc2, d))
        _, first, cnt = np.unique(d[order], return_index=True, return_counts=True)
        pick, rnd = [], []
        for st, cn in zip(first, cnt):
            grp = order[st:st + cn]
            pick += list(ix2[grp[:TOP]])
            rnd += list(rng.choice(ix2[grp], min(TOP, cn), replace=False))
        pick, rnd = np.array(pick), np.array(rnd)
        rp, rr = outcome[ev][pick], outcome[ev][rnd]
        # day-clustered bootstrap 90% interval on (score mean - random mean)
        dp, dr = dates[pick].astype("int64"), dates[rnd].astype("int64")
        udays = np.unique(dp)
        sp = {d: rp[(dp == d) & ~np.isnan(rp)] for d in udays}
        sr = {d: rr[(dr == d) & ~np.isnan(rr)] for d in udays}
        diffs = []
        for _ in range(500):
            ds = rng.choice(udays, len(udays))
            a_ = np.concatenate([sp[d] for d in ds]); b_ = np.concatenate([sr[d] for d in ds])
            diffs.append(a_.mean() - b_.mean())
        ci = np.percentile(diffs, [5, 95])
        rp, rr = rp[~np.isnan(rp)], rr[~np.isnan(rr)]
        out(f"  [{label}] base {base:.2%} | AUC {auc(score, y):.3f} | deciles rise {rises}/9 D1 {rates[0]:.1%} D10 {rates[9]:.1%} "
            f"| top5% {lift5:.1f}x (vol alone {lift5_vr:.1f}x) | {ev} trade: score {rp.mean():+.2%} (med {np.median(rp):+.2%}, "
            f"win {np.mean(rp > 0):.0%}, n={len(rp):,}) vs random {rr.mean():+.2%} | diff 90% CI [{ci[0]:+.2%}, {ci[1]:+.2%}]")
        return dict(rises=rises, lift5=lift5, lift5_vr=lift5_vr, trade=rp.mean(), rand=rr.mean())

    lines = []

    def out(s=""):
        print(s, flush=True)
        lines.append(s)

    fit_dev = base_elig & (year <= 2018)
    val = base_elig & (year == 2019)
    test = base_elig & (year >= 2020) & (year <= 2021)
    out(f"eligible rows: dev 2016-18 {fit_dev.sum():,} | val 2019 {val.sum():,} | test 2020-21 {test.sum():,}")

    # ---- selection on 2019 ----
    out("\n=== selection on 2019 (fit 2016-18) ===")
    best = None
    for l2 in (0.001, 0.01, 0.05):
        s_val, _, _ = fit_score(fit_dev, val, l2, [])
        a = auc(s_val, hit[val])
        out(f"  L2 {l2}: val AUC {a:.3f}")
        if best is None or a > best[1]:
            best = (l2, a)
    l2 = best[0]
    s_nopair, _, _ = fit_score(fit_dev, val, l2, [])
    a0 = auc(s_nopair, hit[val])
    kept = []
    for p in PAIRS:
        s_p, _, _ = fit_score(fit_dev, val, l2, kept + [p])
        a = auc(s_p, hit[val])
        gain = a - a0
        out(f"  pair {p[0]} x {p[1]}: val AUC {a:.4f} ({gain:+.4f})")
        if gain > 0.001:
            kept.append(p); a0 = a
    out(f"  chosen: L2 {l2}, pairs {kept or 'none'}")
    s_val, _, _ = fit_score(fit_dev, val, l2, kept)
    ev_res = {}
    for ev in outcome:
        ev_res[ev] = evaluate(val, s_val, ev, f"2019 {ev}", out)
    ev_best = max(ev_res, key=lambda k: ev_res[k]["trade"] - ev_res[k]["rand"])
    out(f"  chosen execution: {ev_best}")

    # ---- final: refit on 2016-19, score 2020-21 once ----
    out("\n=== TEST 2020-21 (fit 2016-19), scored once ===")
    fit_all = base_elig & (year <= 2019)
    s_te, weights, _ = fit_score(fit_all, test, l2, kept)
    r = evaluate(test, s_te, ev_best, f"2020-21 {ev_best}", out)
    for ev in outcome:
        if ev != ev_best:
            evaluate(test, s_te, ev, f"2020-21 {ev} (for reference)", out)
    out("\n  PASS/FAIL: "
        f"1 deciles {'PASS' if r['rises'] >= 8 else 'FAIL'} ({r['rises']}/9) | "
        f"2 top5% {'PASS' if r['lift5'] >= 3 else 'FAIL'} ({r['lift5']:.1f}x) | "
        f"3 vs vol_ratio {'PASS' if r['lift5'] > r['lift5_vr'] else 'FAIL'} | "
        f"4 trade {'PASS' if r['trade'] > r['rand'] and r['trade'] > 0 else 'FAIL'} ({r['trade']:+.2%} vs {r['rand']:+.2%})")
    out("\n  largest points (weights), final fit:")
    for k, w in sorted(weights.items(), key=lambda t: -abs(t[1]))[:25]:
        out(f"    {k:<34}{w:+.2f}")

    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"score_poc2_{dt.datetime.now():%Y%m%dT%H%M%S}.txt"
    path.write_text("\n".join(lines) + "\n")
    print(f"\nwrote {path}")


if __name__ == "__main__":
    main()
