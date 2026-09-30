"""
Proof of concept for a weighted points score (see chat 2026-09-30): can a
small, data-weighted score of price/volume factors predict "+30% within 5
sessions" across EVERY eligible stock-day -- not matched samples -- better
than its best single factor, and does trading it survive costs?

UNIVERSE  every session 2016+ with raw close $0.10-$5, 20-day dollar volume
          >= --floor, full indicator history.
TARGET    max high over the next 5 sessions >= +30% above today's close
          (split-adjusted; windows with a split/reorg artifact dropped).
FACTORS   (5 families, daily bars only)
  vol_ratio    today's volume / prior-20-session average
  atr_chg      ATR14 now vs 20 sessions ago
  dv_chg       20-day dollar volume now vs 20 sessions ago
  pct_52w_high close / 252-session high
  price        raw close
POINTS    each factor split at its training-period quartiles; each level
          earns ln(hit rate in that level / overall hit rate) on TRAINING
          years only. Score = sum of points.
CONFLUENCE vol_ratio top quartile AND atr_chg top quartile: kept as a bonus
          only if the pair's training lift beats the sum of its parts.
SPLIT     learn on 2016-2019, test on 2020-2021. 2022+ stays sealed.

PASS/FAIL (fixed before running)
  1. higher score deciles hit more often on the test years (monotone-ish)
  2. top 5% of scores hit >= 3x the base rate
  3. the score's top 5% beats vol_ratio alone's top 5%
  4. trade (top 5 scores per day: buy next open, sell at +30% limit or the
     day-5 close, cost max(1%, tick)) beats random entries on the same days

    research/.venv/bin/python research/score_poc.py [--floor 250000]
"""
import argparse
import datetime as dt
from pathlib import Path

import duckdb
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view as swv

from swing_backtest import WAREHOUSE, OUT, load_bars, features

