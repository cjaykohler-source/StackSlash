"""
Below-VWAP first big days -- a candidate avoid rule (docs/below-vwap-prereg.md).

From research/minute_direction_wide.py (README item 39): on the first big-volume
day, the share of the session spent above the running VWAP predicted direction
out of sample (AUC 0.592 on 2016-19, 0.554 on 2020-21). As an avoid rule:

  EVENT  first big-volume day: vol_ratio >= 5 and none in the prior 20 sessions;
         at t-1 raw close $0.10-$5 and 20-day dollar volume >= $250k; >= 60 sessions
         of history (identical to minute_direction_wide.py)
  FLAG   share of regular-session minutes (09:30-15:59 ET) whose close is above the
         running session VWAP <= CUT, the lower tercile of that share among
         2016-19 events (fixed below after the discovery run)
  OUTCOME  entry at t+1's open, exit at t+5's close (split-adjusted), net of
         max(1%, a tick); windows with a >= 10x or <= 0.1x day dropped

    --discovery           2016-01..2021-12-22 only: the cut and the 2016-21 numbers
    --holdout --approved-commit <sha>
                          2022-01-03 .. the latest event with 5 forward sessions, ONCE;
                          refuses unless HEAD contains <sha> and this file and the
                          pre-registration are unchanged since
"""
import argparse
import datetime as dt
import json
import subprocess
from pathlib import Path

import duckdb
import numpy as np

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent
DATA = ROOT / "data"
METRICS = DATA / "charter" / "daily_metrics"
MIDX = DATA / "charter" / "minute_index.parquet"
OUT = DATA / "study_outputs"
PREREG = REPO / "docs" / "below-vwap-prereg.md"
CUT = None  # set from the discovery run before the pre-registration is approved
PERMS, BOOT, SEED = 5000, 2000, 7


def events(con, d0, d1, years):
    con.execute(f"""
      create or replace temp table d as
      select symbol, date, open, high, low, close, raw_close, volume, vol_ratio,
        row_number() over w as idx, lag(raw_close) over w as pc, lag(dollar20) over w as pd20,
        max(vol_ratio) over (w rows between 20 preceding and 1 preceding) as prior_vr,
        close / lag(close) over w as ratio
      from read_parquet('{METRICS}/*/*.parquet', hive_partitioning = true)
      where year between {years[0]} and {years[1]}
      window w as (partition by symbol order by date)
    """)
    con.execute(f"""
      create or replace temp table ev as
      select e.symbol, e.date,
        max(f.high) filter (where f.idx between e.idx + 1 and e.idx + 5) / e.close - 1 as up5,
        min(f.low) filter (where f.idx between e.idx + 1 and e.idx + 5) / e.close - 1 as dn5,
        max(f.ratio) as rmax, min(f.ratio) as rmin,
        any_value(f.open) filter (where f.idx = e.idx + 1) as o1,
        any_value(f.close) filter (where f.idx = e.idx + 5) as c5,
        any_value(f.raw_close) filter (where f.idx = e.idx + 1) as rc1
      from d e join d f on f.symbol = e.symbol and f.idx between e.idx + 1 and e.idx + 5
      where e.idx > 60 and e.date between date '{d0}' and date '{d1}'
        and e.pc between 0.10 and 5 and e.pd20 >= 250000
        and e.vol_ratio >= 5 and coalesce(e.prior_vr, 0) < 5
      group by e.symbol, e.date, e.close, e.idx
      having count(*) = 5
    """)
    con.execute("delete from ev where rmax >= 10 or rmin <= 0.1")
    con.execute(f"""
      create or replace temp table ef as
      select distinct ev.symbol, ev.date, i.file from ev join read_parquet('{MIDX}') i
        on i.symbol = ev.symbol and (i.day = ev.date or (i.day is null and i.month = date_trunc('month', ev.date)::date))
    """)
    files = [r[0] for r in con.execute("select distinct file from ef").fetchall() if Path(r[0]).exists()]
    con.execute("create or replace temp table mb (symbol varchar, date date, ts timestamp, close double, volume bigint, vwap double)")
    for k in range(0, len(files), 400):
        chunk = files[k:k + 400]
        con.execute(f"""
          insert into mb
          select m.symbol, (m.ts at time zone 'America/New_York')::date, (m.ts at time zone 'America/New_York'),
                 m.close, m.volume, m.vwap
          from read_parquet({chunk!r}, union_by_name = true) m
          join (select distinct symbol, date from ef) e on e.symbol = m.symbol and e.date = (m.ts at time zone 'America/New_York')::date
          where (m.ts at time zone 'America/New_York')::time between time '09:30' and time '15:59'
        """)
    return con.execute("""
      with b as (
        select symbol, date, ts, close,
          sum(vwap * volume) over (partition by symbol, date order by ts) / nullif(sum(volume) over (partition by symbol, date order by ts), 0) as run_vwap,
          hour(ts) * 60 + minute(ts) - 570 as minute
        from mb
      ),
      f as (select symbol, date, count(*) n, min(minute) first_min, avg((close > run_vwap)::int) above_vwap from b group by 1, 2)
      select ev.symbol, ev.date, ev.up5, ev.dn5, ev.o1, ev.c5, ev.rc1, f.above_vwap
      from ev join f using (symbol, date) where f.first_min <= 15 and f.n >= 60 order by ev.date, ev.symbol
    """).fetchnumpy()


