"""
What do the two weeks before a big move look like -- winners vs losers?

For every eligible stock-day t (raw close $0.10-$5, 20-day dollar volume
>= $250k, 2016-2021; 2022+ stays sealed), classify the NEXT 5 sessions:
  winner   high touches +30% above t's close (and never -20%)
  loser    low touches -20% (and never +30%)
  neither  everything else ("both" is dropped)
and trace the 10 sessions up to and including t (offsets -9..0):
  vol_x    volume / the stock's normal volume, measured on sessions -30..-11
           (before the window, so the run-up can't distort its own baseline)
  c_vwap   close vs that day's VWAP (raw, from the SIP daily bar): > 0 means
           the close held above the day's average traded price
  clv      close location in the day's range (0 = at the low, 1 = at the high)
  ret      that day's move
Reported as group medians per offset, for all stocks and for the
"watchlist" profile the score favours (ATR >= 8% of price and below 60% of
the 52-week high), where winners and losers look alike on the surface.

Then, the lead-up SIGNAL test: summary features of the 10 days (days closing
above VWAP, volume trend, last-3-day volume, close vs VWAP on day 0, ...)
scored by AUC for winners vs losers -- the question "is there something to
follow during the lead-up that separates them?"

    research/.venv/bin/python research/leadup_profile.py
"""
import datetime as dt
from pathlib import Path

import duckdb
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view as swv

ROOT = Path(__file__).resolve().parent
WAREHOUSE = ROOT / "data" / "stackslash.duckdb"
OUT = ROOT / "data" / "study_outputs"
W, H = 20, 5


def auc(s, y):
    ok = ~np.isnan(s)
    s, y = s[ok], y[ok]
    o = np.argsort(s, kind="mergesort")
    r = np.empty(len(s)); r[o] = np.arange(1, len(s) + 1)
    n1 = y.sum(); n0 = len(y) - n1
    return (r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)


