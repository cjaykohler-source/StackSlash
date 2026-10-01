"""
Minute-bar direction test on ALL first big-volume days (README item 39, the
follow-up to minute_direction.py). Identical design except the lead-up
condition is dropped: only ~1 in 6 first big days had a lead-up, so the
first run had 86 labelled events in 2016-19 and was inconclusive. Approved
by the user 2026-10-01 before running. The lead-up subset (86 stage-A events)
was seen in the first run; it is ~1/6 of this sample.

Original description follows; the LEADUP flag below switches the condition.

Minute-bar direction test on lead-up days (README item 39).

The daily data says volume builds for ~2 weeks before big moves in EITHER
direction (leadup_profile.py), and that the direction is set on the move
day itself. Daily close-vs-VWAP, candle and close-location features carry
nothing (AUC ~0.5). The one place left for direction is inside that first
big day. Question: does the first big day's intraday action -- opening
range, VWAP, where the high and low print, late volume -- say which way the
next 5 sessions go?

Everything below is fixed before the first run. 2022+ stays sealed: events
end 2021-12-22 so every 5-session outcome closes inside 2021.

EVENTS (daily, research/data/charter/daily_metrics)
  universe at t-1 (known before the session): raw close $0.10-$5, 20-day
    dollar volume >= $250k, >= 60 sessions of history
  lead-up: median volume over t-10..t-1 >= 1.5 x median volume over t-40..t-11
  big day t: vol_ratio >= 5 (volume vs the previous 20 sessions' mean), and
    no vol_ratio >= 5 day in t-20..t-1 (the FIRST big day)
  dates 2016-03-01 .. 2021-12-22

DIRECTION (split-adjusted, from day t's close, next 5 sessions; windows with
  a >= 10x or <= 0.1x day dropped)
  winner = high reaches +30% and the low never -20%; loser = the reverse;
  "both" and "neither" are excluded from the AUC (as in leadup_profile.py)

FEATURES (SIP minute bars, regular session 09:30-15:59 ET, day t; a day
  needs its first bar by 09:45 and >= 60 bars, else it is dropped)
  1 or_break      first break after 10:00 of the 09:30-09:59 range: +1 high first, -1 low first, 0 neither
  2 ret_first30   09:30 open -> 09:59 close
  3 above_vwap    share of minutes whose close is above the running session VWAP
  4 close_vwap    day close / session VWAP - 1
  5 ret_last_hr   15:00 open -> last close
  6 high_time     time of the session high, 0 = open .. 1 = close
  7 low_time      time of the session low, 0 .. 1
  8 late_volume   share of the day's volume after 14:00

STAGE A (2016-2019): per feature, AUC winner vs loser; p from 2,000 label
  shuffles (two-sided, |AUC - 0.5|); Benjamini-Hochberg q across the 8.
  Carried to stage B: q <= 0.10 and |AUC - 0.5| >= 0.03.
STAGE B (2020-2021, once, only the carried features):
  AUC on the same side as stage A, two-sided shuffle p, Holm across carried
  features at 0.05; and a trade -- events in the feature's favourable stage-A
  tercile, entry t+1 open, exit t+5 close, net of max(1%, a tick), vs all
  stage-B events entered the same way -- with a day-clustered bootstrap 90%
  interval of the difference.
  PASS = AUC side holds, Holm p <= 0.05, trade mean > 0 and the interval of
  the difference above 0.

    research/.venv/bin/python research/minute_direction.py
"""
import datetime as dt
from pathlib import Path

import duckdb
import numpy as np

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
METRICS = DATA / "charter" / "daily_metrics"
MIDX = DATA / "charter" / "minute_index.parquet"
OUT = DATA / "study_outputs"
LEADUP = False  # minute_direction_wide: no lead-up condition
FEATURES = ["or_break", "ret_first30", "above_vwap", "close_vwap", "ret_last_hr", "high_time", "low_time", "late_volume"]
SHUFFLES, BOOT, SEED = 2000, 1000, 7


def auc(s, y):
    ok = ~np.isnan(s)
    s, y = s[ok], y[ok]
    o = np.argsort(s, kind="mergesort")
    r = np.empty(len(s)); r[o] = np.arange(1, len(s) + 1)
    # average ranks for ties (or_break is -1/0/1)
    _, inv, cnt = np.unique(s, return_inverse=True, return_counts=True)
    sums = np.bincount(inv, weights=r)
    r = (sums / cnt)[inv]
    n1 = y.sum(); n0 = len(y) - n1
    return (r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)


