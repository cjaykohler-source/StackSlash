#!/usr/bin/env python
"""
Schema lab: define an intraday pattern ("schema") over SIP minute bars and
backtest it on seeded random samples of symbol-sessions, in escalating
tiers, with every run retained.

THE LOOP
    2,500 sessions -> promising? -> 50,000 fresh sessions -> 250,000 ->
    1,000,000 -> a full year -> (once, at the end) the sealed holdout.

WHAT KEEPS IT HONEST
- Point in time. Every input field at minute t uses only bars at or
  before t, plus prior sessions' daily bars. The entry is the NEXT bar's
  open, never the signal bar's close.
- Disjoint tiers. The session pool is ordered by md5(symbol|date|seed);
  each tier of a lineage (schema name + seed) takes the next slice after
  the previous tiers, so a larger tier never re-counts sessions a smaller
  one already saw. Ordering is over the full daily-bar pool, so it doesn't
  shift as the minute pull fills in; sessions without minute data yet are
  dropped and counted, never silently substituted.
- Sealed holdout. Iteration runs on 2016-2021 ("discovery"). The 2022+
  holdout needs --holdout and is refused a second time for the same schema
  version unless --force. "all" includes the holdout and is treated the
  same way.
- A control. Each sampled session also gets one random-minute entry in
  the same window, scored identically. A schema has to beat both zero and
  that control, net of costs.
- Tails and uncertainty. Every horizon reports median, mean excluding the
  top 1%, per-year means, and a bootstrap 90% interval. "Promising" means
  the interval's lower bound is above zero AND above the control's mean.

Usage:
    research/.venv/bin/python research/schema_lab.py --list-fields
    research/.venv/bin/python research/schema_lab.py run research/schemas/example_gap_vwap.json --tier 2500 --seed 7
    research/.venv/bin/python research/schema_lab.py run SCHEMA --tier 50000 --seed 7      # next disjoint slice
    research/.venv/bin/python research/schema_lab.py run SCHEMA --tier year:2019 --seed 7
    research/.venv/bin/python research/schema_lab.py run SCHEMA --tier 2500 --holdout      # one-shot
    research/.venv/bin/python research/schema_lab.py runs                                  # history
    research/.venv/bin/python research/schema_lab.py report RUN_ID
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import numpy as np

REPO = Path(__file__).resolve().parent.parent
DATA = REPO / "research" / "data"
WAREHOUSE = DATA / "stackslash.duckdb"
MINUTE_LOG = DATA / "minute_log.duckdb"
MINUTE_DIR = DATA / "minute"
RUNS_DB = DATA / "schema_runs.duckdb"
RUNS_DIR = DATA / "schema_runs"

DISCOVERY_END = "2022-01-01"  # sessions before this are for iteration
TIERS = {"2500": 2_500, "50000": 50_000, "250000": 250_000, "1000000": 1_000_000}
CHUNK = 2_500
LISTED = ("NYSE", "NASDAQ", "AMEX", "ARCA", "BATS")

# --------------------------------------------------------------------------
# Field catalog. Every field is point-in-time for a decision at minute t.
# --------------------------------------------------------------------------
FIELDS = {
    # daily context (from prior sessions; gap uses today's open, known at 09:30)
    "gap_pct": "today's open vs prior close (split-adjusted)",
    "prior_ret_1d": "prior session's close-to-close return",
    "prior_ret_5d": "return over the 5 sessions before today",
    "prior_ret_20d": "return over the 20 sessions before today",
    "prior_vol20": "stdev of daily returns, prior 20 sessions",
    "atr14_pct": "14-session average true range / prior close",
    "adv20_shares": "average daily volume (raw shares), prior 20 sessions",
    "adv20_dollar": "average daily dollar volume (raw), prior 20 sessions",
    "prior_rvol": "prior session's volume / adv20",
    "dist_sma20": "prior close vs 20-session SMA",
    "dist_sma50": "prior close vs 50-session SMA",
    "dist_sma200": "prior close vs 200-session SMA",
    "pct_of_52w_high": "prior close / 252-session high",
    "prior_range_pct": "prior session high/low - 1",
    "prior_close_loc": "where the prior close sat in its range (0 = low, 1 = high)",
    "prior_up_days_5": "up closes among the prior 5 sessions",
    "prev_close_raw": "prior close, as traded (use for price bands)",
    "sessions_listed": "sessions of history before today",
    # regime
    "spy_prior_ret_1d": "SPY prior session return",
    "spy_prior_ret_5d": "SPY return over prior 5 sessions",
    "spy_above_sma200": "1 if SPY's prior close is above its 200-session SMA",
    # pre-market (04:00-09:30 ET, fully known at the open)
    "pm_volume": "pre-market shares traded",
    "pm_dollar_vol": "pre-market dollar volume",
    "pm_ret": "last pre-market price vs prior close",
    "pm_range_pct": "pre-market high/low - 1",
    "pm_vol_vs_adv20": "pre-market volume / adv20_shares",
    "above_pm_high": "1 if the current close is above the pre-market high",
    # intraday at minute t (regular session)
    "minutes_since_open": "minutes since 09:30 ET",
    "session_ret": "current close vs today's first regular-session open",
    "ret_from_prev_close": "current close vs prior close (raw)",
    "ret_1m": "close vs earliest close within the last 1 minute",
    "ret_5m": "close vs earliest close within the last 5 minutes",
    "ret_15m": "close vs earliest close within the last 15 minutes",
    "ret_30m": "close vs earliest close within the last 30 minutes",
    "ret_60m": "close vs earliest close within the last 60 minutes",
    "vwap": "session VWAP so far",
    "dist_vwap": "close vs session VWAP",
    "cum_volume": "shares traded so far this session",
    "cum_dollar_vol": "dollar volume so far this session",
    "cum_vol_vs_adv20": "shares so far / adv20_shares",
    "bar_vol_spike": "this bar's volume / mean bar volume over the prior 20 minutes",
    "pct_off_hod": "close vs high of day so far",
    "pct_off_lod": "close vs low of day so far",
    "day_range_vs_atr": "(high/low of day so far - 1) / atr14_pct",
    "or5_dist": "close vs the first-5-minute high (null before 09:35)",
    "or15_dist": "close vs the first-15-minute high (null before 09:45)",
    "or30_dist": "close vs the first-30-minute high (null before 10:00)",
    "new_hod_count": "bars so far that set a new high of day",
    "mins_since_hod": "minutes since the high of day was set",
    "minute_vol_15": "stdev of 1-bar log returns over the last 15 bars",
    "green_streak": "consecutive bars closing at or above their open",
    "red_streak": "consecutive bars closing below their open",
    "trades_per_min": "trades so far / minutes since open",
    "traded_minute_share": "fraction of minutes so far that had a trade",
    "close": "current bar close (raw)",
    "open": "current bar open (raw)",
    "high": "current bar high (raw)",
    "low": "current bar low (raw)",
    "volume": "current bar volume",
}

OPS = {">": ">", ">=": ">=", "<": "<", "<=": "<=", "==": "=", "!=": "<>"}


# --------------------------------------------------------------------------
# Schema handling
# --------------------------------------------------------------------------
def load_schema(path: str) -> dict:
    schema = json.loads(Path(path).read_text())
    for c in schema.get("entry", {}).get("all", []):
        for key in ("field", "field2"):
            if key in c and c[key] not in FIELDS:
                sys.exit(f"Unknown field '{c[key]}' — run --list-fields")
        if c["op"] not in OPS and c["op"] not in ("between", "in"):
            sys.exit(f"Unknown op '{c['op']}'")
    return schema


def schema_hash(schema: dict) -> str:
    """Versions a schema by its rules (not its name or notes)."""
    core = {k: schema.get(k) for k in ("universe", "window", "entry", "first_match_only", "exit", "cost")}
    return hashlib.sha256(json.dumps(core, sort_keys=True).encode()).hexdigest()[:12]


def condition_sql(c: dict) -> str:
    f = c["field"]
    if c["op"] == "between":
        lo, hi = c["value"]
        return f"({f} between {float(lo)} and {float(hi)})"
    if c["op"] == "in":
        return f"({f} in ({', '.join(repr(v) for v in c['value'])}))"
    rhs = c["field2"] if "field2" in c else repr(float(c["value"]))
    if "field2" in c and "mult" in c:
        rhs = f"({rhs} * {float(c['mult'])})"
    return f"({f} {OPS[c['op']]} {rhs})"


def hhmm_to_mod(s: str) -> int:
    h, m = s.split(":")
    return int(h) * 60 + int(m) - 570


# --------------------------------------------------------------------------
# Session pool and sampling
# --------------------------------------------------------------------------
def pool_sql(u: dict, period: str) -> str:
    """Eligible (symbol, date) sessions from daily bars — point-in-time filters only."""
    date_filter = {
        "discovery": f"date < date '{DISCOVERY_END}'",
        "holdout": f"date >= date '{DISCOVERY_END}'",
        "all": "true",
    }[period]
    ex = u.get("exchanges", list(LISTED))
    status = "" if u.get("include_delisted", True) else "and status = 'active'"
    return f"""
      with syms as (
        select distinct bar_symbol as symbol from wh.sip_symbol_map
        where exchange in ({', '.join(repr(e) for e in ex)}) {status}
      ),
      d as (
        select r.symbol, r.date, r.open, r.close, r.volume,
               lag(r.close) over w as prev_close_raw,
               lag(r.date) over w as prev_date,
               avg(r.close * r.volume) over (partition by r.symbol order by r.date rows between 20 preceding and 1 preceding) as adv20_dollar
        from wh.sip_bars_daily_raw r join syms using (symbol)
        window w as (partition by r.symbol order by r.date)
      )
      select symbol, date from d
      where {date_filter}
        and prev_close_raw between {float(u.get('price_min', 0.10))} and {float(u.get('price_max', 5.00))}
        and adv20_dollar >= {float(u.get('min_dollar_vol_20d', 50_000))}
        and date_diff('day', prev_date, date) <= 7
    """


def sample_sessions(con, schema: dict, period: str, tier: str, seed: int, offset: int) -> tuple[int, int]:
    """Materialise temp table `sampled(symbol, date, sample_rank)`; return (requested, pool_size)."""
    con.execute(f"create or replace temp table pool as {pool_sql(schema.get('universe', {}), period)}")
    pool_n = con.execute("select count(*) from pool").fetchone()[0]
    order = f"md5(symbol || '|' || date::varchar || '|{seed}')"
    if tier.startswith("year:"):
        year = int(tier.split(":")[1])
        con.execute(
            f"""create or replace temp table sampled as
                select symbol, date, row_number() over (order by {order}) - 1 as sample_rank
                from pool where year(date) = {year}"""
        )
    elif tier == "all":
        con.execute(
            f"create or replace temp table sampled as select symbol, date, row_number() over (order by {order}) - 1 as sample_rank from pool"
        )
    else:
        n = TIERS.get(tier) or int(tier)
        con.execute(
            f"""create or replace temp table sampled as
                select symbol, date, sample_rank from (
                  select symbol, date, row_number() over (order by {order}) - 1 as sample_rank from pool
                ) where sample_rank >= {offset} and sample_rank < {offset + n}"""
        )
    return con.execute("select count(*) from sampled").fetchone()[0], pool_n


def loaded_minute_months(con) -> None:
    """
    Temp table of (symbol, month) whose minute bars are on disk. Reads the
    exported plan plus the Parquet files present, not minute_log.duckdb,
    which the running loader holds locked. A unit's file only appears after
    its write-then-rename completes, so presence means loaded.
    """
    if not PLAN_PARQUET.exists():
        sys.exit(f"No {PLAN_PARQUET} — start load_minute_bars.py once to export its plan.")
    loaded = [p.stem for p in MINUTE_DIR.glob("year=*/month=*/*.parquet")]
    con.execute("create or replace temp table loaded_units (unit_id varchar)")
    if loaded:
        con.executemany("insert into loaded_units values (?)", [(u,) for u in loaded])
    con.execute(
        f"""create or replace temp table minute_loaded as
            select distinct unnest(string_split(u.symbols, ',')) as symbol, u.month
            from read_parquet('{PLAN_PARQUET}') u join loaded_units using (unit_id)"""
    )


# --------------------------------------------------------------------------
# Features
# --------------------------------------------------------------------------
DAILY_SQL = """
create or replace temp table dc as
with syms as (select distinct symbol from chunk union select 'SPY'),
s as (
  select s.symbol, s.date, s.open, s.high, s.low, s.close, s.volume, r.close as raw_close, r.volume as raw_volume
  from wh.sip_bars_daily_split s join wh.sip_bars_daily_raw r using (symbol, date)
  where s.symbol in (select symbol from syms)
),
a as (
  select *,
    lag(date) over w as pd, lag(close) over w as pc, lag(high) over w as ph, lag(low) over w as pl,
    lag(close, 2) over w as pc2, lag(close, 6) over w as pc6, lag(close, 21) over w as pc21,
    lag(raw_close) over w as prev_close_raw, lag(raw_volume) over w as prev_raw_volume,
    greatest(high - low, abs(high - lag(close) over w), abs(low - lag(close) over w)) as tr,
    close / nullif(lag(close) over w, 0) - 1 as dret,
    case when close > lag(close) over w then 1 else 0 end as up,
    row_number() over w - 1 as sessions_listed
  from s window w as (partition by symbol order by date)
),
b as (
  select *,
    avg(tr) over (partition by symbol order by date rows between 14 preceding and 1 preceding) as atr14,
    stddev_samp(dret) over (partition by symbol order by date rows between 20 preceding and 1 preceding) as prior_vol20,
    avg(raw_volume) over (partition by symbol order by date rows between 20 preceding and 1 preceding) as adv20_shares,
    avg(raw_close * raw_volume) over (partition by symbol order by date rows between 20 preceding and 1 preceding) as adv20_dollar,
    avg(close) over (partition by symbol order by date rows between 20 preceding and 1 preceding) as sma20,
    avg(close) over (partition by symbol order by date rows between 50 preceding and 1 preceding) as sma50,
    avg(close) over (partition by symbol order by date rows between 200 preceding and 1 preceding) as sma200,
    max(high) over (partition by symbol order by date rows between 252 preceding and 1 preceding) as hi252,
    sum(up) over (partition by symbol order by date rows between 5 preceding and 1 preceding) as prior_up_days_5,
    lead(close) over (partition by symbol order by date) as next_close,
    lead(open) over (partition by symbol order by date) as next_open
  from a
)
select symbol, date, sessions_listed, prev_close_raw, close as close_split, raw_close, next_close, next_open,
  open / nullif(pc, 0) - 1 as gap_pct,
  pc / nullif(pc2, 0) - 1 as prior_ret_1d,
  pc / nullif(pc6, 0) - 1 as prior_ret_5d,
  pc / nullif(pc21, 0) - 1 as prior_ret_20d,
  prior_vol20, atr14 / nullif(pc, 0) as atr14_pct, adv20_shares, adv20_dollar,
  prev_raw_volume / nullif(adv20_shares, 0) as prior_rvol,
  pc / nullif(sma20, 0) - 1 as dist_sma20, pc / nullif(sma50, 0) - 1 as dist_sma50, pc / nullif(sma200, 0) - 1 as dist_sma200,
  pc / nullif(hi252, 0) as pct_of_52w_high,
  ph / nullif(pl, 0) - 1 as prior_range_pct,
  (pc - pl) / nullif(ph - pl, 0) as prior_close_loc,
  prior_up_days_5,
  case when pc > sma200 then 1 else 0 end as above_sma200,
  date_diff('day', pd, date) as gap_days
