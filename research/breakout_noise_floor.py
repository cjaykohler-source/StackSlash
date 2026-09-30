"""
Phase 0 gate for the breakout study (docs/breakout-study.md open items 1
and 2): is the quiet-streak + price-decline lift real, or noise plus
repeat-offender symbols?

Signal cells (all point-in-time, computed at the session close):
  streak_len     consecutive sessions with volume < 1.0x its prior-20 average
  down20         split-adjusted 20-session return <= -20% (artifact-guarded)
  cells          streak 1-10 / 11-20 / 20+ each AND down20, plus vol_ratio >= 5x
Outcome: a validated breakout (breakout_events.py) in the next --forward
sessions. Population: rows with raw close in $0.10-$5 and a positive adv20.

Two tests per cell, each period (2016-21, 2022+) separately:

  1. Noise floor -- circular shift. Each symbol's flag series is rotated
     by a random offset (>= --min-shift sessions) and the hit rate
     recomputed, --reps times. This keeps every symbol's own flag rate and
     the flags' clustering, and only breaks their timing relative to that
     symbol's breakouts. So it asks the right question: does the signal
     know WHEN, or only WHICH names tend to break out? Reports the null
     lift distribution and the share of shuffles >= the observed lift.
  2. Symbol-clustered bootstrap 90% interval on the observed lift
     (rows of one symbol are not independent draws).

Dedupe variants:
  all_events       the validated list as is
  first_event      only each symbol's first validated event counts as a hit
  no_repeaters     symbols with 2+ events dropped from the population
  episodes         flags only count on a symbol's first flagged day in any
                   --forward-session stretch (one signal per episode)

    research/.venv/bin/python research/breakout_noise_floor.py \\
        research/data/study_outputs/breakout_events_TIMESTAMP.csv [--reps 200]
"""
import argparse
import datetime as dt
from pathlib import Path

import duckdb
import numpy as np

ROOT = Path(__file__).resolve().parent
WAREHOUSE = ROOT / "data" / "stackslash.duckdb"
OUT = ROOT / "data" / "study_outputs"


def load(events_csv):
    con = duckdb.connect(str(WAREHOUSE), read_only=True)
    con.execute(f"create temp table events as select distinct symbol, event_date::date as event_date from read_csv_auto('{events_csv}')")
    con.execute("""
      create temp table band as
      select symbol from sip_bars_daily_raw
      where date >= date '2016-01-01' and close between 0.10 and 5.00
      group by symbol having count(*) >= 60
    """)
    print("Building daily feature table...", flush=True)
    con.execute("""
      create temp table d as
      select r.symbol, r.date, r.volume as v, r.close as raw_close, s.close as adj_close,
             r.close / nullif(lag(r.close, 1) over w, 0) as raw_daily_ratio
      from sip_bars_daily_raw r
      join sip_bars_daily_split s using (symbol, date)
      join band using (symbol)
      where r.date >= date '2016-01-01'
      window w as (partition by r.symbol order by r.date)
    """)
    con.execute("""
      create temp table f as
      select *,
        avg(v) over w20 as adv20,
        v::double / nullif(avg(v) over w20, 0) as vol_ratio,
        adj_close / nullif(lag(adj_close, 20) over w, 0) - 1 as ret20,
        min(raw_daily_ratio) over (partition by symbol order by date rows between 44 preceding and 0 following) as min_ratio_45,
        max(raw_daily_ratio) over (partition by symbol order by date rows between 44 preceding and 0 following) as max_ratio_45
      from d
      window w as (partition by symbol order by date),
             w20 as (partition by symbol order by date rows between 20 preceding and 1 preceding)
    """)
    con.execute("""
      create temp table s as
      select *,
        case when vol_ratio < 1.0 then row_number() over (partition by symbol, grp order by date) else 0 end as streak_len
      from (select *, sum(case when vol_ratio < 1.0 then 0 else 1 end) over (partition by symbol order by date) as grp from f)
    """)
    rows = con.execute("""
      select dense_rank() over (order by s.symbol) - 1 as sid,
             extract(year from s.date) < 2022 as early,
             coalesce(s.raw_close between 0.10 and 5.00 and s.adv20 > 0, false) as elig,
             coalesce(s.streak_len, 0) as streak,
             coalesce(s.ret20 <= -0.20 and s.min_ratio_45 >= 0.1 and s.max_ratio_45 <= 10, false) as down20,
             coalesce(s.vol_ratio >= 5, false) as vr5,
             e.symbol is not null as is_event
      from s left join events e on e.symbol = s.symbol and e.event_date = s.date
      order by s.symbol, s.date
    """).fetchnumpy()
    return {k: np.asarray(v) for k, v in rows.items()}


def forward_hits(sid, is_event, starts, lens, forward):
    """breaks_out[i]: an event in rows (i, i+forward] of the same symbol."""
    c = np.concatenate([[0], np.cumsum(is_event)])
    i = np.arange(len(sid))
    end = np.minimum(i + forward, starts[sid] + lens[sid] - 1)
    return (c[end + 1] - c[i + 1]) > 0


