#!/usr/bin/env python
"""
Load consolidated-tape (SIP) minute bars — pre-market, regular and
after-hours — for every symbol that has SIP daily bars in the warehouse,
2016 onward, into monthly Parquet files the warehouse queries directly.

Built for completeness, not just volume: every symbol-session with a daily
bar is later reconciled against its minute bars (see --reconcile), so a
gap is either filled or explicitly accounted for, never silently absent.

Design choices, and why:
- RAW prices only. Split-adjusted minute prices are derivable from the
  ratio of sip_bars_daily_split to sip_bars_daily_raw on the same session,
  so pulling both would double the request budget for no new information.
- Work is planned once into `minute_units` (symbol batch x calendar month)
  from the daily bars' trade counts, then executed and logged per unit.
  A re-run resumes exactly where it stopped. The plan is persisted rather
  than recomputed so unit ids stay stable across runs.
- Sub-$5 band names (any raw close in $0.10-$5.00) are planned first.
- Production shares this Alpaca account's 200 req/min limit, and its
  intraday scans run during market hours. The limiter drops to
  MARKET_HOURS_RATE on weekdays 08:00-20:00 America/New_York and runs at
  OFF_HOURS_RATE otherwise, so this never starves live scans.
- The progress log lives in its own DuckDB file (minute_log.duckdb) so
  the main warehouse stays readable while a multi-day load runs.

A minute bar only exists for a minute in which something traded: a thin
name can have 20 bars in a session, a liquid one ~860. That is not a gap.

Usage:
    research/.venv/bin/python research/load_minute_bars.py --plan          # (re)build the unit plan
    research/.venv/bin/python research/load_minute_bars.py                 # run / resume
    research/.venv/bin/python research/load_minute_bars.py --max-units 20  # smoke test
    research/.venv/bin/python research/load_minute_bars.py --reconcile     # minute vs daily audit
"""

from __future__ import annotations

import argparse
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
import requests

REPO = Path(__file__).resolve().parent.parent
DATA = REPO / "research" / "data"
WAREHOUSE = DATA / "stackslash.duckdb"
LOG_DB = DATA / "minute_log.duckdb"
MINUTE_DIR = DATA / "minute"

BARS = "https://data.alpaca.markets/v2/stocks/bars"
PAGE_LIMIT = 10000
TARGET_BARS_PER_UNIT = 20000  # ~2 pages; packs many thin names per request
MAX_SYMBOLS_PER_UNIT = 200
MAX_BARS_PER_SESSION = 960  # 04:00-20:00 ET
MARKET_HOURS_RATE = 60
OFF_HOURS_RATE = 190
WORKERS = 4
ET = ZoneInfo("America/New_York")


def load_env() -> dict:
    env = {}
    for line in (REPO / ".env").read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def current_rate() -> int:
    now = datetime.now(ET)
    if now.weekday() < 5 and 8 <= now.hour < 20:
        return MARKET_HOURS_RATE
    return OFF_HOURS_RATE


class Limiter:
    """Shared across threads; the permitted rate is re-read on every call."""

    def __init__(self):
        self.lock = threading.Lock()
        self.next_at = time.monotonic()

    def wait(self):
        with self.lock:
            now = time.monotonic()
            if self.next_at > now:
                time.sleep(self.next_at - now)
            self.next_at = max(self.next_at, now) + 60.0 / current_rate()


class Alpaca:
    def __init__(self, key: str, secret: str):
        self.headers = {"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret}
        self.limiter = Limiter()
        self.local = threading.local()

    def get(self, params: dict) -> dict:
        if not hasattr(self.local, "s"):
            self.local.s = requests.Session()
            self.local.s.headers.update(self.headers)
        for attempt in range(8):
            self.limiter.wait()
            try:
                r = self.local.s.get(BARS, params=params, timeout=120)
            except requests.RequestException as e:
                time.sleep(min(60, 2**attempt))
                print(f"  network error ({e.__class__.__name__}), retrying", flush=True)
                continue
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(min(60, 2**attempt))
                print(f"  HTTP {r.status_code}, retrying", flush=True)
                continue
            r.raise_for_status()
            return r.json()
        raise RuntimeError(f"gave up after 8 attempts: {params.get('symbols', '')[:60]} {params.get('start')}")


def log_con():
    DATA.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(LOG_DB))
    con.execute(
        """create table if not exists minute_units (
             unit_id varchar primary key, month date, priority integer,
             symbols varchar, n_symbols integer, est_bars bigint)"""
    )
    con.execute(
        """create table if not exists minute_load_log (
             unit_id varchar primary key, bars bigint, symbols_with_bars integer,
             pages integer, rejected_symbols varchar, file varchar, loaded_at timestamptz)"""
    )
    return con