from b
where (symbol, date) in (select symbol, date from chunk) or symbol = 'SPY'
"""

BARS_SQL = """
create or replace temp table bars as
select m.symbol, m.ts, (m.ts at time zone 'America/New_York') as ts_et,
       (m.ts at time zone 'America/New_York')::date as d,
       (extract('hour' from (m.ts at time zone 'America/New_York')) * 60
        + extract('minute' from (m.ts at time zone 'America/New_York')) - 570)::integer as mod,
       m.open, m.high, m.low, m.close, m.volume, coalesce(m.trade_count, 0) as trade_count,
       coalesce(m.vwap, m.close) as bar_vwap
from read_parquet({files}) m
join chunk c on c.symbol = m.symbol and c.date = (m.ts at time zone 'America/New_York')::date
"""

FEAT_SQL = """
create or replace temp table feat as
with pm as (
  select symbol, d, sum(volume) as pm_volume, sum(volume * bar_vwap) as pm_dollar_vol,
         max(high) as pm_high, min(low) as pm_low, arg_max(close, ts) as pm_last
  from bars where mod < 0 group by 1, 2
),
reg as (select * from bars where mod between 0 and 389),
w1 as (
  select reg.*,
    first_value(open) over wc as sess_open,
    sum(volume) over wc as cum_volume,
    sum(volume * bar_vwap) over wc as cum_dollar_vol,
    max(high) over wc as hod, min(low) over wc as lod,
    max(high) over wp as prev_hod,
    count(*) over wc as bars_so_far,
    sum(trade_count) over wc as cum_trades,
    first_value(close) over (partition by symbol, d order by ts range between interval 1 minute preceding and current row) as c1,
    first_value(close) over (partition by symbol, d order by ts range between interval 5 minute preceding and current row) as c5,
    first_value(close) over (partition by symbol, d order by ts range between interval 15 minute preceding and current row) as c15,
    first_value(close) over (partition by symbol, d order by ts range between interval 30 minute preceding and current row) as c30,
    first_value(close) over (partition by symbol, d order by ts range between interval 60 minute preceding and current row) as c60,
    avg(volume) over (partition by symbol, d order by ts range between interval 20 minute preceding and interval 1 minute preceding) as avg_vol_20m,
    max(case when mod < 5 then high end) over wc as or5_hi,
    max(case when mod < 15 then high end) over wc as or15_hi,
    max(case when mod < 30 then high end) over wc as or30_hi,
    arg_max(mod, high) over wc as mod_of_hod,
    ln(close / nullif(lag(close) over (partition by symbol, d order by ts), 0)) as r1,
    sum(case when close < open then 1 else 0 end) over wc as red_grp,
    sum(case when close >= open then 1 else 0 end) over wc as green_grp
  from reg
  window wc as (partition by symbol, d order by ts rows between unbounded preceding and current row),
         wp as (partition by symbol, d order by ts rows between unbounded preceding and 1 preceding)
),
w2 as (
  select *,
    sum(case when prev_hod is null or high > prev_hod then 1 else 0 end)
      over (partition by symbol, d order by ts rows between unbounded preceding and current row) as new_hod_count,
    stddev_samp(r1) over (partition by symbol, d order by ts rows between 14 preceding and current row) as minute_vol_15,
    row_number() over (partition by symbol, d, red_grp order by ts) - case when red_grp > 0 then 1 else 0 end as green_streak,
    row_number() over (partition by symbol, d, green_grp order by ts) - case when green_grp > 0 then 1 else 0 end as red_streak
  from w1
)
select w2.symbol, w2.d, w2.ts, w2.mod,
  w2.open, w2.high, w2.low, w2.close, w2.volume,
  w2.mod as minutes_since_open,
  w2.close / nullif(w2.sess_open, 0) - 1 as session_ret,
  w2.close / nullif(dc.prev_close_raw, 0) - 1 as ret_from_prev_close,
  w2.close / nullif(w2.c1, 0) - 1 as ret_1m, w2.close / nullif(w2.c5, 0) - 1 as ret_5m,
  w2.close / nullif(w2.c15, 0) - 1 as ret_15m, w2.close / nullif(w2.c30, 0) - 1 as ret_30m,
  w2.close / nullif(w2.c60, 0) - 1 as ret_60m,
  w2.cum_dollar_vol / nullif(w2.cum_volume, 0) as vwap,
  w2.close / nullif(w2.cum_dollar_vol / nullif(w2.cum_volume, 0), 0) - 1 as dist_vwap,
  w2.cum_volume, w2.cum_dollar_vol,
  w2.cum_volume / nullif(dc.adv20_shares, 0) as cum_vol_vs_adv20,
  w2.volume / nullif(w2.avg_vol_20m, 0) as bar_vol_spike,
  w2.close / nullif(w2.hod, 0) - 1 as pct_off_hod,
  w2.close / nullif(w2.lod, 0) - 1 as pct_off_lod,
  (w2.hod / nullif(w2.lod, 0) - 1) / nullif(dc.atr14_pct, 0) as day_range_vs_atr,
  case when w2.mod >= 5 then w2.close / nullif(w2.or5_hi, 0) - 1 end as or5_dist,
  case when w2.mod >= 15 then w2.close / nullif(w2.or15_hi, 0) - 1 end as or15_dist,
  case when w2.mod >= 30 then w2.close / nullif(w2.or30_hi, 0) - 1 end as or30_dist,
  w2.new_hod_count, w2.mod - w2.mod_of_hod as mins_since_hod, w2.minute_vol_15,
  case when w2.close >= w2.open then w2.green_streak else 0 end as green_streak,
  case when w2.close < w2.open then w2.red_streak else 0 end as red_streak,
  w2.cum_trades / (w2.mod + 1.0) as trades_per_min,
  w2.bars_so_far / (w2.mod + 1.0) as traded_minute_share,
  pm.pm_volume, pm.pm_dollar_vol,
  pm.pm_last / nullif(dc.prev_close_raw, 0) - 1 as pm_ret,
  pm.pm_high / nullif(pm.pm_low, 0) - 1 as pm_range_pct,
  pm.pm_volume / nullif(dc.adv20_shares, 0) as pm_vol_vs_adv20,
  case when w2.close > pm.pm_high then 1 else 0 end as above_pm_high,
  dc.gap_pct, dc.prior_ret_1d, dc.prior_ret_5d, dc.prior_ret_20d, dc.prior_vol20, dc.atr14_pct,
  dc.adv20_shares, dc.adv20_dollar, dc.prior_rvol, dc.dist_sma20, dc.dist_sma50, dc.dist_sma200,
  dc.pct_of_52w_high, dc.prior_range_pct, dc.prior_close_loc, dc.prior_up_days_5,
  dc.prev_close_raw, dc.sessions_listed,
  spy.prior_ret_1d as spy_prior_ret_1d, spy.prior_ret_5d as spy_prior_ret_5d, spy.above_sma200 as spy_above_sma200
