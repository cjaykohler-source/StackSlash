"""
Discovers and validates every instance of a >=75% single-session gain in
the $0.10-$5 band (SIP daily warehouse), 2016 onward.

Why this needs more than a one-line query: a naive close-to-close return
filter is dominated by data artifacts, not real breakouts. Diagnosed
2026-09-28 (see the research-chat record, not a standing doc): the top of
a naive list is things like GPOR 2021-05-18 (+52,648%, its Chapter 11
equity cancellation/reissuance, not a trade), LINE 2024-07-25 (+44,778%),
SD 2016-10-04 (+12,900%) -- and the local corporate_actions table (loaded
from Alpaca) does NOT catch these even with a +/-3 day window, despite its
own docstring claiming "worthless removals" / merger coverage. These
symbols share one property naive filters miss: near-zero or NULL trading
volume in the 20 sessions before the "gain" -- there was no real market
in the stock, so the print is a re-basing artifact, not a trade.

Guards, applied in order:
  1. Raw/split-adjusted agreement (--agreement-tol): rules out a silently
     un-adjusted or partially-adjusted split -- if the split-adjusted
     series shows a smaller/negative return than raw for the same day,
     that's the adjustment engine correctly neutralizing a real split.
  2. corporate_actions exclusion (any type, +/- --ca-window-days): the
     first line of defense, though it has real coverage gaps (see above)
     -- kept as a belt-and-suspenders check, not the primary guard.
  3. Liquidity/volume-surge floor (the guard that actually works):
     require >= --min-traded-days of the prior 20 sessions to have traded
     at all, and today's volume >= --vol-ratio-floor x the 20-day average.
     A genuine breakout comes with a volume surge; a reorg/delisting
     re-basing print typically does not.

None of this replaces manual spot-checking. Use --sample N to print a
random subset of the surviving list for a human news/filing check before
trusting it for anything downstream.

Universe: $0.10-$5 (raw close), >= 60 sessions of history, matching every
other study here.

    research/.venv/bin/python research/breakout_events.py [--min-gain 0.75]
"""
import argparse
import csv
import datetime as dt
import random
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent
WAREHOUSE = ROOT / "data" / "stackslash.duckdb"
CA = ROOT / "data" / "corporate_actions"
OUT = ROOT / "data" / "study_outputs"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-price", type=float, default=0.10)
    ap.add_argument("--max-price", type=float, default=5.00, help="upper price bound, prior day's raw close")
    ap.add_argument("--min-gain", type=float, default=0.75, help="minimum split-adjusted close-to-close return")
    ap.add_argument("--min-history", type=int, default=60, help="minimum in-band sessions for a symbol to qualify")
    ap.add_argument("--agreement-tol", type=float, default=0.05,
                    help="max relative difference allowed between raw and split-adjusted return")
    ap.add_argument("--ca-window-days", type=int, default=3, help="corporate_actions exclusion window, +/- days")
    ap.add_argument("--min-traded-days", type=int, default=15, help="of the prior 20 sessions, how many must have traded (volume > 0)")
    ap.add_argument("--vol-ratio-floor", type=float, default=2.0, help="today's volume / 20-day average volume, minimum")
    ap.add_argument("--sample", type=int, default=0, help="print a random sample of N surviving events for manual spot-check")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    con = duckdb.connect(str(WAREHOUSE), read_only=True)
    con.execute(f"""
      create temp table ca_ex_dates as
      select distinct symbol, ex_date::date as xdate
      from read_parquet('{CA}/*.parquet', union_by_name = true)
      where ex_date is not null and ex_date != ''
    """)

    con.execute(f"""
      create temp table band as
      select symbol from sip_bars_daily_raw
      where date >= date '2016-01-01' and close between {args.min_price} and {args.max_price}
      group by symbol having count(*) >= {args.min_history}
    """)

    con.execute(f"""
      create temp table d as
      select s.symbol, s.date, s.close as adj, r.close as raw, s.volume,
             lag(s.close) over w as prev_adj,
             lag(r.close) over w as prev_raw,
             avg(s.volume) over (partition by s.symbol order by s.date rows between 21 preceding and 1 preceding) as adv20,
             avg(r.close * s.volume) over (partition by s.symbol order by s.date rows between 21 preceding and 1 preceding) as dollar20,
             count(*) filter (where s.volume > 0) over (partition by s.symbol order by s.date rows between 21 preceding and 1 preceding) as traded_days_20
      from sip_bars_daily_split s
      join sip_bars_daily_raw r using (symbol, date)
      join band using (symbol)
      window w as (partition by s.symbol order by s.date)
    """)

    con.execute(f"""
      create temp table raw_candidates as
      select *, volume::double / nullif(adv20, 0) as vol_ratio,
             (adj/prev_adj - 1) as gain_pct
      from d
      where prev_adj between {args.min_price} and {args.max_price}
        and (adj/prev_adj - 1) >= {args.min_gain}
        and prev_raw > 0
        and abs((adj/prev_adj) - (raw/prev_raw)) / (adj/prev_adj) < {args.agreement_tol}
    """)

    n_raw = con.execute("select count(*) from raw_candidates").fetchone()[0]

    con.execute(f"""
      create temp table survivors as
      select rc.*
      from raw_candidates rc
      left join ca_ex_dates ca on ca.symbol = rc.symbol
        and ca.xdate between rc.date - interval '{args.ca_window_days} day' and rc.date + interval '{args.ca_window_days} day'
      where ca.symbol is null
        and rc.adv20 > 0
        and rc.traded_days_20 >= {args.min_traded_days}
        and rc.vol_ratio >= {args.vol_ratio_floor}
    """)

    con.execute(f"""
      create temp table rejected as
      select rc.*,
        case
          when ca.symbol is not null then 'corporate_action_nearby'
          when rc.adv20 is null or rc.adv20 <= 0 then 'no_prior_volume'
          when rc.traded_days_20 < {args.min_traded_days} then 'thin_prior_trading'
          when rc.vol_ratio < {args.vol_ratio_floor} then 'no_volume_surge'
        end as reason
      from raw_candidates rc
      left join ca_ex_dates ca on ca.symbol = rc.symbol
        and ca.xdate between rc.date - interval '{args.ca_window_days} day' and rc.date + interval '{args.ca_window_days} day'
      where not (
        ca.symbol is null
        and rc.adv20 > 0
        and rc.traded_days_20 >= {args.min_traded_days}
        and rc.vol_ratio >= {args.vol_ratio_floor}
      )
    """)

    summary = con.execute("""
      select
        count(*) n,
        count(*) filter (where extract(year from date) < 2022) n_1621,
        count(*) filter (where extract(year from date) >= 2022) n_22p,
        count(distinct symbol) n_symbols
      from survivors
    """).fetchone()

    rejected_by_reason = con.execute("select reason, count(*) from rejected group by reason order by 2 desc").fetchall()

    OUT.mkdir(parents=True, exist_ok=True)
    ts = dt.datetime.now().strftime("%Y%m%dT%H%M%S")

    events_path = OUT / f"breakout_events_{ts}.csv"
    rows = con.execute("""
      select symbol, date, round(gain_pct * 100, 1) as gain_pct,
             prev_raw, raw, volume, round(vol_ratio, 1) as vol_ratio,
             round(dollar20, 0) as dollar20
      from survivors
      order by date, symbol
    """).fetchall()
    with open(events_path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["symbol", "event_date", "gain_pct", "prev_close_raw", "close_raw", "volume", "vol_ratio_20d", "dollar_vol_20d"])
        w.writerows(rows)

    rejected_path = OUT / f"breakout_events_rejected_{ts}.csv"
    rrows = con.execute("""
      select symbol, date, round(gain_pct * 100, 1) as gain_pct, prev_raw, raw, volume, reason
      from rejected
      order by gain_pct desc
    """).fetchall()
    with open(rejected_path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["symbol", "event_date", "gain_pct", "prev_close_raw", "close_raw", "volume", "reason"])
        w.writerows(rrows)

    print(f"Raw candidates (gain + raw/adjusted agreement only): {n_raw:,}")
    print("Rejected, by reason:")
    for reason, n in rejected_by_reason:
        print(f"  {reason:<24} {n:>6,}")
    print(f"\nSurviving events: {summary[0]:,}  (2016-21: {summary[1]:,}, 2022+: {summary[2]:,})  across {summary[3]:,} symbols")
    print(f"\nWritten: {events_path}")
    print(f"Written: {rejected_path}")

    if args.sample:
        random.seed(args.seed)
        sample = random.sample(rows, min(args.sample, len(rows)))
        print(f"\nRandom sample of {len(sample)} surviving events (spot-check these against real news/filings):")
        for r in sample:
            print(f"  {r}")


if __name__ == "__main__":
    main()
