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
  intraday scans run during market hours. The limiter uses
  MARKET_HOURS_RATE on weekdays 08:00-20:00 America/New_York and
  OFF_HOURS_RATE otherwise. MARKET_HOURS_RATE was 60 (leaving production
  ~140/min); it is currently set to full rate, so the pull wins.
- The progress log lives in its own DuckDB file (minute_log.duckdb) so
  the main warehouse stays readable while a multi-day load runs.

A minute bar only exists for a minute in which something traded: a thin
name can have 20 bars in a session, a liquid one ~860. That is not a gap.

Usage:
    research/.venv/bin/python research/load_minute_bars.py --plan          # (re)build the unit plan
    research/.venv/bin/python research/load_minute_bars.py                 # run / resume
    research/.venv/bin/python research/load_minute_bars.py --max-units 20  # smoke test
    research/.venv/bin/python research/load_minute_bars.py --reconcile     # minute vs daily audit
    research/.venv/bin/python research/load_minute_bars.py --update        # nightly: new sessions only

--update plans one set of units per new session (unit ids dYYYYMMDD-NNNNN,
`day` set) from the warehouse's daily bars, so run load_from_alpaca.py
--update first. See scripts/run-research-update.sh.
"""

from __future__ import annotations

import argparse
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone
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
PLAN_PARQUET = DATA / "minute_units.parquet"

BARS = "https://data.alpaca.markets/v2/stocks/bars"
PAGE_LIMIT = 10000
TARGET_BARS_PER_UNIT = 20000  # ~2 pages; packs many thin names per request
MAX_SYMBOLS_PER_UNIT = 200
MAX_BARS_PER_SESSION = 960  # 04:00-20:00 ET
# 2026-09-14: raised from 60 to full rate at the user's call. The pull takes
# priority over the live site; production calls during market hours may 429
# (fetchSipBars/fetchBars retry on 429). Drop back to 60 to protect the site.
MARKET_HOURS_RATE = 190
OFF_HOURS_RATE = 190
WORKERS = 4
ET = ZoneInfo("America/New_York")
# The bulk pull's plan covered sessions through this date; --update takes
# over from the next session.
BULK_THROUGH = date(2026, 9, 11)


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
    # Bulk units cover a calendar month (day null); --update units one session.
    con.execute("alter table minute_units add column if not exists day date")
    con.execute(
        "create table if not exists minute_update_days (date date primary key, units integer, planned_at timestamptz)"
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
        order by 3 desc, 1, 2"""
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


def plan_day(log, wh, d: date) -> int:
    """Pack one session's symbols (every symbol with a daily bar that day) into units."""
    rows = wh.execute(
        f"""select symbol, least(coalesce(trade_count, {MAX_BARS_PER_SESSION}), {MAX_BARS_PER_SESSION})
            from sip_bars_daily_raw where date = ? order by symbol""",
        [d],
    ).fetchall()
    units, cur, est = [], [], 0
    for sym, e in rows:
        if cur and (est + e > TARGET_BARS_PER_UNIT or len(cur) >= MAX_SYMBOLS_PER_UNIT):
            units.append((cur, est))
            cur, est = [], 0
        cur.append(sym)
        est += e
    if cur:
        units.append((cur, est))
    log.executemany(
        """insert or replace into minute_units (unit_id, month, priority, symbols, n_symbols, est_bars, day)
           values (?, ?, 0, ?, ?, ?, ?)""",
        [(f"d{d:%Y%m%d}-{i:05d}", d.replace(day=1), ",".join(s), len(s), e, d) for i, (s, e) in enumerate(units)],
    )
    log.execute("insert or replace into minute_update_days values (?, ?, now())", [d, len(units)])
    return len(units)


def pack(rows: list[tuple[str, int]]) -> list[tuple[list[str], int]]:
    """Greedy-pack (symbol, est_bars) into units of ~TARGET_BARS_PER_UNIT."""
    units, cur, est = [], [], 0
    for sym, e in rows:
        if cur and (est + e > TARGET_BARS_PER_UNIT or len(cur) >= MAX_SYMBOLS_PER_UNIT):
            units.append((cur, est))
            cur, est = [], 0
        cur.append(sym)
        est += e
    if cur:
        units.append((cur, est))
    return units


