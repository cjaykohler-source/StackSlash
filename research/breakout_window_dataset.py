"""
Builds one wide, persisted feature table: every validated breakout event
(see breakout_events.py) x every trading session from --lookback sessions
before it through the event day itself (offset -45..0 by default).

This is the "as much data per instance as possible" resource -- built
once, read many times, so later analyses (volume run-up, filing timing,
dilution, technicals, whatever comes next) query one wide parquet instead
of each re-deriving its own slice of the warehouse. Nothing here is a
signal or a claim; it's raw and derived context, point-in-time throughout
(every rolling stat is "prior sessions only," never including the row's
own day, matching every other study in this project).

Columns, per (symbol, event_date, offset) row:
  Price/volume (raw and split-adjusted OHLCV, that day)
  Rolling, prior-session-only: adv20 (shares), dollar20, ret_1d/5d/20d
    (split-adjusted, artifact-guarded), dist_sma20/50/200, atr14_pct,
    pct_of_52w_high, hi252 (new 252-session high), gap_pct, spread_est
    (Abdi-Ranaldo, matching bigmove_study.py)
  vol_ratio_20d = that day's volume / adv20
  Filings: has_8k_since_prev, has_8k_202_since_prev (item 2.02, earnings),
    n_8k_items_since_prev -- "since the previous session," matching
    production's earnings_release window, not the 5-day window
    research-audit-plan.md F1 flagged as a mismatch in bigmove_study.py
  Corporate actions: in_reverse_split_window (ex-date within +/-30
    calendar days of this row's date, any direction)
  is_event_day (offset = 0), event_gain_pct (the validated event's own
    gain, repeated on every row of its window for convenience)

Reads a breakout_events.py output CSV so the event list stays pinned to a
specific validated run.

    research/.venv/bin/python research/breakout_window_dataset.py \\
        research/data/study_outputs/breakout_events_TIMESTAMP.csv [--lookback 45]
"""
import argparse
import csv
import datetime as dt
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent
WAREHOUSE = ROOT / "data" / "stackslash.duckdb"
EDGAR = ROOT / "data" / "edgar"
CA = ROOT / "data" / "corporate_actions"
OUT = ROOT / "data" / "study_outputs"
HORIZONS = (1, 5, 20)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("events_csv")
    ap.add_argument("--lookback", type=int, default=45, help="trading sessions before the event to include (plus the event day itself)")
    args = ap.parse_args()

    with open(args.events_csv) as fh:
        rows = list(csv.DictReader(fh))
    if not rows:
        raise SystemExit(f"No events in {args.events_csv}")
    events = [(r["symbol"], r["event_date"], float(r["gain_pct"])) for r in rows]
    symbols = sorted({s for s, _, _ in events})

    con = duckdb.connect(str(WAREHOUSE), read_only=True)
    con.execute("create temp table event_symbols (symbol varchar)")
    con.executemany("insert into event_symbols values (?)", [(s,) for s in symbols])

    con.execute("""
      create temp table events (symbol varchar, event_date date, event_gain_pct double)
    """)
    con.executemany("insert into events values (?, ?::date, ?)", events)

    print(f"Building daily feature history for {len(symbols):,} symbols with >=1 event...")

    # Full history, restricted to symbols that actually have an event --
    # rolling windows still need each symbol's own full prior history, but
    # there's no need to compute this for the other ~4,000 untouched
    # symbols in the warehouse.
    con.execute("""
      create temp table hist as
      select s.symbol, s.date,
             r.open as o_raw, r.high as h_raw, r.low as l_raw, r.close as c_raw, r.volume as v,
             s.open as o_adj, s.high as h_adj, s.low as l_adj, s.close as c_adj
      from sip_bars_daily_split s
      join sip_bars_daily_raw r using (symbol, date)
      join event_symbols using (symbol)
      where s.date >= date '2016-01-01'
      order by s.symbol, s.date
    """)

    # Rolling, prior-session-only stats. `rows between N preceding and 1
    # preceding` excludes the current row throughout -- the same
    # discipline bigmove_study.py's build_days() uses, just via SQL window
    # functions here instead of numpy since this only touches ~1,000
    # symbols' history, not the full warehouse.
    con.execute("""
      create temp table feat as
      select
        symbol, date, o_raw, h_raw, l_raw, c_raw, v, o_adj, h_adj, l_adj, c_adj,
        row_number() over w as rn,
        avg(v) over (w rows between 20 preceding and 1 preceding) as adv20,
        avg(c_raw * v) over (w rows between 20 preceding and 1 preceding) as dollar20,
        lag(c_adj, 1) over w as c_adj_1,
        lag(c_adj, 5) over w as c_adj_5,
        lag(c_adj, 20) over w as c_adj_20,
        avg(c_adj) over (w rows between 20 preceding and 1 preceding) as sma20,
        avg(c_adj) over (w rows between 50 preceding and 1 preceding) as sma50,
        avg(c_adj) over (w rows between 200 preceding and 1 preceding) as sma200,
        max(h_adj) over (w rows between 252 preceding and 1 preceding) as hi252_prior,
        (c_raw / nullif(lag(c_raw, 1) over w, 0)) as raw_daily_ratio,
        o_raw / nullif(lag(c_raw, 1) over w, 0) - 1 as gap_pct
      from hist
      window w as (partition by symbol order by date)
    """)

    # Abdi-Ranaldo spread estimate (matching bigmove_study.py exactly):
    # eta = mid log range, s^2 = 4 * E[(ln c - eta_t)(ln c - eta_t+1)],
    # averaged over the 20 sessions strictly before this row.
    con.execute("""
      create temp table feat2 as
      select f.*,
        ln(nullif(c_adj, 0)) as lc,
        (ln(nullif(h_adj, 0)) + ln(nullif(l_adj, 0))) / 2.0 as eta
      from feat f
    """)
    con.execute("""
      create temp table feat3 as
      select f2.*,
        4.0 * (lag(lc, 1) over w - lag(eta, 1) over w) * (lag(lc, 1) over w - lag(eta, 0) over w) as ar_term
      from feat2 f2
      window w as (partition by symbol order by date)
    """)
    con.execute("""
      create temp table feat4 as
      select *,
        sqrt(avg(greatest(ar_term, 0)) over (partition by symbol order by date rows between 20 preceding and 1 preceding)) as spread_est
      from feat3
    """)

    # ATR14 (prior-only, 14-session average true range as % of prior close).
    con.execute("""
      create temp table feat5 as
      select *,
        greatest(h_adj - l_adj, abs(h_adj - lag(c_adj, 1) over w), abs(l_adj - lag(c_adj, 1) over w)) as tr
      from feat4
      window w as (partition by symbol order by date)
    """)
    con.execute("""
      create temp table feat6 as
      select *,
        avg(tr) over (partition by symbol order by date rows between 15 preceding and 2 preceding) as atr14
      from feat5
    """)

    # EDGAR: any 8-K filed since the prior session, and specifically item
    # 2.02 (earnings) -- "since the previous session," matching
    # production's earnings_release window (filing_date in
    # (prev_session, this_session]), not the 5-day window
    # research-audit-plan.md F1 flagged in bigmove_study.py.
    e = str(EDGAR)
    con.execute(f"""
      create temp table ticker_cik as
      select ticker, min(cik) cik from (
        select ticker, cik from read_parquet('{e}/edgar_tickers.parquet')
        union select unnest(tickers) ticker, cik from read_parquet('{e}/edgar_companies.parquet')
      ) group by ticker
    """)
    con.execute(f"""
      create temp table filings_8k as
      select tc.ticker as symbol, fl.filing_date::date as fdate, fl.items
      from read_parquet('{e}/edgar_filings.parquet') fl
      join ticker_cik tc on tc.cik = fl.cik
      join event_symbols es on es.symbol = tc.ticker
      where fl.form = '8-K'
    """)

    # Corporate actions: in a reverse-split window (+/- 30 calendar days).
    con.execute(f"""
      create temp table rs_dates as
      select distinct symbol, ex_date::date as xdate
      from read_parquet('{CA}/*.parquet', union_by_name = true)
      where type = 'reverse_splits' and ex_date is not null and ex_date != ''
    """)

    con.execute(f"""
      create temp table windowed as
      select f.symbol, f.date, ev.event_date, ev.event_gain_pct,
             (f.rn - er.event_rn) as day_offset,
             f.o_raw, f.h_raw, f.l_raw, f.c_raw, f.v,
             f.o_adj, f.h_adj, f.l_adj, f.c_adj,
             f.adv20, f.dollar20,
             case when f.raw_daily_ratio between 0.1 and 10
                  then f.c_adj / nullif(f.c_adj_1, 0) - 1 end as ret_1d,
             (f.c_adj / nullif(f.c_adj_5, 0) - 1) as ret_5d,
             (f.c_adj / nullif(f.c_adj_20, 0) - 1) as ret_20d,
             (f.c_adj / nullif(f.sma20, 0) - 1) as dist_sma20,
             (f.c_adj / nullif(f.sma50, 0) - 1) as dist_sma50,
             (f.c_adj / nullif(f.sma200, 0) - 1) as dist_sma200,
             (f.atr14 / nullif(f.c_adj_1, 0)) as atr14_pct,
             (f.c_adj_1 / nullif(f.hi252_prior, 0)) as pct_of_52w_high,
             (f.c_adj > f.hi252_prior) as hi252,
             f.gap_pct,
             f.spread_est,
             (f.v::double / nullif(f.adv20, 0)) as vol_ratio_20d
      from events ev
      join feat6 f on f.symbol = ev.symbol
      join (select symbol, date, rn as event_rn from feat6) er
        on er.symbol = ev.symbol and er.date = ev.event_date
      where f.rn between er.event_rn - {args.lookback} and er.event_rn
    """)

    con.execute("""
      create temp table windowed2 as
      select w.*,
        coalesce(bool_or(fk.fdate > w.date - 1 and fk.fdate <= w.date), false) as has_8k_since_prev,
        coalesce(bool_or(fk.fdate > w.date - 1 and fk.fdate <= w.date
                          and regexp_matches(coalesce(fk.items, ''), '(^|,)2\\.02(,|$)')), false) as has_8k_202_since_prev,
        count(*) filter (where fk.fdate > w.date - 1 and fk.fdate <= w.date) as n_8k_since_prev
      from windowed w
      left join filings_8k fk on fk.symbol = w.symbol
        and fk.fdate between w.date - 7 and w.date
      group by all
    """)

    con.execute("""
      create temp table final as
      select w.*, exists(
        select 1 from rs_dates rs where rs.symbol = w.symbol
          and rs.xdate between w.date - interval '30 day' and w.date + interval '30 day'
      ) as in_reverse_split_window,
      (day_offset = 0) as is_event_day
      from windowed2 w
    """)

    n = con.execute("select count(*) from final").fetchone()[0]
    n_events_covered = con.execute("select count(distinct symbol || event_date::text) from final").fetchone()[0]

    OUT.mkdir(parents=True, exist_ok=True)
    ts = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    out_path = OUT / f"breakout_window_dataset_{ts}.parquet"
    con.execute(f"copy final to '{out_path}' (format parquet)")

    print(f"\n{n:,} rows, {n_events_covered:,} of {len(events):,} events covered (offset -{args.lookback}..0)")
    print(f"Written: {out_path}")
    cols = [r[0] for r in con.execute("describe final").fetchall()]
    print("Columns:", ", ".join(cols))


if __name__ == "__main__":
    main()