def shuffle_p(s, y, rng):
    a = abs(auc(s, y) - 0.5)
    ok = ~np.isnan(s)
    s, y = s[ok], y[ok]
    null = np.array([abs(auc(s, rng.permutation(y)) - 0.5) for _ in range(SHUFFLES)])
    return (np.sum(null >= a) + 1) / (SHUFFLES + 1)


def main():
    rng = np.random.default_rng(SEED)
    con = duckdb.connect()
    con.execute("set preserve_insertion_order = false")
    lines = []

    def out(s=""):
        print(s, flush=True)
        lines.append(s)

    out("events from daily_metrics...")
    con.execute(f"""
      create temp table d as
      select symbol, date, open, high, low, close, raw_close, volume, vol_ratio, dollar20,
        row_number() over w as idx,
        lag(raw_close) over w as pc, lag(dollar20) over w as pd20,
        quantile_cont(volume, 0.5) over (w rows between 10 preceding and 1 preceding) as med_recent,
        quantile_cont(volume, 0.5) over (w rows between 40 preceding and 11 preceding) as med_base,
        max(vol_ratio) over (w rows between 20 preceding and 1 preceding) as prior_vr,
        close / lag(close) over w as ratio
      from read_parquet('{METRICS}/*/*.parquet', hive_partitioning = true)
      where year between 2016 and 2021
      window w as (partition by symbol order by date)
    """)
    con.execute(f"""
      create temp table ev as
      select e.symbol, e.date, e.close c0, e.idx,
        max(f.high) filter (where f.idx between e.idx + 1 and e.idx + 5) / e.close - 1 as up5,
        min(f.low) filter (where f.idx between e.idx + 1 and e.idx + 5) / e.close - 1 as dn5,
        -- which comes first: the first session reaching +30% vs -20%
        min(f.idx) filter (where f.idx between e.idx + 1 and e.idx + 5 and f.high >= e.close * 1.3) as first_up,
        min(f.idx) filter (where f.idx between e.idx + 1 and e.idx + 5 and f.low <= e.close * 0.8) as first_dn,
        max(f.ratio) filter (where f.idx between e.idx + 1 and e.idx + 5) as rmax,
        min(f.ratio) filter (where f.idx between e.idx + 1 and e.idx + 5) as rmin,
        any_value(f.open) filter (where f.idx = e.idx + 1) as o1,
        any_value(f.close) filter (where f.idx = e.idx + 5) as c5,
        any_value(f.raw_close) filter (where f.idx = e.idx + 1) as rc1
      from d e join d f on f.symbol = e.symbol and f.idx between e.idx + 1 and e.idx + 5
      where e.idx > 60 and e.date between date '2016-03-01' and date '2021-12-22'
        and e.pc between 0.10 and 5 and e.pd20 >= 250000
        and (not {LEADUP} or (e.med_base > 0 and e.med_recent >= 1.5 * e.med_base))
        and e.vol_ratio >= 5 and coalesce(e.prior_vr, 0) < 5
      group by e.symbol, e.date, e.close, e.idx
      having count(*) = 5
    """)
    n_all = con.execute("select count(*) from ev").fetchone()[0]
    con.execute("delete from ev where rmax >= 10 or rmin <= 0.1")
    out(f"  {n_all:,} first big days{' after a lead-up' if LEADUP else ' (no lead-up condition)'}; {con.execute('select count(*) from ev').fetchone()[0]:,} after the artifact guard")

    out("minute bars for each event day...")
    con.execute(f"""
      create temp table ef as
      select distinct ev.symbol, ev.date, i.file from ev join read_parquet('{MIDX}') i
        on i.symbol = ev.symbol and (i.day = ev.date or (i.day is null and i.month = date_trunc('month', ev.date)::date))
    """)
    files = [r[0] for r in con.execute("select distinct file from ef").fetchall() if Path(r[0]).exists()]
    out(f"  {len(files):,} minute files")
    con.execute("create temp table mb (symbol varchar, date date, ts timestamp, open double, high double, low double, close double, volume bigint, vwap double)")
    for k in range(0, len(files), 400):
        chunk = files[k:k + 400]
        con.execute(f"""
          insert into mb
          select m.symbol, (m.ts at time zone 'America/New_York')::date, (m.ts at time zone 'America/New_York'),
                 m.open, m.high, m.low, m.close, m.volume, m.vwap
          from read_parquet({chunk!r}, union_by_name = true) m
          join (select distinct symbol, date from ef) e
            on e.symbol = m.symbol and e.date = (m.ts at time zone 'America/New_York')::date
          where (m.ts at time zone 'America/New_York')::time between time '09:30' and time '15:59'
        """)
    out(f"  {con.execute('select count(*) from mb').fetchone()[0]:,} regular-session minute bars")

    feats = con.execute("""
      with b as (
        select *, (hour(ts) * 60 + minute(ts) - 570) as minute,
          sum(vwap * volume) over (partition by symbol, date order by ts) / nullif(sum(volume) over (partition by symbol, date order by ts), 0) as run_vwap
        from mb
      ),
      day as (
        select symbol, date, count(*) n, min(minute) first_min, max(minute) last_min,
          arg_min(open, ts) o, arg_max(close, ts) c,
          max(high) filter (where minute < 30) or_hi, min(low) filter (where minute < 30) or_lo,
          arg_max(close, ts) filter (where minute < 30) c30,
          sum(vwap * volume) / nullif(sum(volume), 0) vw,
          avg((close > run_vwap)::int) above_vwap,
          arg_min(open, ts) filter (where minute >= 330) o15,
          arg_max(minute, high) hi_min, arg_min(minute, low) lo_min,
          sum(volume) filter (where minute >= 270) / nullif(sum(volume), 0) late_volume
        from b group by 1, 2
      ),
      brk as (
        select b.symbol, b.date,
          min(b.minute) filter (where b.minute >= 30 and b.high > d.or_hi) first_hi,
          min(b.minute) filter (where b.minute >= 30 and b.low < d.or_lo) first_lo
        from b join day d using (symbol, date) group by 1, 2
      )
      select d.symbol, d.date, d.n, d.first_min,
        case when brk.first_hi is not null and (brk.first_lo is null or brk.first_hi < brk.first_lo) then 1
             when brk.first_lo is not null and (brk.first_hi is null or brk.first_lo < brk.first_hi) then -1
             when brk.first_hi is not null and brk.first_hi = brk.first_lo then 0 else 0 end or_break,
        d.c30 / d.o - 1 ret_first30, d.above_vwap, d.c / d.vw - 1 close_vwap,
        d.c / d.o15 - 1 ret_last_hr, d.hi_min / 389.0 high_time, d.lo_min / 389.0 low_time, d.late_volume
      from day d join brk using (symbol, date)
    """).fetchnumpy()
    fx = {(s, str(dd)[:10]): i for i, (s, dd) in enumerate(zip(feats["symbol"], feats["date"]))}
    ev = con.execute("select symbol, date, up5, dn5, first_up, first_dn, o1, c5, rc1 from ev order by date, symbol").fetchnumpy()
    n = len(ev["symbol"])
    F = {k: np.full(n, np.nan) for k in FEATURES}
    have = np.zeros(n, bool)
    for i in range(n):
        j = fx.get((ev["symbol"][i], str(ev["date"][i])[:10]))
        if j is None or feats["first_min"][j] > 15 or feats["n"][j] < 60:
            continue
        have[i] = True
        for k in FEATURES:
            v = feats[k][j]
            F[k][i] = np.nan if v is None else float(v)
    up = np.asarray(ev["up5"], float) >= 0.30
    dn = np.asarray(ev["dn5"], float) <= -0.20
    winner = up & ~dn
    loser = dn & ~up
    lab = have & (winner | loser)
    year = np.array([int(str(d)[:4]) for d in ev["date"]])
    out(f"  {have.sum():,} events with usable minute data; winners {np.sum(have & winner):,}, losers {np.sum(have & loser):,}, "
        f"both {np.sum(have & up & dn):,}, neither {np.sum(have & ~up & ~dn):,}")
    # trade: entry t+1 open, exit t+5 close (split-adjusted), net of max(1%, tick at t+1's raw price)
    o1, c5, rc1 = (np.asarray(ev[k], float) for k in ("o1", "c5", "rc1"))
    tick = np.where(rc1 >= 1, 0.01, 0.0001) / rc1
    ret = c5 / o1 - 1 - np.maximum(0.01, tick)

    A = lab & (year <= 2019)
    B = lab & (year >= 2020)
    out(f"\n=== STAGE A 2016-19: {A.sum():,} labelled events (winners {np.sum(A & winner):,}) ===")
    res = []
    for k in FEATURES:
        a = auc(F[k][A], winner[A].astype(int))
        p = shuffle_p(F[k][A], winner[A].astype(int), rng)
        res.append([k, a, p])
    ps = np.array([r[2] for r in res])
    order = np.argsort(ps)
    q = np.empty(len(ps)); prev = 1.0
    for rank in range(len(ps), 0, -1):
        i = order[rank - 1]
        prev = min(prev, ps[i] * len(ps) / rank); q[i] = prev
    carried = []
    for (k, a, p), qq in zip(res, q):
        go = qq <= 0.10 and abs(a - 0.5) >= 0.03
        if go:
            carried.append(k)
        out(f"  {k:<13} AUC {a:.3f}  p {p:.4f}  q {qq:.3f}{'  -> stage B' if go else ''}")

    out(f"\n=== STAGE B 2020-21 (once): {B.sum():,} labelled events; carried: {carried or 'none'} ===")
    if not carried:
        out("  nothing carried: no minute-bar feature separates winners from losers on 2016-19.")
    pB = []
    allB = np.flatnonzero(have & (year >= 2020) & ~np.isnan(ret))
    for k in carried:
        aA = auc(F[k][A], winner[A].astype(int))
        aB = auc(F[k][B], winner[B].astype(int))
        p = shuffle_p(F[k][B], winner[B].astype(int), rng)
        pB.append(p)
        # favourable tercile from stage A cut points (all stage-A events with data, not just labelled)
        sA = F[k][have & (year <= 2019)]
        cuts = np.nanquantile(sA, [1 / 3, 2 / 3])
        fav = (F[k] >= cuts[1]) if aA > 0.5 else (F[k] <= cuts[0])
        pick = allB[fav[allB]]
        # day-clustered bootstrap: resample event days with replacement, all trades of a drawn day count each time
        da, db = ev["date"][pick], ev["date"][allB]
        udays = np.unique(db)
        by_a = {d: ret[pick][(da == d)] for d in udays}
        by_b = {d: ret[allB][(db == d)] for d in udays}
        diffs = []
        for _ in range(BOOT):
            ds = rng.choice(udays, len(udays))
            ra = np.concatenate([by_a[d] for d in ds]); rb = np.concatenate([by_b[d] for d in ds])
            diffs.append(np.nanmean(ra) - np.nanmean(rb))
        ci = np.nanpercentile(diffs, [5, 95])
        out(f"  {k:<13} AUC A {aA:.3f} -> B {aB:.3f}  p {p:.4f} | trade fav tercile {np.nanmean(ret[pick]):+.2%} (n={len(pick):,}, "
            f"median {np.nanmedian(ret[pick]):+.2%}) vs all {np.nanmean(ret[allB]):+.2%} (n={len(allB):,}) | diff 90% CI [{ci[0]:+.2%}, {ci[1]:+.2%}]")
        res_b = dict(k=k, same=(aA - 0.5) * (aB - 0.5) > 0, trade=np.nanmean(ret[pick]), ci=ci)
        carried[carried.index(k)] = res_b
    if carried:
        holm = sorted(range(len(pB)), key=lambda i: pB[i]); adj = [0.0] * len(pB); run = 0.0
        for rank, i in enumerate(holm):
            run = max(run, min(1.0, (len(pB) - rank) * pB[i])); adj[i] = run
        out("\n  PASS/FAIL:")
        for r, a in zip(carried, adj):
            ok = r["same"] and a <= 0.05 and r["trade"] > 0 and r["ci"][0] > 0
            out(f"    {r['k']:<13} {'PASS' if ok else 'FAIL'} (side {'holds' if r['same'] else 'flips'}, Holm p {a:.4f}, "
                f"trade {r['trade']:+.2%}, diff CI [{r['ci'][0]:+.2%}, {r['ci'][1]:+.2%}])")

    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"minute_direction_wide_{dt.datetime.now():%Y%m%dT%H%M%S}.txt"
    path.write_text("\n".join(lines) + "\n")
    print(f"\nwrote {path}")


if __name__ == "__main__":
    main()