def plan_gaps(log, wh) -> int:
    """
    Units for any symbol-session with a daily bar but no minute unit covering
    it: symbols the warehouse gained after the bulk plan (see
    load_from_alpaca.backfill_new_symbols). Months before BULK_THROUGH's month
    get month units; from that month on, where day units take over, gaps are
    planned per day so no two units ever cover the same session.
    """
    bulk_month0 = BULK_THROUGH.replace(day=1)
    covered_months = set(
        log.execute(
            "select distinct unnest(string_split(symbols, ',')), month from minute_units where day is null"
        ).fetchall()
    )
    covered_days = set(
        log.execute("select distinct unnest(string_split(symbols, ',')), day from minute_units where day is not null").fetchall()
    )
    through = log.execute("select max(date) from minute_update_days").fetchone()[0] or BULK_THROUGH
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d%H%M")
    batch = []

    by_month: dict = {}
    for sym, month, est in wh.execute(
        f"""select symbol, date_trunc('month', date)::date, sum(least(coalesce(trade_count, {MAX_BARS_PER_SESSION}), {MAX_BARS_PER_SESSION}))
            from sip_bars_daily_raw where date < ? group by 1, 2 order by 2, 1""",
        [bulk_month0],
    ).fetchall():
        if (sym, month) not in covered_months:
            by_month.setdefault(month, []).append((sym, est))
    for month, rows in by_month.items():
        for i, (syms, est) in enumerate(pack(rows)):
            batch.append((f"g{month:%Y%m}-{stamp}-{i:05d}", month, ",".join(syms), len(syms), est, None))

    by_day: dict = {}
    for sym, d, est in wh.execute(
        f"""select symbol, date, least(coalesce(trade_count, {MAX_BARS_PER_SESSION}), {MAX_BARS_PER_SESSION})
            from sip_bars_daily_raw where date >= ? and date <= ? order by 2, 1""",
        [bulk_month0, through],
    ).fetchall():
        # The bulk units for BULK_THROUGH's month cover its sessions through BULK_THROUGH.
        if d <= BULK_THROUGH and (sym, bulk_month0) in covered_months:
            continue
        if (sym, d) not in covered_days:
            by_day.setdefault(d, []).append((sym, est))
    for d, rows in by_day.items():
        for i, (syms, est) in enumerate(pack(rows)):
            batch.append((f"g{d:%Y%m%d}-{stamp}-{i:05d}", d.replace(day=1), ",".join(syms), len(syms), est, d))

    if batch:
        log.executemany(
            """insert into minute_units (unit_id, month, priority, symbols, n_symbols, est_bars, day)
               values (?, ?, 0, ?, ?, ?, ?)""",
            batch,
        )
        print(f"planned {len(batch)} gap units: {len(by_month)} month(s) before {bulk_month0}, {len(by_day)} later session(s)", flush=True)
    return len(batch)


def last_complete_session() -> date:
    """Latest date whose 04:00-20:00 ET session is over and past the 15-min SIP delay."""
    now = datetime.now(ET)
    return now.date() if (now.hour, now.minute) >= (20, 16) else now.date() - timedelta(days=1)


def fetch_unit(api: Alpaca, symbols: list[str], month, day: date | None = None) -> tuple[list[dict], int, list[str]]:
    if day is not None:
        start = datetime(day.year, day.month, day.day, 4, 0, tzinfo=ET).astimezone(timezone.utc)
        end = datetime(day.year, day.month, day.day, 20, 0, tzinfo=ET).astimezone(timezone.utc)
        end = min(end, datetime.now(timezone.utc) - timedelta(minutes=16))
    else:
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
                            # Explicit coercion: Alpaca can put a ~2.65e18 JSON
                            # integer in a float field (seen in daily bars).
                            "open": float(b["o"]), "high": float(b["h"]), "low": float(b["l"]), "close": float(b["c"]),
                            "volume": int(b["v"]),
                            "trade_count": int(b["n"]) if b.get("n") is not None else None,
                            "vwap": float(b["vw"]) if b.get("vw") is not None else None,
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
        """select u.unit_id, u.month, u.symbols, u.day from minute_units u
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
        futures = [(uid, m, pool.submit(fetch_unit, api, syms.split(","), m, day)) for uid, m, syms, day in window]
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


def update(log, api: Alpaca) -> None:
    """
    Nightly: plan and load minute bars for every complete session in the
    warehouse newer than what's already planned, then re-export the plan so
    schema_lab.py sees the new units. Idempotent: a planned day's units that
    are already logged are skipped, so a failed run just resumes next time.
    """
    covered = log.execute("select max(date) from minute_update_days").fetchone()[0] or BULK_THROUGH
    wh = duckdb.connect(str(WAREHOUSE), read_only=True)
    days = [
        r[0]
        for r in wh.execute(
            "select distinct date from sip_bars_daily_raw where date > ? and date <= ? order by 1",
            [covered, last_complete_session()],
        ).fetchall()
    ]
    for d in days:
        print(f"planned {plan_day(log, wh, d)} units for {d}", flush=True)
    plan_gaps(log, wh)
    wh.close()
    if not days:
        print(f"no new sessions after {covered}")
    run_units(log, api, None)
    log.execute(f"copy minute_units to '{PLAN_PARQUET}' (format parquet)")
    for d, syms, bars in log.execute(
        """select u.day, sum(l.symbols_with_bars), sum(l.bars) from minute_units u join minute_load_log l using (unit_id)
           where u.day in (select date from minute_update_days) group by 1 order by 1 desc limit 5"""
    ).fetchall():
        print(f"  {d}: {syms:,} symbols with minute bars, {bars:,} bars")


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
    ap.add_argument("--update", action="store_true", help="nightly: load sessions newer than what's covered")
    args = ap.parse_args()

    if args.reconcile:
        reconcile()
        return
    if args.update:
        log = log_con()
        env = load_env()
        update(log, Alpaca(env["ALPACA_API_KEY_ID"], env["ALPACA_API_SECRET_KEY"]))
        log.close()
        return
    log = log_con()
    if args.plan or log.execute("select count(*) from minute_units").fetchone()[0] == 0:
        plan(log)
        if args.plan:
            return
    # Other processes can't open minute_log.duckdb while this one holds its
    # write lock (DuckDB refuses even read-only). Export the fixed plan so
    # readers can tell which units are loaded from the files on disk alone:
    # a unit's Parquet exists only after write-then-rename completes.
    if not PLAN_PARQUET.exists():
        log.execute(f"copy minute_units to '{PLAN_PARQUET}' (format parquet)")
    env = load_env()
    run_units(log, Alpaca(env["ALPACA_API_KEY_ID"], env["ALPACA_API_SECRET_KEY"]), args.max_units)
    log.close()


if __name__ == "__main__":
    main()