def plan(log):
    """Pack (symbol, month) work into units of ~TARGET_BARS_PER_UNIT expected bars."""
    wh = duckdb.connect(str(WAREHOUSE), read_only=True)
    rows = wh.execute(
        f"""
        with band as (
          select distinct symbol from sip_bars_daily_raw where close between 0.10 and 5.00
        )
        select date_trunc('month', d.date)::date as month, d.symbol,
               case when b.symbol is not null then 1 else 0 end as priority,
               sum(least(coalesce(d.trade_count, {MAX_BARS_PER_SESSION}), {MAX_BARS_PER_SESSION})) as est_bars
        from sip_bars_daily_raw d left join band b on b.symbol = d.symbol
        group by 1, 2, 3
        order by priority desc, month, symbol"""
    ).fetchall()
    wh.close()

    units, cur, cur_est, cur_key = [], [], 0, None
    for month, symbol, priority, est in rows:
        key = (month, priority)
        if cur and (key != cur_key or cur_est + est > TARGET_BARS_PER_UNIT or len(cur) >= MAX_SYMBOLS_PER_UNIT):
            units.append((cur_key, cur, cur_est))
            cur, cur_est = [], 0
        cur_key = key
        cur.append(symbol)
        cur_est += est
    if cur:
        units.append((cur_key, cur, cur_est))

    log.execute("delete from minute_units")
    batch = [
        (f"p{p}-{m:%Y%m}-{i:05d}", m, p, ",".join(syms), len(syms), est)
        for i, ((m, p), syms, est) in enumerate(units)
    ]
    log.executemany("insert into minute_units values (?, ?, ?, ?, ?, ?)", batch)
    n, est_total = log.execute("select count(*), sum(est_bars) from minute_units").fetchone()
    band_units = log.execute("select count(*) from minute_units where priority = 1").fetchone()[0]
    print(f"Planned {n:,} units ({band_units:,} band-first), ~{est_total/1e9:.2f}B bars expected (upper bound)")


def fetch_unit(api: Alpaca, symbols: list[str], month) -> tuple[list[dict], int, list[str]]:
    start = datetime(month.year, month.month, 1, tzinfo=timezone.utc)
    end = datetime(month.year + (month.month == 12), month.month % 12 + 1, 1, tzinfo=timezone.utc)
    end = min(end, datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0))

    def run(syms: list[str]) -> tuple[list[dict], int, list[str]]:
        out, pages, token = [], 0, None
        try:
            while True:
                p = {
                    "symbols": ",".join(syms), "timeframe": "1Min",
                    "start": start.isoformat().replace("+00:00", "Z"),
                    "end": end.isoformat().replace("+00:00", "Z"),
                    "limit": PAGE_LIMIT, "feed": "sip", "adjustment": "raw",
                }
                if token:
                    p["page_token"] = token
                body = api.get(p)
                pages += 1
                for sym, bars in (body.get("bars") or {}).items():
                    for b in bars:
                        out.append({
                            "symbol": sym,
                            "ts": datetime.fromisoformat(b["t"].replace("Z", "+00:00")),
                            "open": b["o"], "high": b["h"], "low": b["l"], "close": b["c"],
                            "volume": int(b["v"]), "trade_count": b.get("n"), "vwap": b.get("vw"),
                        })
                token = body.get("next_page_token")
                if not token:
                    return out, pages, []
        except requests.HTTPError as e:
            # One unacceptable symbol 400s the whole request: bisect to it.
            if e.response is None or e.response.status_code != 400:
                raise
            if len(syms) == 1:
                return [], pages + 1, syms
            mid = len(syms) // 2
            a = run(syms[:mid])
            b = run(syms[mid:])
            return a[0] + b[0], pages + a[1] + b[1], a[2] + b[2]

    return run(symbols)


SCHEMA = pa.schema([
    ("symbol", pa.string()), ("ts", pa.timestamp("us", tz="UTC")),
    ("open", pa.float64()), ("high", pa.float64()), ("low", pa.float64()), ("close", pa.float64()),
    ("volume", pa.int64()), ("trade_count", pa.int64()), ("vwap", pa.float64()),
])