def main():
    con = duckdb.connect()
    con.execute(f"attach '{WAREHOUSE}' as wh (read_only)")
    print("loading bars with VWAP...", flush=True)
    d = con.execute("""
      with band as (
        select symbol from wh.sip_bars_daily_raw where date >= date '2016-01-01' and close between 0.10 and 5
        group by symbol having count(*) >= 60
      )
      select r.symbol, r.date, r.open ro, r.high rh, r.low rl, r.close rc, r.volume v, r.vwap rvw,
             s.high h, s.low l, s.close c
      from wh.sip_bars_daily_raw r join wh.sip_bars_daily_split s using (symbol, date) join band using (symbol)
      where r.date >= date '2015-06-01' and r.date <= date '2022-01-15'
        and not (r.volume <= 0 and r.open = r.high and r.high = r.low and r.low = r.close)
      order by r.symbol, r.date
    """).fetchnumpy()
    b = {k: np.asarray(v) for k, v in d.items()}
    for k in ("ro", "rh", "rl", "rc", "v", "rvw", "h", "l", "c"):
        b[k] = b[k].astype(float)
    sym, dates = b["symbol"], b["date"].astype("datetime64[D]")
    n = len(sym)
    starts = np.flatnonzero(np.r_[True, sym[1:] != sym[:-1]])
    ends = np.r_[starts[1:], n]
    print(f"  {n:,} bars", flush=True)

    vol_x = np.full(n, np.nan)       # volume / pre-window baseline, for the row itself as day 0 of ITS window
    c_vwap = np.full(n, np.nan)
    body = np.full(n, np.nan)        # open -> close change that day (the candle body)
    clv = np.full(n, np.nan)
    ret = np.full(n, np.nan)
    base_v = np.full(n, np.nan)      # baseline volume for a window ending at t: mean of v[t-30..t-11]
    outcome = np.full(n, -1)         # 1 winner, 0 loser, 2 neither, -1 n/a or both
    elig = np.zeros(n, bool)
    atr_pct = np.full(n, np.nan)
    pct52 = np.full(n, np.nan)
    for a, e in zip(starts, ends):
        m = e - a
        if m < 60:
            continue
        rc, rh, rl, v, rvw = b["rc"][a:e], b["rh"][a:e], b["rl"][a:e], b["v"][a:e], b["rvw"][a:e]
        c, h, l = b["c"][a:e], b["h"][a:e], b["l"][a:e]
        with np.errstate(invalid="ignore", divide="ignore"):
            c_vwap[a:e] = rc / rvw - 1
            body[a:e] = rc / b["ro"][a:e] - 1
            rng = rh - rl
            clv[a:e] = np.where(rng > 0, (rc - rl) / rng, 0.5)
            ret[a:e] = np.r_[np.nan, c[1:] / c[:-1] - 1]
            bv = np.full(m, np.nan)
            if m > W + 21:
                bv[W + 20:] = swv(v, 20).mean(axis=1)[: m - W - 20]  # v[t-W-20 .. t-W-1], before the window
            base_v[a:e] = bv
            pc = np.r_[np.nan, c[:-1]]
            tr = np.fmax(h - l, np.fmax(np.abs(h - pc), np.abs(l - pc)))
            atr = np.convolve(np.nan_to_num(tr), np.ones(14) / 14, "full")[:m]
            atr_pct[a:e] = atr / c
            hmax = np.maximum.accumulate(h)
            if m >= 252:
                hmax[251:] = swv(h, 252).max(axis=1)
            pct52[a:e] = c / hmax
            dv20 = np.convolve(rc * v, np.ones(20) / 20, "full")[:m]
            if m > H + 1:
                k = m - H
                up = swv(h[1:], H).max(axis=1)[:k] / c[:k] - 1 >= 0.30
                dn = swv(l[1:], H).min(axis=1)[:k] / c[:k] - 1 <= -0.20
                oc = np.where(up & ~dn, 1, np.where(dn & ~up, 0, np.where(~up & ~dn, 2, -1)))
                outcome[a:a + k] = oc
                ratio = np.r_[np.nan, c[1:] / c[:-1]]
                badr = ((ratio >= 10) | (ratio <= 0.1)).astype(int)
                cb = np.r_[0, np.cumsum(badr)]
                i = np.arange(k)
                clean = (cb[np.minimum(i + H + 1, m)] - cb[np.maximum(i - W - 21, 0)]) == 0
                yr = dates[a:a + k].astype("datetime64[Y]").astype(int) + 1970
                elig[a:a + k] = clean & (np.arange(k) >= W + 45) & (yr >= 2016) & (yr <= 2021) \
                    & (rc[:k] >= 0.10) & (rc[:k] <= 5) & (dv20[:k] >= 250_000) & ~np.isnan(rvw[:k])

    rows = np.flatnonzero(elig & (outcome >= 0))
    print(f"{len(rows):,} eligible stock-days: winners {np.sum(outcome[rows] == 1):,}, losers {np.sum(outcome[rows] == 0):,}, "
          f"neither {np.sum(outcome[rows] == 2):,}", flush=True)
    offs = np.arange(-(W - 1), 1)
    # per-row window matrices (rows x offsets)
    M = rows[:, None] + offs[None, :]
    VX = b["v"][M] / base_v[rows][:, None]
    CVW, CLV, RET, BODY = c_vwap[M], clv[M], ret[M], body[M]
    watch = (atr_pct[rows] >= 0.08) & (pct52[rows] <= 0.60)
    oc = outcome[rows]

    lines = []

    def out(s=""):
        print(s, flush=True)
        lines.append(s)

    groups = [("winners", oc == 1), ("losers", oc == 0), ("neither", oc == 2)]
    for title, sub in (("ALL eligible stock-days", np.ones(len(rows), bool)), ("WATCHLIST profile (ATR >= 8%, < 60% of 52w high)", watch)):
        out(f"\n=== {title} ===  n: " + ", ".join(f"{g} {int((m & sub).sum()):,}" for g, m in groups))
        for name, A, fmt in (("open->close (candle body)", BODY, "{:+5.1%}"), ("volume vs normal (x)", VX, "{:5.2f}"),
                             ("close vs VWAP", CVW, "{:+5.1%}"),
                             ("close location in range", CLV, "{:5.2f}"), ("daily move", RET, "{:+5.1%}")):
            out(f"\n  {name} (median), day -{W - 1} ... day 0 (signal day):")
            out("    " + " " * 9 + "".join(f"{o:>7}" for o in offs))
            for g, m in groups:
                mm = m & sub
                med = np.nanmedian(A[mm], axis=0)
                out(f"    {g:<9}" + "".join(f"{fmt.format(x):>7}" for x in med))
            if name == "open->close (candle body)":
                for g, m in groups:
                    mm = m & sub
                    out(f"    {g:<9} share GREEN (close > open): " + "".join(f"{np.nanmean(BODY[mm][:, j] > 0):>7.0%}" for j in range(W)))
                for g, m in groups:
                    mm = m & sub
                    out(f"    {g:<9} mean body:                  " + "".join(f"{np.nanmean(BODY[mm][:, j]):>+7.1%}" for j in range(W)))
            if name == "close vs VWAP":
                for g, m in groups:
                    mm = m & sub
                    out(f"    {g:<9} share of days closing ABOVE VWAP: " + "".join(f"{np.nanmean(CVW[mm][:, j] > 0):>7.0%}" for j in range(W)))

    # lead-up summary features, winners vs losers
    with np.errstate(invalid="ignore", divide="ignore"):
        feats = {
            "green days (of 20)": np.nansum(BODY > 0, axis=1),
            "green days (last 5)": np.nansum(BODY[:, -5:] > 0, axis=1),
            "sum of bodies, 20d": np.nansum(BODY, axis=1),
            "sum of bodies, last 5": np.nansum(BODY[:, -5:], axis=1),
            "body, day 0": BODY[:, -1],
            "mean |body|, last 5 (intraday range use)": np.nanmean(np.abs(BODY[:, -5:]), axis=1),
            "body trend (last 5 mean - first 15 mean)": np.nanmean(BODY[:, -5:], axis=1) - np.nanmean(BODY[:, :15], axis=1),
            "longest green streak ending day 0": np.array([next((i for i in range(W) if not r[W - 1 - i] > 0), W) for r in BODY]),
            "gap share (overnight part of 20d move)": np.nansum(RET - BODY, axis=1),
            "days above VWAP (of 20)": np.nansum(CVW > 0, axis=1),
            "days above VWAP (last 3)": np.nansum(CVW[:, -3:] > 0, axis=1),
            "close vs VWAP, day 0": CVW[:, -1],
            "mean close vs VWAP, last 3": np.nanmean(CVW[:, -3:], axis=1),
            "volume x, day 0": VX[:, -1],
            "volume x, last 3 mean": np.nanmean(VX[:, -3:], axis=1),
            "volume x, first 5 mean": np.nanmean(VX[:, :5], axis=1),
            "volume trend (last 3 / first 5)": np.nanmean(VX[:, -3:], axis=1) / np.nanmean(VX[:, :5], axis=1),
            "up-volume share (vol on up days)": np.nansum(np.where(RET > 0, VX, 0), axis=1) / np.nansum(VX, axis=1),
            "close location, last 3 mean": np.nanmean(CLV[:, -3:], axis=1),
            "20-day return": np.nanprod(1 + RET, axis=1) - 1,
            "max single-day move in window": np.nanmax(RET, axis=1),
        }
    for title, sub in (("ALL", np.ones(len(rows), bool)), ("WATCHLIST", watch)):
        m = sub & (oc <= 1)
        y = (oc[m] == 1).astype(float)
        out(f"\n=== Lead-up signal test, {title}: winners vs losers (AUC; 0.5 = no separation, >0.5 = higher -> winner) ===")
        out(f"  {'feature':<36}{'AUC':>7}{'winners med':>13}{'losers med':>12}")
        res = []
        for k, v in feats.items():
            vv = v[m]
            res.append((abs(auc(vv, y) - 0.5), k, auc(vv, y), np.nanmedian(vv[y == 1]), np.nanmedian(vv[y == 0])))
        for _, k, a, mw, ml in sorted(res, reverse=True):
            out(f"  {k:<36}{a:>7.3f}{mw:>13.3f}{ml:>12.3f}")

    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"leadup_profile_{dt.datetime.now():%Y%m%dT%H%M%S}.txt"
    path.write_text("\n".join(lines) + "\n")
    print(f"\nwrote {path}")


if __name__ == "__main__":
    main()