def episodes(flag, sid, starts, forward):
    """Keep a flag only if the symbol had no flag in the previous `forward` rows."""
    c = np.concatenate([[0], np.cumsum(flag)])
    i = np.arange(len(flag))
    lo = np.maximum(i - forward, starts[sid])
    return flag & ((c[i] - c[lo]) == 0)


def per_symbol_cumsum(x, starts, sid):
    c = np.cumsum(x)
    before = np.concatenate([[0], c])[starts]
    return c - before[sid]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("events_csv")
    ap.add_argument("--forward", type=int, default=20)
    ap.add_argument("--reps", type=int, default=200)
    ap.add_argument("--boot", type=int, default=1000)
    ap.add_argument("--min-shift", type=int, default=60)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)

    a = load(args.events_csv)
    sid = a["sid"].astype(np.int64)
    nsym = sid.max() + 1
    lens = np.bincount(sid, minlength=nsym)
    starts = np.concatenate([[0], np.cumsum(lens)[:-1]])
    local = np.arange(len(sid)) - starts[sid]
    print(f"{len(sid):,} rows, {nsym:,} symbols, {int(a['is_event'].sum()):,} events matched", flush=True)

    ev_all = a["is_event"].astype(bool)
    ev_first = ev_all & (per_symbol_cumsum(ev_all, starts, sid) == 1)
    repeaters = np.bincount(sid, weights=ev_all, minlength=nsym)[sid] >= 2

    streak, down20, vr5 = a["streak"], a["down20"].astype(bool), a["vr5"].astype(bool)
    cells = {
        "streak 1-10 + down20": (streak >= 1) & (streak <= 10) & down20,
        "streak 11-20 + down20": (streak >= 11) & (streak <= 20) & down20,
        "streak 20+ + down20": (streak > 20) & down20,
        "vol_ratio >= 5x": vr5,
    }
    everyone = np.ones_like(ev_all)
    variants = {
        "all_events": (ev_all, everyone, False),
        "first_event": (ev_first, everyone, False),
        "no_repeaters": (ev_all, ~repeaters, False),
        "episodes": (ev_all, everyone, True),
    }
    early = a["early"].astype(bool)
    elig0 = a["elig"].astype(bool)
    span = np.maximum(lens - 2 * args.min_shift, 1)
    shiftable = lens > 2 * args.min_shift

    lines = []

    def out(s=""):
        print(s, flush=True)
        lines.append(s)

    out(f"forward={args.forward} reps={args.reps} boot={args.boot} min_shift={args.min_shift} seed={args.seed}")
    for vname, (ev, keep, epi) in variants.items():
        hits = forward_hits(sid, ev, starts, lens, args.forward)
        elig = elig0 & keep
        out(f"\n=== {vname} ===")
        for pname, pmask in (("2016-21", early), ("2022+", ~early)):
            pop = elig & pmask
            base = hits[pop].mean()
            out(f"  [{pname}] baseline {100*base:.3f}%  (n={pop.sum():,})")
            pn = np.bincount(sid, weights=pop, minlength=nsym)
            ph = np.bincount(sid, weights=pop & hits, minlength=nsym)
            for cname, flag in cells.items():
                fl = episodes(flag, sid, starts, args.forward) if epi else flag
                sel = fl & pop
                n = int(sel.sum())
                if n < 200:
                    out(f"    {cname:<24} n={n} (too few)")
                    continue
                obs = hits[sel].mean() / base
                # noise floor: rotate each symbol's flag series
                null = np.full(args.reps, np.nan)
                for r in range(args.reps):
                    k = np.where(shiftable, args.min_shift + rng.integers(0, span), rng.integers(1, np.maximum(lens, 2)))
                    src = starts[sid] + (local - k[sid]) % lens[sid]
                    sh = fl[src] & pop
                    if sh.any():
                        null[r] = hits[sh].mean() / base
                p = (np.sum(null >= obs) + 1) / (np.sum(~np.isnan(null)) + 1)
                # symbol-clustered bootstrap on the observed lift
                fn = np.bincount(sid, weights=sel, minlength=nsym)
                fh = np.bincount(sid, weights=sel & hits, minlength=nsym)
                bl = np.empty(args.boot)
                for b in range(args.boot):
                    w = np.bincount(rng.integers(0, nsym, nsym), minlength=nsym)
                    bl[b] = ((w @ fh) / max(w @ fn, 1)) / max((w @ ph) / max(w @ pn, 1), 1e-12)
                lo, hi = np.percentile(bl, [5, 95])
                out(f"    {cname:<24} n={n:>8,} syms={int((fn > 0).sum()):>5,} hit={100*hits[sel].mean():.3f}%  "
                    f"lift={obs:.2f}x  90%CI[{lo:.2f},{hi:.2f}]  null med={np.nanmedian(null):.2f}x "
                    f"p95={np.nanpercentile(null, 95):.2f}x  p={p:.3f}")

    OUT.mkdir(parents=True, exist_ok=True)
    ts = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    path = OUT / f"breakout_noise_floor_{ts}.txt"
    path.write_text("\n".join(lines) + "\n")
    print(f"\nwrote {path}")


if __name__ == "__main__":
    main()
