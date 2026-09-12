#!/usr/bin/env python
"""
Load every US equity Alpaca lists — active and delisted, every exchange
including OTC — with consolidated-tape (SIP) daily bars from 2016, straight
from Alpaca into the local DuckDB research warehouse.

Why this exists alongside load_from_supabase.py: production bars_daily is
fetched with `feed: "iex"` (netlify/functions/lib/alpaca.ts). IEX is one
exchange. Measured 2026-09-11 on thin band names, IEX volume was a median
0.1-4.5% of consolidated volume, closes differed by >1% on up to two thirds
of sessions, and CORZ was missing 265 sessions that did trade on the
consolidated tape. The free data plan serves SIP history (back to
2016-01-04) as long as it is older than 15 minutes; IEX history only
starts 2020-07-27.

It also fixes two universe problems:
- SURVIVORSHIP. Production symbols are today's listings only (all 5,001
  are `active`). This loads delisted assets too, so names that collapsed
  and delisted are in the history.
- ADJUSTED-PRICE BANDS. Both `raw` (as traded) and `split`-adjusted bars
  are stored. Band membership ("was it under $5?") must use raw; returns
  should use split-adjusted.

KNOWN HAZARD — TICKER REUSE. Alpaca serves history by *symbol*. When a
ticker is reused (BBBY: Bed Bath & Beyond until 2023, a different company
later), one symbol's series can span two companies, and the delisted
asset's symbol (BBBYQ) can repeat the same early history. Nothing here
resolves that; research must treat long gaps inside a symbol's series as
a possible company change, not a halt.

Writes only to research/data/stackslash.duckdb. Touches nothing in
Supabase. Resumable: every completed batch is recorded in sip_load_log and
skipped on a re-run unless --fresh.

Usage:
    research/.venv/bin/python research/load_from_alpaca.py              # everything
    research/.venv/bin/python research/load_from_alpaca.py --limit 400  # smoke test
    research/.venv/bin/python research/load_from_alpaca.py --fresh      # drop and reload
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone
from pathlib import Path

import duckdb
import pyarrow as pa
import requests

REPO = Path(__file__).resolve().parent.parent
DB_PATH = REPO / "research" / "data" / "stackslash.duckdb"

TRADING = "https://paper-api.alpaca.markets/v2/assets"
BARS = "https://data.alpaca.markets/v2/stocks/bars"
START = "2016-01-01T00:00:00Z"
SYMBOLS_PER_REQUEST = 200  # accepted by the bulk endpoint (verified)
PAGE_LIMIT = 10000  # max bars per page
RATE_PER_MIN = 190  # Alpaca allows 200/min on this plan; leave headroom
WORKERS = 4
ADJUSTMENTS = ("raw", "split")
# Uppercase letter first, then letters/digits and the class/unit
# separators Alpaca uses (BRK.B, and / or - on some units and warrants).
TICKER_RE = "[A-Z][A-Z0-9./-]*"
BAR_SCHEMA = pa.schema([
    ("symbol", pa.string()), ("date", pa.date32()),
    ("open", pa.float64()), ("high", pa.float64()), ("low", pa.float64()), ("close", pa.float64()),
    ("volume", pa.int64()), ("trade_count", pa.int64()), ("vwap", pa.float64()),
])


def load_env() -> dict:
    env = {}
    envfile = REPO / ".env"
    if not envfile.exists():
        sys.exit(f"No .env at {envfile} — needed for ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY.")
    for line in envfile.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


class RateLimiter:
    """Shared across worker threads: at most RATE_PER_MIN request starts per 60s."""

    def __init__(self, per_min: int):
        self.interval = 60.0 / per_min
        self.lock = threading.Lock()
        self.next_at = time.monotonic()

    def wait(self):
        with self.lock:
            now = time.monotonic()
            if self.next_at > now:
                time.sleep(self.next_at - now)
            self.next_at = max(self.next_at, now) + self.interval


class Alpaca:
    def __init__(self, key: str, secret: str):
        self.headers = {"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret}
        self.limiter = RateLimiter(RATE_PER_MIN)
        self.local = threading.local()

    def _session(self) -> requests.Session:
        if not hasattr(self.local, "s"):
            self.local.s = requests.Session()
            self.local.s.headers.update(self.headers)
        return self.local.s

    def get(self, url: str, params: dict) -> dict:
        for attempt in range(8):
            self.limiter.wait()
            try:
                r = self._session().get(url, params=params, timeout=120)
            except requests.RequestException as e:
                wait = min(60, 2**attempt)
                print(f"  network error ({e.__class__.__name__}), retry in {wait}s", flush=True)
                time.sleep(wait)
                continue
            if r.status_code == 429 or r.status_code >= 500:
                wait = min(60, 2**attempt)
                print(f"  HTTP {r.status_code}, retry in {wait}s", flush=True)
                time.sleep(wait)
                continue
            r.raise_for_status()
            return r.json()
        raise RuntimeError(f"gave up after 8 attempts: {url} {params.get('symbols', '')[:60]}")


def load_assets(con, api: Alpaca) -> list[str]:
    rows = []
    for status in ("active", "inactive"):
        rows += api.get(TRADING, {"asset_class": "us_equity", "status": status})
    table = pa.table(
        {
            "asset_id": [a["id"] for a in rows],
            "symbol": [a["symbol"] for a in rows],
            "name": [a.get("name") for a in rows],
            "exchange": [a.get("exchange") for a in rows],
            "status": [a.get("status") for a in rows],
            "tradable": [a.get("tradable") for a in rows],
            "marginable": [a.get("marginable") for a in rows],
            "shortable": [a.get("shortable") for a in rows],
            "fractionable": [a.get("fractionable") for a in rows],
            "attributes": [json.dumps(a.get("attributes") or []) for a in rows],
            "loaded_at": [datetime.now(timezone.utc)] * len(rows),
        }
    )
    con.register("_assets", table)
    con.execute("create or replace table alpaca_assets as select * from _assets")
    con.unregister("_assets")
    n = con.execute("select count(*) from alpaca_assets").fetchone()[0]
    print(f"alpaca_assets: {n:,} assets")
    for ex, st, c in con.execute(
        "select exchange, status, count(*) from alpaca_assets group by 1, 2 order by 1, 2"
    ).fetchall():
        print(f"  {ex:<8} {st:<9} {c:>6}")
    # Map each asset's symbol to the ticker bars are requested under.
    # - `LPNT_DELISTED`-style symbols (68, all delisted companies) are
    #   rejected by the bars endpoint as invalid, but the bare ticker
    #   returns their history up to delisting (LPNT: 2016-01-04 ->
    #   2018-11-15). Dropping them would reintroduce survivorship bias.
    # - One lowercase warrant (`ahpaw`) just needs upper-casing.
    # What still isn't ticker-shaped is CUSIP/CVR/escrow/contra
    # placeholders (0029900E0, 004CVR049, ...); one of those in a
    # 200-symbol request 400s the whole request. Record, don't drop silently.
    con.execute(
        r"""create or replace table sip_symbol_map as
            select symbol as asset_symbol,
                   upper(regexp_replace(symbol, '_DELISTED$', '')) as bar_symbol,
                   exchange, status, name
            from alpaca_assets"""
    )
    con.execute(
        f"""create or replace table sip_excluded_symbols as
            select * from sip_symbol_map where not regexp_full_match(bar_symbol, '{TICKER_RE}')"""
    )
    remapped = con.execute(
        "select count(*) from sip_symbol_map where asset_symbol <> bar_symbol"
    ).fetchone()[0]
    print(f"  remapped to their bar ticker (_DELISTED suffix / case): {remapped}")
    for ex, st, c in con.execute(
        "select exchange, status, count(*) from sip_excluded_symbols group by 1, 2 order by 1, 2"
    ).fetchall():
        print(f"  excluded (not ticker-shaped): {ex:<8} {st:<9} {c:>6}")
    # One bar series per ticker; a reused ticker appears under several assets.
    return [
        r[0]
        for r in con.execute(
            f"select distinct bar_symbol from sip_symbol_map where regexp_full_match(bar_symbol, '{TICKER_RE}') order by 1"
        ).fetchall()
    ]


def ensure_tables(con, fresh: bool):
    if fresh:
        for t in ("sip_bars_daily_raw", "sip_bars_daily_split", "sip_load_log"):
            con.execute(f"drop table if exists {t}")
    for adj in ADJUSTMENTS:
        con.execute(
            f"""create table if not exists sip_bars_daily_{adj} (
                  symbol varchar, date date, open double, high double, low double,
                  close double, volume bigint, trade_count bigint, vwap double)"""
        )
    con.execute(
        """create table if not exists sip_load_log (
             adjustment varchar, batch_no integer, symbols_requested integer,
             symbols_with_bars integer, bars integer, pages integer,
             rejected_symbols varchar, loaded_at timestamptz)"""
    )


def fetch_batch(api: Alpaca, symbols: list[str], adjustment: str, end: str) -> tuple[list[dict], int]:
    rows, pages, token = [], 0, None
    while True:
        params = {
            "symbols": ",".join(symbols),
            "timeframe": "1Day",
            "start": START,
            "end": end,
            "limit": PAGE_LIMIT,
            "feed": "sip",
            "adjustment": adjustment,
        }
        if token:
            params["page_token"] = token
        body = api.get(BARS, params)
        pages += 1
        for sym, bars in (body.get("bars") or {}).items():
            for b in bars:
                rows.append(
                    {
                        "symbol": sym,
                        # Daily bar timestamps are midnight America/New_York
                        # expressed in UTC (04:00/05:00Z), so the UTC date
                        # is the session date.
                        "date": date.fromisoformat(b["t"][:10]),
                        # Coerce every value explicitly. Alpaca has returned a
                        # JSON integer of ~2.65e18 in a float field; letting
                        # pyarrow convert it trips its exact-double check.
                        # The garbage value is kept, to be flagged downstream.
                        "open": float(b["o"]),
                        "high": float(b["h"]),
                        "low": float(b["l"]),
                        "close": float(b["c"]),
                        "volume": int(b["v"]),
                        "trade_count": int(b["n"]) if b.get("n") is not None else None,
                        "vwap": float(b["vw"]) if b.get("vw") is not None else None,
                    }
                )
        token = body.get("next_page_token")
        if not token:
            return rows, pages


def fetch_batch_isolating(api: Alpaca, symbols: list[str], adjustment: str, end: str) -> tuple[list[dict], int, list[str]]:
    """
    fetch_batch, but a 400 (one unacceptable symbol poisons the whole
    request) is bisected down to the offending symbols, which are returned
    as rejected instead of failing the load.
    """
    try:
        rows, pages = fetch_batch(api, symbols, adjustment, end)
        return rows, pages, []
    except requests.HTTPError as e:
        if e.response is None or e.response.status_code != 400:
            raise
        if len(symbols) == 1:
            return [], 1, symbols
        mid = len(symbols) // 2
        r1, p1, bad1 = fetch_batch_isolating(api, symbols[:mid], adjustment, end)
        r2, p2, bad2 = fetch_batch_isolating(api, symbols[mid:], adjustment, end)
        return r1 + r2, p1 + p2 + 1, bad1 + bad2


def load_bars(con, api: Alpaca, symbols: list[str], adjustment: str, end: str):
    table = f"sip_bars_daily_{adjustment}"
    batches = [symbols[i : i + SYMBOLS_PER_REQUEST] for i in range(0, len(symbols), SYMBOLS_PER_REQUEST)]
    done = {
        r[0]
        for r in con.execute("select batch_no from sip_load_log where adjustment = ?", [adjustment]).fetchall()
    }
    todo = [(i, b) for i, b in enumerate(batches) if i not in done]
    print(f"\n{table}: {len(batches)} batches of {SYMBOLS_PER_REQUEST} symbols, {len(done)} already loaded, {len(todo)} to go")
    if not todo:
        return

    t0, total_bars = time.time(), 0
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [(i, b, pool.submit(fetch_batch_isolating, api, b, adjustment, end)) for i, b in todo]
        for n, (i, b, fut) in enumerate(futures, 1):
            rows, pages, rejected = fut.result()
            if rejected:
                print(f"  batch {i}: API rejected {len(rejected)} symbol(s): {', '.join(rejected[:10])}", flush=True)
            if rows:
                # Explicit schema, never inferred: Alpaca has returned a
                # volume/trade_count of ~2.65e18 (vendor garbage), which fits
                # int64 but crashed inference once the column went double.
                arrow = pa.Table.from_pylist(rows, schema=BAR_SCHEMA)
                con.register("_bars", arrow)
                # Delete-then-insert keeps a batch idempotent if a previous
                # run died after writing bars but before logging the batch.
                con.execute(f"delete from {table} where symbol in (select distinct symbol from _bars)")
                con.execute(f"insert into {table} select * from _bars")
                con.unregister("_bars")
            con.execute(
                "insert into sip_load_log values (?, ?, ?, ?, ?, ?, ?, now())",
                [adjustment, i, len(b), len({r["symbol"] for r in rows}), len(rows), pages, ",".join(rejected) or None],
            )
            total_bars += len(rows)
            if n % 10 == 0 or n == len(futures):
                elapsed = time.time() - t0
                eta = elapsed / n * (len(futures) - n)
                print(f"  {n}/{len(futures)} batches, {total_bars:,} bars, {elapsed/60:.1f}m elapsed, ETA {eta/60:.1f}m", flush=True)


def verify(con, symbols_expected: int):
    print("\nVerification")
    ok = True
    for adj in ADJUSTMENTS:
        t = f"sip_bars_daily_{adj}"
        n, syms, dmin, dmax = con.execute(f"select count(*), count(distinct symbol), min(date), max(date) from {t}").fetchone()
        logged = con.execute(
            "select coalesce(sum(bars), 0), coalesce(sum(symbols_requested), 0), count(*) from sip_load_log where adjustment = ?",
            [adj],
        ).fetchone()
        dups = con.execute(f"select count(*) from (select symbol, date from {t} group by 1, 2 having count(*) > 1)").fetchone()[0]
        print(f"  {t}: {n:,} bars, {syms:,} symbols with data, {dmin} -> {dmax}; log says {logged[0]:,} bars over {logged[1]:,} symbols requested; duplicate (symbol,date): {dups}")
        if n != logged[0]:
            print(f"  !!! {t}: table has {n:,} bars but the load log recorded {logged[0]:,}")
            ok = False
        if logged[1] < symbols_expected:
            print(f"  !!! {t}: only {logged[1]:,} of {symbols_expected:,} symbols were requested — the load is incomplete; re-run to resume")
            ok = False
        if dups:
            ok = False
    if not ok:
        raise SystemExit("Verification failed — see above.")
    print("  OK")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, help="only the first N symbols (smoke test)")
    ap.add_argument("--fresh", action="store_true", help="drop the SIP tables and load log first")
    args = ap.parse_args()

    env = load_env()
    api = Alpaca(env["ALPACA_API_KEY_ID"], env["ALPACA_API_SECRET_KEY"])
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(DB_PATH))

    symbols = load_assets(con, api)
    if args.limit:
        symbols = symbols[: args.limit]
    ensure_tables(con, args.fresh or bool(args.limit))
    # Only bars older than 15 minutes are free on SIP; ending at today's
    # midnight UTC keeps every request inside that.
    end = datetime.now(timezone.utc).strftime("%Y-%m-%dT00:00:00Z")
    print(f"\nUniverse: {len(symbols):,} distinct symbols; bars {START[:10]} -> {end[:10]}, feed=sip")

    for adj in ADJUSTMENTS:
        load_bars(con, api, symbols, adj, end)

    verify(con, len(symbols))
    con.execute("checkpoint")
    print(f"\nWarehouse: {DB_PATH} ({DB_PATH.stat().st_size / 1e9:.2f} GB)")
    con.close()


if __name__ == "__main__":
    main()