def run_units(log, api: Alpaca, max_units: int | None):
    todo = log.execute(
        """select u.unit_id, u.month, u.symbols from minute_units u
           left join minute_load_log l using (unit_id)
           where l.unit_id is null order by u.priority desc, u.month, u.unit_id"""
    ).fetchall()
    total = log.execute("select count(*) from minute_units").fetchone()[0]
    already = total - len(todo)
    if max_units:
        todo = todo[:max_units]
    print(f"{already:,} of {total:,} units already loaded; running {len(todo):,}")
    if not todo:
        return

    # Submit in bounded windows: results are consumed in order, so an
    # unbounded submit would let finished units pile up in memory behind
    # one slow unit.
    WINDOW = 200
    t0, done_bars, n = time.time(), 0, 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
      for w in range(0, len(todo), WINDOW):
        window = todo[w : w + WINDOW]
        futures = [(uid, m, pool.submit(fetch_unit, api, syms.split(","), m)) for uid, m, syms in window]
        for uid, month, fut in futures:
            n += 1
            rows, pages, rejected = fut.result()
            path = None
            if rows:
                out_dir = MINUTE_DIR / f"year={month.year}" / f"month={month.month:02d}"
                out_dir.mkdir(parents=True, exist_ok=True)
                path = out_dir / f"{uid}.parquet"
                tmp = path.with_suffix(".parquet.tmp")
                # Write-then-rename: a crash never leaves a half file that
                # looks complete. The log row is what marks the unit done.
                pq.write_table(pa.Table.from_pylist(rows, schema=SCHEMA), tmp, compression="zstd")
                tmp.rename(path)
            log.execute(
                "insert or replace into minute_load_log values (?, ?, ?, ?, ?, ?, now())",
                [uid, len(rows), len({r["symbol"] for r in rows}), pages, ",".join(rejected) or None, str(path) if path else None],
            )
            done_bars += len(rows)
            if n % 50 == 0 or n == len(todo):
                el = time.time() - t0
                print(f"  {n:,}/{len(todo):,} units, {done_bars:,} bars, {el/60:.1f}m, ETA {el/n*(len(todo)-n)/3600:.1f}h, rate now {current_rate()}/min", flush=True)


def reconcile():
    """
    Compare each symbol-session's minute bars to its SIP daily bar. Writes
    minute_reconciliation to the log DB. Tolerances are reported as
    distributions first — the normal daily-vs-minute volume difference has
    to be measured before anything is called a gap.
    """
    con = duckdb.connect(str(LOG_DB))
    con.execute(f"attach '{WAREHOUSE}' as wh (read_only)")
    files = str(MINUTE_DIR / "**" / "*.parquet")
    con.execute(
        f"""
        create or replace table minute_reconciliation as
        with m as (
          select symbol, (ts at time zone 'America/New_York')::date as d,
                 count(*) as minute_bars, sum(volume) as m_volume,
                 arg_min(open, ts) as m_open, max(high) as m_high, min(low) as m_low, arg_max(close, ts) as m_close
          from read_parquet('{files}', hive_partitioning = false)
          group by 1, 2
        ),
        loaded as (select distinct symbol, month from (
          select unnest(string_split(u.symbols, ',')) as symbol, u.month
          from minute_units u join minute_load_log l using (unit_id)))
        select d.symbol, d.date, d.volume as d_volume, m.m_volume, m.minute_bars,
               d.high as d_high, m.m_high, d.low as d_low, m.m_low,
               case when m.symbol is null then 'missing'
                    when abs(m.m_volume - d.volume) <= 0.02 * d.volume then 'complete'
                    else 'partial' end as status,
               (m.m_volume::double / nullif(d.volume, 0)) as volume_ratio
        from wh.sip_bars_daily_raw d
        join loaded l on l.symbol = d.symbol and l.month = date_trunc('month', d.date)::date
        left join m on m.symbol = d.symbol and m.d = d.date
        """
    )
    print("Minute vs daily, loaded symbol-months only:")
    for r in con.execute(
        "select status, count(*), median(volume_ratio) from minute_reconciliation group by 1 order by 1"
    ).fetchall():
        print(f"  {r[0]:<9} {r[1]:>12,} sessions, median minute/daily volume {r[2] if r[2] is not None else float('nan'):.4f}")
    print("  volume ratio percentiles (p1, p5, p50, p95):",
          con.execute("select quantile_cont(volume_ratio, [0.01, 0.05, 0.5, 0.95]) from minute_reconciliation where volume_ratio is not null").fetchone()[0])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", action="store_true", help="(re)build the unit plan from daily bars")
    ap.add_argument("--max-units", type=int, help="run at most N units (smoke test)")
    ap.add_argument("--reconcile", action="store_true", help="audit minute bars against daily bars")
    args = ap.parse_args()

    if args.reconcile:
        reconcile()
        return
    log = log_con()
    if args.plan or log.execute("select count(*) from minute_units").fetchone()[0] == 0:
        plan(log)
        if args.plan:
            return
    env = load_env()
    run_units(log, Alpaca(env["ALPACA_API_KEY_ID"], env["ALPACA_API_SECRET_KEY"]), args.max_units)
    log.close()


if __name__ == "__main__":
    main()