FACTORS = ("vol_ratio", "atr_chg", "dv_chg", "pct_52w_high", "price")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--floor", type=float, default=250_000)
    ap.add_argument("--target", type=float, default=0.30)
    ap.add_argument("--horizon", type=int, default=5)
    ap.add_argument("--top-per-day", type=int, default=5)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)
    H = args.horizon

    con = duckdb.connect()
    con.execute(f"attach '{WAREHOUSE}' as wh (read_only)")
    con.execute("use wh")
    b = load_bars(con, 0.10, 5.0)
    f, starts, ends = features(b)
    n = len(b["c"])
    O, Hi, C, cr = b["o"], b["h"], b["c"], b["cr"]
    sid = np.repeat(np.arange(len(starts)), ends - starts)
    local = np.arange(n) - starts[sid]
    last = ends[sid] - 1

    print("factors and target...", flush=True)
    x = {k: np.full(n, np.nan) for k in FACTORS}
    hit = np.full(n, np.nan)
    trade = np.full(n, np.nan)  # net return: buy next open, sell at +30% limit or day-H close
    bad = ((f["ratio"] >= 10) | (f["ratio"] <= 0.1)).astype(np.int64)
    cb = np.r_[0, np.cumsum(bad)]
    for a, e in zip(starts, ends):
        m = e - a
        c, h, v = C[a:e], Hi[a:e], b["v"][a:e]
        with np.errstate(invalid="ignore", divide="ignore"):
            x["vol_ratio"][a:e] = v / f["adv20"][a:e]
            atr, dv = f["atr14"][a:e], f["dollar20"][a:e]
            ac = np.full(m, np.nan); dc = np.full(m, np.nan)
            ac[20:] = atr[20:] / atr[:-20] - 1
            dc[20:] = dv[20:] / dv[:-20] - 1
            x["atr_chg"][a:e], x["dv_chg"][a:e] = ac, dc
            if m >= 252:
                hi = np.full(m, np.nan)
                hi[251:] = swv(h, 252).max(axis=1)
                x["pct_52w_high"][a:e] = c / hi
            x["price"][a:e] = cr[a:e]
            if m > H + 1:
                fwd_hi = swv(h[1:], H).max(axis=1)[: m - H]  # highs over t+1..t+H
                hit[a:a + m - H] = (fwd_hi / c[: m - H] - 1 >= args.target).astype(float)
                # trade: entry next open (t+1), limit at entry*(1+target), else close of t+H
                ent = np.r_[O[a + 1:e], np.nan][: m - H]
                tgt = ent * (1 + args.target)
                hit_lim = np.zeros(m - H, bool)
                for k in range(1, H + 1):
                    hit_lim |= np.r_[h[k:], np.full(k, np.nan)][: m - H] >= tgt
                ex = np.where(hit_lim, tgt, np.r_[c[H:], np.full(H, np.nan)][: m - H])
                cost = np.maximum(0.01, np.where(cr[a:e] >= 1, 0.01, 0.0001)[: m - H] / cr[a:e][: m - H])
                trade[a:a + m - H] = ex / ent - 1 - cost
    idx = np.arange(n)
    clean = (cb[np.minimum(idx + H + 1, n)] - cb[idx + 1]) == 0
    hit[~clean] = np.nan
    trade[~clean] = np.nan

    year = b["date"].astype("datetime64[Y]").astype(int) + 1970
    with np.errstate(invalid="ignore"):
        elig = (year >= 2016) & (cr >= 0.10) & (cr <= 5) & (f["dollar20"] >= args.floor) & ~np.isnan(hit) & (local >= 272)
        for k in FACTORS:
            elig &= ~np.isnan(x[k])
    train, test = elig & (year <= 2019), elig & (year >= 2020) & (year <= 2021)
    base_tr, base_te = hit[train].mean(), hit[test].mean()

    lines = []

    def out(s=""):
        print(s, flush=True)
        lines.append(s)

    out(f"target +{args.target:.0%} within {H} sessions | floor ${args.floor:,.0f} | train 2016-19 n={train.sum():,} "
        f"base {base_tr:.2%} | test 2020-21 n={test.sum():,} base {base_te:.2%}")

    # --- points from training quartiles ---
    edges, pts = {}, {}
    out("\npoints per level (ln lift on 2016-19; level 1 = lowest quartile):")
    for k in FACTORS:
        q = np.quantile(x[k][train], [0.25, 0.5, 0.75])
        edges[k] = q
        lvl = np.searchsorted(q, x[k][train])
        pts[k] = np.array([np.log(max(hit[train][lvl == i].mean(), 1e-6) / base_tr) for i in range(4)])
        out(f"  {k:<14} cuts {np.round(q, 3)}  points {np.round(pts[k], 2)}")

    def score_of(mask, use_bonus, bonus):
        s = np.zeros(mask.sum())
        lv = {}
        for k in FACTORS:
            lv[k] = np.searchsorted(edges[k], x[k][mask])
            s += pts[k][lv[k]]
        if use_bonus:
            s += bonus * ((lv["vol_ratio"] == 3) & (lv["atr_chg"] == 3))
        return s

    # --- confluence bonus: does the pair beat the sum of its parts? ---
    lv_vr = np.searchsorted(edges["vol_ratio"], x["vol_ratio"][train])
    lv_ac = np.searchsorted(edges["atr_chg"], x["atr_chg"][train])
    pair = (lv_vr == 3) & (lv_ac == 3)
    pair_pts = np.log(hit[train][pair].mean() / base_tr)
    bonus = pair_pts - (pts["vol_ratio"][3] + pts["atr_chg"][3])
    keep_bonus = bonus > 0.1
    out(f"\nconfluence vol_ratio Q4 & atr_chg Q4: n={pair.sum():,}, pair points {pair_pts:.2f} vs sum of parts "
        f"{pts['vol_ratio'][3] + pts['atr_chg'][3]:.2f} -> bonus {bonus:+.2f} ({'KEPT' if keep_bonus else 'dropped'})")

    s_te = score_of(test, keep_bonus, bonus)
    y_te = hit[test]
    vr_te = x["vol_ratio"][test]

    # 1. deciles
    out("\n1. test-year hit rate by score decile (10 = highest):")
    dec = np.searchsorted(np.quantile(s_te, np.linspace(0.1, 0.9, 9)), s_te)
    rates = [y_te[dec == i].mean() for i in range(10)]
    out("   " + "  ".join(f"D{i + 1}:{r:.1%}" for i, r in enumerate(rates)))
    rises = sum(rates[i + 1] >= rates[i] for i in range(9))
    out(f"   rising steps {rises}/9, D10/D1 = {rates[9] / max(rates[0], 1e-9):.1f}x")

    # 2 & 3. top 5% lift, score vs vol_ratio alone
    def top_lift(sc, frac):
        cut = np.quantile(sc, 1 - frac)
        return y_te[sc >= cut].mean(), (sc >= cut).sum()

    out("\n2-3. lift in the top slice of the test years (base " f"{base_te:.2%}):")
    for frac in (0.05, 0.01):
        rs, ns = top_lift(s_te, frac)
        rv, nv = top_lift(vr_te, frac)
        out(f"   top {frac:.0%}: score {rs:.1%} ({rs / base_te:.1f}x, n={ns:,})   vol_ratio alone {rv:.1%} ({rv / base_te:.1f}x)")

    # 4. trade: top N scores per day vs random eligible rows on the same days
    te_idx = np.flatnonzero(test)
    days = b["date"][te_idx]
    order = np.lexsort((-s_te, days))
    picked, rand_pick, vr_pick = [], [], []
    vr_order = np.lexsort((-vr_te, days))
    ud, first, cnt = np.unique(days[order], return_index=True, return_counts=True)
    _, vfirst, vcnt = np.unique(days[vr_order], return_index=True, return_counts=True)
    for st, c_, vst, vc in zip(first, cnt, vfirst, vcnt):
        k = min(args.top_per_day, c_)
        grp = order[st:st + c_]
        picked += list(te_idx[grp[:k]])
        rand_pick += list(rng.choice(te_idx[grp], k, replace=False))
        vr_pick += list(te_idx[vr_order[vst:vst + min(args.top_per_day, vc)]])

    def perf(ix):
        r = trade[np.array(ix)]
        r = r[~np.isnan(r)]
        q99 = np.quantile(r, 0.99)
        return f"n={len(r):,}  mean {r.mean():+.2%}  median {np.median(r):+.2%}  win {np.mean(r > 0):.0%}  ex-top1% {r[r < q99].mean():+.2%}"

    out(f"\n4. trade on test years, top {args.top_per_day}/day: buy next open, sell +{args.target:.0%} limit or day-{H} close, cost >= 1%")
    out(f"   score     {perf(picked)}")
    out(f"   vol_ratio {perf(vr_pick)}")
    out(f"   random    {perf(rand_pick)}")

    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"score_poc_{dt.datetime.now():%Y%m%dT%H%M%S}.txt"
    path.write_text("\n".join(lines) + "\n")
    print(f"\nwrote {path}")


if __name__ == "__main__":
    main()