def stats(e, cut, rng, out):
    r = e["c5"] / e["o1"] - 1 - np.maximum(0.01, np.where(e["rc1"] >= 1, 0.01, 0.0001) / e["rc1"])
    flag = e["above_vwap"] <= cut
    ok = ~np.isnan(r)
    r, flag, up, dn, days = r[ok], flag[ok], e["up5"][ok] >= 0.30, e["dn5"][ok] <= -0.20, e["date"][ok]
    diff = r[flag].mean() - r[~flag].mean()
    # one-sided permutation p (flagged worse), flags shuffled across events
    null = np.empty(PERMS)
    for i in range(PERMS):
        p = rng.permutation(flag)
        null[i] = r[p].mean() - r[~p].mean()
    pval = (np.sum(null <= diff) + 1) / (PERMS + 1)
    # day-clustered bootstrap of the difference
    ud = np.unique(days)
    grp = {d: np.flatnonzero(days == d) for d in ud}
    bs = []
    for _ in range(BOOT):
        ix = np.concatenate([grp[d] for d in rng.choice(ud, len(ud))])
        f_, r_ = flag[ix], r[ix]
        if f_.any() and (~f_).any():
            bs.append(r_[f_].mean() - r_[~f_].mean())
    ci = np.percentile(bs, [5, 95])
    out(f"  events {len(r):,}: flagged {flag.sum():,} ({flag.mean():.0%}), rest {(~flag).sum():,}")
    out(f"  5-session net return: flagged {r[flag].mean():+.2%} (median {np.median(r[flag]):+.2%}) vs rest {r[~flag].mean():+.2%} "
        f"(median {np.median(r[~flag]):+.2%})")
    out(f"  difference {diff:+.2%}, 90% CI [{ci[0]:+.2%}, {ci[1]:+.2%}], one-sided permutation p {pval:.4f}")
    out(f"  P(-20% within 5): flagged {dn[flag].mean():.1%} vs rest {dn[~flag].mean():.1%} | "
        f"P(+30%): flagged {up[flag].mean():.1%} vs rest {up[~flag].mean():.1%}")
    return dict(n=int(len(r)), n_flag=int(flag.sum()), flagged=float(r[flag].mean()), rest=float(r[~flag].mean()),
                diff=float(diff), ci=[float(ci[0]), float(ci[1])], p=float(pval),
                dn_flag=float(dn[flag].mean()), dn_rest=float(dn[~flag].mean()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--discovery", action="store_true")
    ap.add_argument("--holdout", action="store_true")
    ap.add_argument("--approved-commit")
    a = ap.parse_args()
    rng = np.random.default_rng(SEED)
    con = duckdb.connect()
    con.execute("set preserve_insertion_order = false")
    lines = []

    def out(s=""):
        print(s, flush=True)
        lines.append(s)

    if a.discovery:
        e = events(con, "2016-03-01", "2021-12-22", (2016, 2021))
        yr = np.array([int(str(d)[:4]) for d in e["date"]])
        cut = float(np.quantile(e["above_vwap"][yr <= 2019], 1 / 3))
        out(f"=== DISCOVERY 2016-21; cut = lower tercile of above-VWAP share among 2016-19 events = {cut:.4f} ===")
        res = {}
        for name, m in (("2016-19", yr <= 2019), ("2020-21", yr >= 2020), ("2016-21", yr > 0)):
            out(f"\n[{name}]")
            res[name] = stats({k: (v[m] if not isinstance(v, float) else v) for k, v in e.items()}, cut, rng, out)
        tag = "discovery"
    elif a.holdout:
        if CUT is None:
            raise SystemExit("CUT is not set: run --discovery and fix it in this file and the pre-registration first")
        if not a.approved_commit:
            raise SystemExit("--holdout needs --approved-commit <sha>")
        if subprocess.run(["git", "merge-base", "--is-ancestor", a.approved_commit, "HEAD"], cwd=REPO).returncode != 0:
            raise SystemExit("HEAD does not contain the approved commit")
        frozen = [str(Path(__file__).resolve().relative_to(REPO)), str(PREREG.relative_to(REPO))]
        changed = subprocess.run(["git", "diff", "--name-only", a.approved_commit, "HEAD", "--", *frozen], cwd=REPO,
                                 capture_output=True, text=True).stdout.strip()
        dirty = subprocess.run(["git", "status", "--porcelain", "--", *frozen], cwd=REPO, capture_output=True, text=True).stdout.strip()
        if changed or dirty:
            raise SystemExit(f"pre-registered files changed since {a.approved_commit}: {changed} {dirty}")
        e = events(con, "2022-01-03", "2100-01-01", (2021, 2100))
        out(f"=== HOLDOUT 2022+ (once), cut {CUT:.4f}, approved at {a.approved_commit} ===")
        res = {"2022+": stats(e, CUT, rng, out)}
        r = res["2022+"]
        verdict = "VALIDATED" if r["diff"] < 0 and r["ci"][1] < 0 and r["p"] <= 0.05 else "FAIL"
        out(f"\n  VERDICT: {verdict} (needs difference < 0, 90% CI below 0, one-sided p <= 0.05)")
        tag = "holdout"
    else:
        raise SystemExit("--discovery or --holdout")
    OUT.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    (OUT / f"below_vwap_{tag}_{stamp}.txt").write_text("\n".join(lines) + "\n")
    (OUT / f"below_vwap_{tag}_{stamp}.json").write_text(json.dumps(res, indent=1))
    print(f"\nwrote {OUT / f'below_vwap_{tag}_{stamp}.txt'}")


if __name__ == "__main__":
    main()
