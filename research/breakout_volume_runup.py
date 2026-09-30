"""
What does volume look like in the sessions leading up to a validated
75%+ single-session breakout (see breakout_events.py)? For each event,
pulls the --lookback trading sessions strictly before it (default 45,
~9 weeks) and reports that day's volume_ratio_20d (that session's volume
/ the 20 sessions trailing average as of that session -- the same
point-in-time metric used everywhere else in this project), aggregated
by trading-session offset from the breakout (-45 .. -1).

Control: the unconditional volume_ratio_20d distribution across the same
in-band population (every session, not just pre-breakout ones) -- answers
whether a run-up ramp is a real precursor or just what these generally
higher-turnover names look like anyway.

Reads a breakout_events.py output CSV (symbol, event_date, ...) so the
event list stays pinned to a specific validated run rather than a live
re-query that could quietly change.

    research/.venv/bin/python research/breakout_volume_runup.py \\
        research/data/study_outputs/breakout_events_TIMESTAMP.csv [--lookback 45]
"""
import argparse
import csv
import datetime as dt
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent
WAREHOUSE = ROOT / "data" / "stackslash.duckdb"
OUT = ROOT / "data" / "study_outputs"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("events_csv")
    ap.add_argument("--lookback", type=int, default=45, help="trading sessions before the event to profile")
    ap.add_argument("--min-price", type=float, default=0.10)
    ap.add_argument("--max-price", type=float, default=5.00)
    args = ap.parse_args()

    with open(args.events_csv) as fh:
        events = [(r["symbol"], r["event_date"]) for r in csv.DictReader(fh)]
    if not events:
        raise SystemExit(f"No events in {args.events_csv}")

    con = duckdb.connect(str(WAREHOUSE), read_only=True)
    con.execute(f"""
      create temp table band as
      select symbol from sip_bars_daily_raw
      where date >= date '2016-01-01' and close between {args.min_price} and {args.max_price}
      group by symbol having count(*) >= 60
    """)

    con.execute("""
      create temp table events (symbol varchar, event_date date)
    """)
    con.executemany("insert into events values (?, ?::date)", events)

    # Every in-band session, with its own point-in-time volume_ratio_20d
    # (today's volume / the 20 sessions strictly before it) and a
    # per-symbol row number so an event's "45 sessions before" is a simple
    # row-number range, not a date-arithmetic guess across weekends/holidays.
    con.execute("""
      create temp table d as
      select s.symbol, s.date, s.volume,
             row_number() over (partition by s.symbol order by s.date) as rn,
             s.volume::double / nullif(
               avg(s.volume) over (partition by s.symbol order by s.date rows between 20 preceding and 1 preceding), 0
             ) as vol_ratio
      from sip_bars_daily_raw s
      join band using (symbol)
      where s.date >= date '2016-01-01'
    """)

    con.execute("""
      create temp table event_rn as
      select e.symbol, e.event_date, d.rn as event_rn
      from events e
      join d on d.symbol = e.symbol and d.date = e.event_date
    """)
    n_matched = con.execute("select count(*) from event_rn").fetchone()[0]
    if n_matched < len(events):
        print(f"Warning: {len(events) - n_matched} of {len(events)} events did not match a daily bar row (check the CSV's dates/symbols).")

    con.execute(f"""
      create temp table runup as
      select er.symbol, er.event_date, d.rn - er.event_rn as offset, d.vol_ratio
      from event_rn er
      join d on d.symbol = er.symbol and d.rn between er.event_rn - {args.lookback} and er.event_rn - 1
      where d.vol_ratio is not null
    """)

    by_offset = con.execute("""
      select offset, count(*) n,
             round(avg(vol_ratio), 2) mean_vr,
             round(median(vol_ratio), 2) median_vr,
             round(quantile_cont(vol_ratio, 0.75), 2) p75_vr
      from runup
      group by offset
      order by offset
    """).fetchall()

    control = con.execute("""
      select count(*) n, round(avg(vol_ratio), 2) mean_vr, round(median(vol_ratio), 2) median_vr
      from d where vol_ratio is not null
    """).fetchone()

    # Coarser weekly buckets (9 weeks back), easier to read at a glance
    # than 45 individual day rows.
    weekly = con.execute(f"""
      select (({args.lookback} - 1 - (offset + {args.lookback})) / 5) as week_bucket,
             min(offset) lo, max(offset) hi,
             round(avg(vol_ratio), 2) mean_vr, round(median(vol_ratio), 2) median_vr
      from runup
      group by week_bucket
      order by week_bucket
    """).fetchall()

    print(f"Events: {len(events):,} (matched {n_matched:,} to a daily bar)")
    print(f"Control (unconditional, all in-band sessions): n={control[0]:,}  mean vol_ratio={control[1]}  median={control[2]}")
    print()
    print("By week before the breakout (offset in trading sessions, 0 = breakout day):")
    print(f"  {'week':>6} {'offset range':>14} {'n':>8} {'mean vr':>9} {'median vr':>10}")
    for wk, lo, hi, mean_vr, median_vr in weekly:
        print(f"  {int(wk)+1:>6} {f'{lo}..{hi}':>14} {'':>8} {mean_vr:>9} {median_vr:>10}")

    print()
    print("Full daily detail (offset, n, mean vr, median vr, p75 vr):")
    for offset, n, mean_vr, median_vr, p75_vr in by_offset:
        print(f"  {offset:>4}  {n:>6}  {mean_vr:>8}  {median_vr:>9}  {p75_vr:>7}")

    OUT.mkdir(parents=True, exist_ok=True)
    ts = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    out_path = OUT / f"breakout_volume_runup_{ts}.csv"
    with open(out_path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["offset", "n", "mean_vol_ratio", "median_vol_ratio", "p75_vol_ratio"])
        w.writerows(by_offset)
    print(f"\nWritten: {out_path}")


if __name__ == "__main__":
    main()
