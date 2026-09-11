#!/usr/bin/env python
"""
Pull bars_daily + symbols out of Supabase into the local DuckDB research
warehouse.

Why a second store at all: Supabase stays the operational source of truth
(Netlify functions, frontend, auth, realtime all point there). This one is
derived, analytical, and disposable — everything in it can be rebuilt from
Supabase or re-fetched from Alpaca, which is why research/data/ is
gitignored and deliberately not backed up.

Why DuckDB rather than more Postgres: the work here is full scans and
window functions over millions of rows. Every timeout hit while building
the integrity checks and the duration sweep was PostgREST's statement
limit on exactly that shape of query. Columnar + local socket makes those
sub-second, and the same data compresses to a fraction of the 131
bytes/row it costs in Postgres.

Reads the service-role key from the repo's .env (never committed).

Usage:
    research/.venv/bin/python research/load_from_supabase.py
    research/.venv/bin/python research/load_from_supabase.py --table bars_daily
"""

import argparse
import os
import sys
import time
from pathlib import Path

import duckdb
import requests

REPO = Path(__file__).resolve().parent.parent
DB_PATH = REPO / "research" / "data" / "stackslash.duckdb"

# PostgREST enforces a server-side max-rows that a Range header cannot
# lift — asking for 50,000 returns 1,000 with a 200 and no warning, which
# is the same silent truncation that has now bitten this project six
# times. Page at exactly the cap so a short page is a real end-of-data
# signal rather than the server quietly disagreeing with you.
PAGE = 1000
FETCH_WORKERS = 8


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


def exact_count(base_url: str, key: str, table: str) -> int:
    """Authoritative row count, so paging is driven by the server's own
    number rather than by inferring the end from a short page."""
    r = requests.get(
        f"{base_url}/rest/v1/{table}",
        headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Prefer": "count=exact",
            "Range": "0-0",
        },
        params={"select": "*"},
        timeout=120,
    )
    r.raise_for_status()
    # Content-Range comes back as "0-0/5283102"
    return int(r.headers["Content-Range"].split("/")[-1])


def fetch_page(base_url: str, key: str, table: str, columns: str, order: str, offset: int):
    r = requests.get(
        f"{base_url}/rest/v1/{table}",
        headers={"apikey": key, "Authorization": f"Bearer {key}", "Range": f"{offset}-{offset + PAGE - 1}"},
        params={"select": columns, "order": order},
        timeout=180,
    )
    r.raise_for_status()
    return r.json()


def fetch_all(base_url: str, key: str, table: str, columns: str, order: str):
    """
    Paged REST pull, parallelised. Offsets are derived from the server's
    exact count, and the total actually received is verified against it —
    a silent short read fails loudly instead of producing a plausible
    partial dataset.
    """
    from concurrent.futures import ThreadPoolExecutor

    total_expected = exact_count(base_url, key, table)
    offsets = list(range(0, total_expected, PAGE))
    print(f"  {table}: {total_expected:,} rows expected, {len(offsets):,} pages")

    received = 0
    with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
        futures = [pool.submit(fetch_page, base_url, key, table, columns, order, o) for o in offsets]
        for fut in futures:
            rows = fut.result()
            if rows:
                received += len(rows)
                yield rows
                print(f"  {table}: {received:,}/{total_expected:,}", end="\r", flush=True)

    print(f"  {table}: {received:,}/{total_expected:,} rows received")
    if received < total_expected:
        raise RuntimeError(
            f"{table}: short read — got {received:,} of {total_expected:,}. "
            "Refusing to continue with a truncated table."
        )


def load_table(con, base_url, key, table, columns, order):
    t0 = time.time()
    print(f"Loading {table}...")
    con.execute(f"drop table if exists {table}")
    created = False
    for rows in fetch_all(base_url, key, table, columns, order):
        # Register the Arrow table on *this* connection — duckdb.from_arrow()
        # binds to the default connection and can't be used from another.
        con.register("_batch", _to_arrow(rows))
        if not created:
            con.execute(f"create table {table} as select * from _batch")
            created = True
        else:
            con.execute(f"insert into {table} select * from _batch")
        con.unregister("_batch")
    if not created:
        print(f"  {table}: no rows returned")
        return
    n = con.execute(f"select count(*) from {table}").fetchone()[0]
    print(f"  {table}: {n:,} rows in {time.time() - t0:.1f}s")


def _to_arrow(rows):
    import pyarrow as pa

    cols = {k: [r.get(k) for r in rows] for k in rows[0].keys()}
    return pa.table(cols)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--table", help="load only this table")
    args = ap.parse_args()

    env = load_env()
    key = env.get("SUPABASE_SERVICE_ROLE_KEY")
    base = env.get("VITE_SUPABASE_URL") or env.get("SUPABASE_URL")
    if not key or not base:
        sys.exit("Need SUPABASE_SERVICE_ROLE_KEY and VITE_SUPABASE_URL/SUPABASE_URL in .env")
    base = base.rstrip("/")

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(DB_PATH))

    targets = [
        ("symbols", "id,ticker,exchange,active,name", "id"),
        ("bars_daily", "symbol_id,date,open,high,low,close,volume", "symbol_id,date"),
    ]
    for table, columns, order in targets:
        if args.table and table != args.table:
            continue
        load_table(con, base, key, table, columns, order)

    print(f"\nWarehouse: {DB_PATH}")
    print(f"Size on disk: {DB_PATH.stat().st_size / 1e9:.2f} GB")
    con.close()


if __name__ == "__main__":
    main()