from w2
join dc on dc.symbol = w2.symbol and dc.date = w2.d
left join pm on pm.symbol = w2.symbol and pm.d = w2.d
left join dc spy on spy.symbol = 'SPY' and spy.date = w2.d
"""


# --------------------------------------------------------------------------
# Events, outcomes, costs
# --------------------------------------------------------------------------
def outcome_sql(source: str, schema: dict) -> str:
    """Score entries listed in temp table `source(symbol, d, ts)` -> per-entry outcomes."""
    ex = schema.get("exit", {})
    horizons = ex.get("horizons_min", [5, 15, 30, 60])
    cost = schema.get("cost", {})
    flat = float(cost.get("flat_pct", 0.01))
    stop = ex.get("stop_pct")
    target = ex.get("target_pct")
    h_cols = ",\n".join(
        f"""(select b.close from reg b where b.symbol = e.symbol and b.d = e.d and b.ts <= e.entry_ts + interval {int(h)} minute
             order by b.ts desc limit 1) / e.entry_price - 1 as ret_{int(h)}m"""
        for h in horizons
    )
    stop_target = ""
    if stop is not None or target is not None:
        s = f"e.entry_price * (1 - {float(stop)})" if stop is not None else "null"
        t = f"e.entry_price * (1 + {float(target)})" if target is not None else "null"
        # Same-bar stop and target: assume the stop hit first (conservative).
        stop_target = f""",
        (select case
                  when st.ts is not null and (tg.ts is null or st.ts <= tg.ts) then least(st.open, {s}) / e.entry_price - 1
                  when tg.ts is not null then greatest(tg.open, {t}) / e.entry_price - 1
                  else e.session_close / e.entry_price - 1 end
         from (select min(ts) as ts, arg_min(open, ts) as open from reg b where b.symbol = e.symbol and b.d = e.d and b.ts >= e.entry_ts and {s} is not null and b.low <= {s}) st,
              (select min(ts) as ts, arg_min(open, ts) as open from reg b where b.symbol = e.symbol and b.d = e.d and b.ts >= e.entry_ts and {t} is not null and b.high >= {t}) tg
        ) as ret_stop_target"""
    return f"""
      with reg as (select * from bars where mod between 0 and 389),
      nxt as (
        select symbol, d, ts, lead(ts) over w as entry_ts, lead(open) over w as entry_price
        from reg window w as (partition by symbol, d order by ts)
      ),
      closes as (select symbol, d, arg_max(close, ts) as session_close from reg group by 1, 2),
      e as (
        select s.symbol, s.d, s.ts as signal_ts, n.entry_ts, n.entry_price, c.session_close,
               dc.close_split, dc.raw_close, dc.next_close
        from {source} s
        join nxt n using (symbol, d, ts)
        join closes c using (symbol, d)
        join dc on dc.symbol = s.symbol and dc.date = s.d
        where n.entry_ts is not null and n.entry_price > 0
      )
      select e.symbol, e.d, e.signal_ts, e.entry_ts, e.entry_price,
        greatest((case when e.entry_price >= 1 then 0.01 else 0.0001 end) / e.entry_price, {flat}) as cost_pct,
        {h_cols},
        e.session_close / e.entry_price - 1 as ret_close,
        -- carry to the next session's close through the split-adjusted daily series
        (e.session_close / e.entry_price) * (e.next_close / nullif(e.close_split, 0)) - 1 as ret_next_close,
        (select max(b.high) from reg b where b.symbol = e.symbol and b.d = e.d and b.ts >= e.entry_ts) / e.entry_price - 1 as mfe_to_close,
        (select min(b.low) from reg b where b.symbol = e.symbol and b.d = e.d and b.ts >= e.entry_ts) / e.entry_price - 1 as mae_to_close
        {stop_target}
      from e
    """


def run_chunk(con, schema: dict, seed: int, files: list[str]) -> tuple[int, int]:
    """Features, schema events and control events for temp table `chunk`. Returns (sessions_with_bars, events)."""
    con.execute(DAILY_SQL)
    con.execute(BARS_SQL.format(files=files))
    with_bars = con.execute("select count(distinct (symbol, d)) from bars").fetchone()[0]
    if not with_bars:
        return 0, 0
    con.execute(FEAT_SQL)
    w = schema.get("window", {})
    lo, hi = hhmm_to_mod(w.get("start", "09:31")), hhmm_to_mod(w.get("end", "15:30"))
    conds = " and ".join(condition_sql(c) for c in schema["entry"]["all"]) or "true"
    first = schema.get("first_match_only", True)
    con.execute(
        f"""create or replace temp table matches as
            select symbol, d, {'min(ts)' if first else 'ts'} as ts from feat
            where mod between {lo} and {hi} and {conds}
            {'group by 1, 2' if first else ''}"""
    )
    # Control: one random in-window minute per session, seeded.
    con.execute(
        f"""create or replace temp table control as
            select symbol, d, arg_min(ts, md5(symbol || '|' || ts::varchar || '|{seed}')) as ts
            from feat where mod between {lo} and {hi} group by 1, 2"""
    )
    con.execute(f"create or replace temp table ev as {outcome_sql('matches', schema)}")
    con.execute(f"create or replace temp table ctl as {outcome_sql('control', schema)}")
    return with_bars, con.execute("select count(*) from ev").fetchone()[0]


# --------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------
def summarise(ev: dict, ctl: dict, seed: int) -> dict:
    rng = np.random.default_rng(seed)
    out = {}
    for col in [c for c in ev if c.startswith("ret_")]:
        x = np.asarray(ev[col], dtype=float) - np.asarray(ev["cost_pct"], dtype=float)
        x = x[~np.isnan(x)]
        c = np.asarray(ctl.get(col, []), dtype=float) - np.asarray(ctl.get("cost_pct", []), dtype=float)
        c = c[~np.isnan(c)]
        if len(x) == 0:
            out[col] = {"n": 0}
            continue
        boots = rng.choice(x, size=(1000, len(x)), replace=True).mean(axis=1) if len(x) > 1 else np.array([x.mean()])
        lo, hi = np.percentile(boots, [5, 95])
        top = np.quantile(x, 0.99)
        pos, neg = x[x > 0].sum(), -x[x < 0].sum()
        out[col] = {
            "n": int(len(x)),
            "mean_net": float(x.mean()),
            "median_net": float(np.median(x)),
            "win_rate": float((x > 0).mean()),
            "pf_net": float(pos / neg) if neg > 0 else None,
            "mean_excl_top1pct": float(x[x < top].mean()) if (x < top).any() else None,
            "ci90_mean": [float(lo), float(hi)],
            "control_mean_net": float(c.mean()) if len(c) else None,
            "control_n": int(len(c)),
            "promising": bool(lo > 0 and (len(c) == 0 or lo > c.mean())),
        }
    return out


def print_summary(summary: dict, meta: dict):
    print(
        f"\nRun {meta['run_id']}  schema={meta['schema_name']} v{meta['schema_hash']}  tier={meta['tier']}  "
        f"seed={meta['seed']}  period={meta['period']}"
    )
    print(
        f"  sessions sampled {meta['sessions_sampled']:,} | with minute data {meta['sessions_with_bars']:,} | "
        f"matched {meta['events']:,} ({meta['events'] / max(meta['sessions_with_bars'], 1) * 100:.2f}% of sessions)"
    )
    print(f"  {'horizon':<16}{'n':>8}{'mean net':>10}{'median':>9}{'win%':>7}{'PF':>7}{'ex top1%':>10}{'90% CI of mean':>22}{'control':>10}  promising")
    for col, s in summary.items():
        if not s.get("n"):
            print(f"  {col:<16}{0:>8}")
            continue
        pf = f"{s['pf_net']:.3f}" if s["pf_net"] is not None else "-"
        ex1 = f"{s['mean_excl_top1pct'] * 100:.2f}%" if s["mean_excl_top1pct"] is not None else "-"
        ctl = f"{s['control_mean_net'] * 100:.2f}%" if s["control_mean_net"] is not None else "-"
        print(
            f"  {col:<16}{s['n']:>8,}{s['mean_net'] * 100:>9.2f}%{s['median_net'] * 100:>8.2f}%{s['win_rate'] * 100:>6.1f}%"
            f"{pf:>7}{ex1:>10}   [{s['ci90_mean'][0] * 100:>6.2f}%, {s['ci90_mean'][1] * 100:>6.2f}%]{ctl:>10}  {'YES' if s['promising'] else 'no'}"
        )
    print("  All returns are net of costs. 'promising' = CI lower bound > 0 and > control mean.")


def per_year(run_dir: Path, con) -> None:
    files = str(run_dir / "events_*.parquet")
    rows = con.execute(
        f"""select year(d) y, count(*) n,
                   avg(ret_close - cost_pct) mean_close, median(ret_close - cost_pct) med_close
            from read_parquet('{files}') group by 1 order by 1"""
    ).fetchall()
    if rows:
        print("  per year (to close, net):  " + "  ".join(f"{y}: n={n:,} mean={m * 100:.2f}% med={md * 100:.2f}%" for y, n, m, md in rows))


# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------
def runs_con():
    DATA.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(RUNS_DB))
    con.execute(
        """create table if not exists runs (
             run_id varchar primary key, schema_name varchar, schema_hash varchar, schema_json varchar,
             seed integer, tier varchar, period varchar, sample_offset bigint, sessions_sampled bigint,
             pool_size bigint, sessions_with_bars bigint, events bigint, chunks_done integer, chunks_total integer,
             status varchar, summary_json varchar, created_at timestamptz, finished_at timestamptz)"""
    )
    return con


def cmd_run(args):
    schema = load_schema(args.schema)
    name, shash = schema.get("name", Path(args.schema).stem), schema_hash(schema)
    period = "holdout" if args.holdout else ("all" if args.tier == "all" else "discovery")
    rc = runs_con()

    if period in ("holdout", "all"):
        if not args.holdout:
            sys.exit("Tier 'all' includes the sealed 2022+ holdout — pass --holdout to confirm.")
        prior = rc.execute(
            "select run_id from runs where schema_hash = ? and period in ('holdout', 'all') and status = 'done'", [shash]
        ).fetchone()
        if prior and not args.force:
            sys.exit(f"Schema v{shash} already has a holdout run ({prior[0]}). The holdout is one-shot; --force to override.")

    # Disjoint tiers: continue after every sized tier this lineage already consumed.
    offset = 0
    if not args.tier.startswith("year:") and args.tier != "all":
        offset = rc.execute(
            "select coalesce(sum(sessions_sampled), 0) from runs where schema_name = ? and seed = ? and period = ? and tier not like 'year:%' and tier <> 'all'",
            [name, args.seed, period],
        ).fetchone()[0]

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    run_id = args.resume or f"{name}-{shash}-t{args.tier.replace(':', '')}-s{args.seed}-{stamp}"
    run_dir = RUNS_DIR / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    con = duckdb.connect()
    con.execute(f"attach '{WAREHOUSE}' as wh (read_only)")
    con.execute(f"attach '{MINUTE_LOG}' as ml (read_only)")
    con.execute("set preserve_insertion_order = false")
    if args.resume:
        row = rc.execute("select sample_offset from runs where run_id = ?", [run_id]).fetchone()
        if not row:
            sys.exit(f"No run {run_id} to resume")
        offset = row[0]

    sampled, pool_n = sample_sessions(con, schema, period, args.tier, args.seed, offset)
    loaded_minute_months(con)
    con.execute(
        """create or replace temp table sampled_ready as
           select s.* from sampled s join minute_loaded m
             on m.symbol = s.symbol and m.month = date_trunc('month', s.date)::date"""
    )
    ready = con.execute("select count(*) from sampled_ready").fetchone()[0]
    chunks_total = -(-ready // CHUNK) if ready else 0
    print(f"Pool {pool_n:,} sessions ({period}); tier {args.tier} from offset {offset:,}: {sampled:,} sampled, "
          f"{ready:,} have minute data loaded ({sampled - ready:,} not yet pulled — skipped, not substituted)")

    if not args.resume:
        rc.execute(
            "insert into runs values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, 'running', null, now(), null)",
            [run_id, name, shash, json.dumps(schema), args.seed, args.tier, period, offset, sampled, pool_n, chunks_total],
        )

    with_bars_total = events_total = 0
    for k in range(chunks_total):
        part = run_dir / f"events_{k:05d}.parquet"
        if part.exists() and (run_dir / f"control_{k:05d}.parquet").exists():
            continue  # resume: chunk already scored
        con.execute(
            f"create or replace temp table chunk as select symbol, date from sampled_ready order by sample_rank limit {CHUNK} offset {k * CHUNK}"
        )
        months = con.execute("select distinct year(date), month(date) from chunk").fetchall()
        files = [str(MINUTE_DIR / f"year={y}" / f"month={m:02d}" / "*.parquet") for y, m in months]
        files = [f for f in files if list(Path(f).parent.glob("*.parquet"))]
        if not files:
            continue
        wb, ne = run_chunk(con, schema, args.seed, files)
        con.execute(f"copy ev to '{part}' (format parquet)")
        con.execute(f"copy ctl to '{run_dir / f'control_{k:05d}.parquet'}' (format parquet)")
        with_bars_total += wb
        events_total += ne
        rc.execute("update runs set chunks_done = ?, sessions_with_bars = sessions_with_bars + ?, events = events + ? where run_id = ?",
                   [k + 1, wb, ne, run_id])
        print(f"  chunk {k + 1}/{chunks_total}: {wb:,} sessions with bars, {ne:,} matches", flush=True)

    finish(rc, con, run_id, run_dir, args.seed)


def finish(rc, con, run_id: str, run_dir: Path, seed: int):
    evf, ctf = list(run_dir.glob("events_*.parquet")), list(run_dir.glob("control_*.parquet"))
    ev = con.execute(f"select * from read_parquet('{run_dir}/events_*.parquet')").fetchnumpy() if evf else {}
    ct = con.execute(f"select * from read_parquet('{run_dir}/control_*.parquet')").fetchnumpy() if ctf else {}
    summary = summarise(ev, ct, seed) if ev else {}
    rc.execute("update runs set status = 'done', summary_json = ?, finished_at = now(), events = ? where run_id = ?",
               [json.dumps(summary), int(len(ev.get("symbol", []))) if ev else 0, run_id])
    row =rc.execute("select run_id, schema_name, schema_hash, tier, seed, period, sessions_sampled, sessions_with_bars, events from runs where run_id = ?", [run_id]).fetchone()
    meta = dict(zip(["run_id", "schema_name", "schema_hash", "tier", "seed", "period", "sessions_sampled", "sessions_with_bars", "events"], row))
    print_summary(summary, meta)
    if evf:
        per_year(run_dir, con)
    print(f"  retained: {run_dir}")


def cmd_runs(_args):
    rc = runs_con()
    for r in rc.execute(
        "select run_id, tier, period, sessions_sampled, sessions_with_bars, events, status, created_at from runs order by created_at"
    ).fetchall():
        print(f"{r[0]:<60} tier={r[1]:<10} {r[2]:<9} sampled={r[3]:>9,} with_bars={r[4]:>9,} events={r[5]:>8,} {r[6]:<8} {r[7]:%Y-%m-%d %H:%M}")


def cmd_report(args):
    rc = runs_con()
    row = rc.execute("select seed from runs where run_id = ?", [args.run_id]).fetchone()
    if not row:
        sys.exit(f"No run {args.run_id}")
    finish(rc, duckdb.connect(), args.run_id, RUNS_DIR / args.run_id, row[0])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list-fields", action="store_true")
    sub = ap.add_subparsers(dest="cmd")
    r = sub.add_parser("run")
    r.add_argument("schema")
    r.add_argument("--tier", default="2500", help="2500 | 50000 | 250000 | 1000000 | N | year:YYYY | all")
    r.add_argument("--seed", type=int, default=7)
    r.add_argument("--holdout", action="store_true", help="run on the sealed 2022+ holdout (one-shot)")
    r.add_argument("--force", action="store_true")
    r.add_argument("--resume", help="resume an interrupted run by run_id")
    sub.add_parser("runs")
    rp = sub.add_parser("report")
    rp.add_argument("run_id")
    args = ap.parse_args()

    if args.list_fields:
        width = max(map(len, FIELDS))
        for k, v in FIELDS.items():
            print(f"  {k:<{width}}  {v}")
        return
    {"run": cmd_run, "runs": cmd_runs, "report": cmd_report}.get(args.cmd, lambda _a: ap.print_help())(args)


if __name__ == "__main__":
    main()
