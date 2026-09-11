#!/usr/bin/env python
"""
Pull operational tables out of Supabase into the local DuckDB research
warehouse.

Why a second store at all: Supabase stays the operational source of truth
(Netlify functions, frontend, auth, realtime all point there). This one is
derived, analytical, and disposable — everything in it can be rebuilt from
Supabase or re-fetched from Alpaca, which is why research/data/ is
gitignored and deliberately not backed up.

Why DuckDB rather than more Postgres: the work here is full scans and
window functions over millions of rows. Every timeout hit while building
the integrity checks, the spread estimator and the duration sweep was
PostgREST's statement limit on exactly that query shape. Columnar and
local, those run in seconds.

TWO PAGINATION HAZARDS, both hit for real while writing this:

1. PostgREST enforces a server-side max-rows that a Range header cannot
   lift. Asking for 50,000 returns 1,000, with a 200 and no warning — the
   same silent truncation that has now bitten this project six times. So
   page at exactly the cap, and verify the total received against the
   server's own exact count.

2. Deep OFFSET pagination is quadratic. `offset 5000000 limit 1000` makes
   Postgres walk five million rows to throw them away, so pages get
   steadily slower and a 5.3M-row table never finishes. bars_daily is
   therefore paged *per symbol*, which the (symbol_id, date) primary key
   turns into a cheap indexed range scan.

If you add a DATABASE_URL (Supabase dashboard -> Project Settings ->
Database) this whole file becomes unnecessary — DuckDB's postgres
extension can ATTACH and bulk-copy with no REST layer, no row cap and no
offset problem.

Usage:
    research/.venv/bin/python research/load_from_supabase.py
    research/.venv/bin/python research/load_from_supabase.py --table bars_daily
"""

import argparse
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import duckdb
import pyarrow as pa
import requests

REPO = Path(__file__).resolve().parent.parent
DB_PATH = REPO / "research" / "data" / "stackslash.duckdb"

PAGE = 1000  # PostgREST's max-rows; asking for more silently returns this
WORKERS = 12


def load_env() -> dict:
    env = {}
    envfile = REPO / ".env"
    if not envfile.exists():
        sys.exit(f"No .env at {envfile} — needed for SUPABASE_SERVICE_ROLE_KEY.")
    for line in envfile.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env


class Rest:
    def __init__(self, base: str, key: str):
        self.base = base.rstrip("/")
        self.key = key
        self.session = requests.Session()
        self.session.headers.update({"apikey": key, "Authorization": f"Bearer {key}"})

    def count(self, table: str, params: dict | None = None) -> int:
        r = self.session.get(
            f"{self.base}/rest/v1/{table}",
            headers={"Prefer": "count=exact", "Range": "0-0"},
            params={"select": "*", **(params or {})},
            timeout=120,
        )
        r.raise_for_status()
        return int(r.headers["Content-Range"].split("/")[-1])

    def page(self, table: str, columns: str, offset: int, params: dict | None = None):
        r = self.session.get(
            f"{self.base}/rest/v1/{table}",
            headers={"Range": f"{offset}-{offset + PAGE - 1}"},
            params={"select": columns, **(params or {})},
            timeout=180,
        )
        r.raise_for_status()
        return r.json()


def to_arrow(rows: list[dict]) -> pa.Table:
    cols = {k: [r.get(k) for r in rows] for k in rows[0].keys()}
    return pa.table(cols)


def write(con, table: str, rows: list[dict], first: bool):
    con.register("_batch", to_arrow(rows))
    if first:
        con.execute(f"create or replace table {table} as select * from _batch")
    else:
        con.execute(f"insert into {table} select * from _batch")
    con.unregister("_batch")


def load_simple(con, rest: Rest, table: str, columns: str, order: str):
    """Offset paging — fine for small tables where the offset never gets deep."""
    total = rest.count(table)
    print(f"Loading {table}: {total:,} rows expected")
    received, first = 0, True
    for offset in range(0, total, PAGE):
        rows = rest.page(table, columns, offset, {"order": order})
        if not rows:
            break
        write(con, table, rows, first)
        first, received = False, received + len(rows)
    verify(table, received, total)


def load_bars_by_symbol(con, rest: Rest, symbol_ids: list[int]):
    """
    bars_daily, paged per symbol. ~1,255 rows/symbol means 2 indexed
    requests each, instead of one ever-slower walk down a 5.3M-row offset.
    """
    table, columns = "bars_daily", "symbol_id,date,open,high,low,close,volume"
    total = rest.count(table)
    print(f"Loading {table}: {total:,} rows expected across {len(symbol_ids):,} symbols")

    def fetch_symbol(sid: int) -> list[dict]:
        out, offset = [], 0
        while True:
            rows = rest.page(table, columns, offset, {"symbol_id": f"eq.{sid}", "order": "date"})
            if not rows:
                break
            out.extend(rows)
            if len(rows) < PAGE:
                break
            offset += PAGE
        return out

    received, first, done = 0, True, 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for rows in pool.map(fetch_symbol, symbol_ids):
            done += 1
            if rows:
                write(con, table, rows, first)
                first = False
                received += len(rows)
            if done % 250 == 0:
                rate = done / max(time.time() - t0, 1e-9)
                eta = (len(symbol_ids) - done) / max(rate, 1e-9)
                print(f"  {done:,}/{len(symbol_ids):,} symbols, {received:,} rows, ETA {eta/60:.1f}m", flush=True)
    verify(table, received, total)


def verify(table: str, received: int, expected: int):
    print(f"  {table}: {received:,}/{expected:,} rows")
    if received < expected:
        raise RuntimeError(
            f"{table}: short read — {received:,} of {expected:,}. "
            "Refusing to continue with a truncated table."
        )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--table", help="load only this table")
    args = ap.parse_args()

    env = load_env()
    key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    base = env.get("VITE_SUPABASE_URL") or env.get("SUPABASE_URL")
    if not key or not base:
        sys.exit("Need SUPABASE_SERVICE_ROLE_KEY and VITE_SUPABASE_URL/SUPABASE_URL in .env")

    rest = Rest(base, key)
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(DB_PATH))

    if not args.table or args.table == "symbols":
        load_simple(con, rest, "symbols", "id,ticker,exchange,active,name", "id")

    if not args.table or args.table == "bars_daily":
        ids = [r[0] for r in con.execute("select id from symbols order by id").fetchall()]
        if not ids:
            sys.exit("symbols table empty — load it before bars_daily.")
        load_bars_by_symbol(con, rest, ids)

    con.execute("checkpoint")
    print(f"\nWarehouse: {DB_PATH}")
    print(f"Size on disk: {DB_PATH.stat().st_size / 1e9:.2f} GB")
    for t, in con.execute("select table_name from information_schema.tables where table_schema='main'").fetchall():
        n = con.execute(f"select count(*) from {t}").fetchone()[0]
        print(f"  {t}: {n:,} rows")
    con.close()


if __name__ == "__main__":
    main()
