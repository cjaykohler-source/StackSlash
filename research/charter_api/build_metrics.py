"""
Pre-compute Charter's cross-sectional table: one row per symbol-day (SIP,
2016+) with every daily metric the /daily endpoint derives, plus FORWARD
outcomes for "does X predict Y" work, and each symbol's exchange / fund flag.

  research/data/charter/daily_metrics/year=YYYY/*.parquet

Same definitions as server.daily_sql (one source of truth: the metric SQL is
imported from there), computed per symbol over its whole history, so rolling
metrics (SMA 200, 52-week range) are right from the first requested date.

FORWARD columns (prefixed fwd_; they use FUTURE bars -- outcomes, never
predictors): fwd_ret_1 / fwd_ret_5 / fwd_ret_20 (close to close),
fwd_max_5 (best high over the next 5 sessions vs today's close),
fwd_min_5 (worst low), fwd_hit30_5 (1 if fwd_max_5 >= +30%), and
fwd_gap_1 (next open vs today's close). Split/reorg artifacts (a >=10x or
<=0.1x day inside the window) make them NULL.

Rebuilt nightly by scripts/run-research-publish.sh; ~a few minutes.

    research/.venv/bin/python research/charter_api/build_metrics.py
"""
import shutil
import sys
import time
from pathlib import Path

import duckdb

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data"
WAREHOUSE = DATA / "stackslash.duckdb"
OUT = DATA / "charter" / "daily_metrics"
sys.path.insert(0, str(HERE))
from metrics import SMAS  # noqa: E402


def main():
    t0 = time.time()
    con = duckdb.connect()
    con.execute("set preserve_insertion_order = false")
    con.execute(f"attach '{WAREHOUSE}' as wh (read_only)")
    sma = ",\n".join(f"avg(close) over w_{k} sma{k}" for k in SMAS)
    windows = ",\n".join(f"w_{k} as (partition by symbol order by date rows between {k - 1} preceding and current row)" for k in SMAS)
    derived = ",\n".join(
        f"close / sma{k} - 1 dist_sma{k}, sma{k} / lag(sma{k}, 5) over (partition by symbol order by date) - 1 slope_sma{k}"
        for k in SMAS)
    tmp = OUT.with_name("daily_metrics.building")
    if tmp.exists():
        shutil.rmtree(tmp)
    con.execute(f"""
      copy (
        with meta as (
          select bar_symbol as symbol, any_value(exchange) as exchange, any_value(name) as name from wh.sip_symbol_map group by 1
        ),
        b as (
          select r.symbol, r.date, s.open, s.high, s.low, s.close, r.close raw_close, r.volume, r.trade_count,
                 r.vwap * s.close / nullif(r.close, 0) vwap, s.close / nullif(r.close, 0) split_factor
          from wh.sip_bars_daily_raw r join wh.sip_bars_daily_split s using (symbol, date)
          where not (r.volume <= 0 and r.open = r.high and r.high = r.low and r.low = r.close)
        ),
        w as (
          select *,
            raw_close * volume dollar_volume,
            avg(raw_close * volume) over (partition by symbol order by date rows between 19 preceding and current row) dollar20,
            volume / nullif(avg(volume) over (partition by symbol order by date rows between 20 preceding and 1 preceding), 0) vol_ratio,
            volume / nullif(trade_count, 0) avg_trade_size,
            close / lag(close) over p - 1 ret_1,
            open / lag(close) over p - 1 gap,
            close / nullif(open, 0) - 1 body,
            close / lag(close, 5) over p - 1 ret_5,
            close / lag(close, 20) over p - 1 ret_20,
            (high - low) / lag(close) over p range_pct,
            greatest(high - low, abs(high - lag(close) over p), abs(low - lag(close) over p)) tr,
            case when high > low then (close - low) / (high - low) else 0.5 end clv,
            close / nullif(vwap, 0) - 1 close_vs_vwap,
            close / max(high) over (partition by symbol order by date rows between 251 preceding and current row) pct_52w_high,
            close / min(low) over (partition by symbol order by date rows between 251 preceding and current row) pct_52w_low,
            close / lag(close) over p ratio,
            {sma}
          from b
          window p as (partition by symbol order by date), {windows}
        ),
        f as (
          select *,
            avg(tr) over (partition by symbol order by date rows between 13 preceding and current row) / close atr14_pct,
            {derived},
            lead(close, 1) over p / close - 1 fwd_ret_1,
            lead(close, 5) over p / close - 1 fwd_ret_5,
            lead(close, 20) over p / close - 1 fwd_ret_20,
            lead(open, 1) over p / close - 1 fwd_gap_1,
            max(high) over (partition by symbol order by date rows between 1 following and 5 following) / close - 1 fwd_max_5,
            min(low) over (partition by symbol order by date rows between 1 following and 5 following) / close - 1 fwd_min_5,
            count(*) over (partition by symbol order by date rows between 1 following and 5 following) fwd_n5,
            max(ratio) over (partition by symbol order by date rows between 1 following and 20 following) fwd_rmax,
            min(ratio) over (partition by symbol order by date rows between 1 following and 20 following) fwd_rmin
          from w
          window p as (partition by symbol order by date)
        )
        select f.symbol, f.date, extract(year from f.date)::int as year,
          m.exchange, m.name,
          (m.exchange = 'ARCA' or regexp_matches(coalesce(m.name, ''), '\\b(ETF|ETN|FUND|TRUST|SHARES)\\b', 'i')) as is_fund,
          open, high, low, close, raw_close, vwap, volume, trade_count, dollar_volume, dollar20, vol_ratio, avg_trade_size,
          ret_1, gap, body, ret_5, ret_20, range_pct, atr14_pct, clv, close_vs_vwap, pct_52w_high, pct_52w_low,
          {", ".join(f"sma{k}" for k in SMAS)}, {", ".join(f"dist_sma{k}, slope_sma{k}" for k in SMAS)}, split_factor,
          case when fwd_rmax < 10 and fwd_rmin > 0.1 then fwd_ret_1 end fwd_ret_1,
          case when fwd_rmax < 10 and fwd_rmin > 0.1 then fwd_ret_5 end fwd_ret_5,
          case when fwd_rmax < 10 and fwd_rmin > 0.1 then fwd_ret_20 end fwd_ret_20,
          case when fwd_rmax < 10 and fwd_rmin > 0.1 then fwd_gap_1 end fwd_gap_1,
          case when fwd_n5 = 5 and fwd_rmax < 10 and fwd_rmin > 0.1 then fwd_max_5 end fwd_max_5,
          case when fwd_n5 = 5 and fwd_rmax < 10 and fwd_rmin > 0.1 then fwd_min_5 end fwd_min_5,
          case when fwd_n5 = 5 and fwd_rmax < 10 and fwd_rmin > 0.1 then (fwd_max_5 >= 0.30)::int end fwd_hit30_5
        from f left join meta m using (symbol)
        where f.date >= date '2016-01-01'
      ) to '{tmp}' (format parquet, partition_by (year), compression zstd)
    """)
    if OUT.exists():
        shutil.rmtree(OUT)
    tmp.rename(OUT)
    n = con.execute(f"select count(*), count(distinct symbol) from read_parquet('{OUT}/*/*.parquet')").fetchone()
    size = sum(p.stat().st_size for p in OUT.rglob("*.parquet")) / 1e9
    print(f"daily_metrics: {n[0]:,} symbol-days, {n[1]:,} symbols, {size:.2f} GB, {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
