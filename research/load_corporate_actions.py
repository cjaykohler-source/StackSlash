#!/usr/bin/env python
"""
Load Alpaca corporate actions for all US equities, 2016 onward, into one
Parquet file per quarter under research/data/corporate_actions/.

Covers reverse/forward/unit splits, stock and cash dividends, name and
symbol changes, cash/stock mergers, spin-offs, redemptions, worthless
removals and rights distributions.

Why it matters for this project:
- TICKER REUSE. Name changes carry old -> new symbol, which is what's
  needed to tell a reused ticker (BBBY) from one continuous company.
- SPLITS. Reverse splits are near-constant in the sub-$5 band. Their ex
  dates and ratios let research reconcile raw vs split-adjusted bars and
  flag the sessions where a scale break is real.
- EXITS. Worthless removals and cash mergers date how delisted names left.

Rate: this shares the Alpaca account's 200 req/min with the minute pull
(190/min), so it runs at RATE_PER_MIN.

Resumable: a quarter whose file exists is skipped, except the current
quarter, which is always re-fetched.

Usage:
    research/.venv/bin/python research/load_corporate_actions.py
"""

from __future__ import annotations

import json
import sys
import time
from datetime import date, timedelta
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq
import requests

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "research" / "data" / "corporate_actions"
URL = "https://data.alpaca.markets/v1/corporate-actions"
RATE_PER_MIN = 8
START_YEAR = 2016

SCHEMA = pa.schema([
    ("type", pa.string()),            # e.g. reverse_splits, name_changes
    ("id", pa.string()),
    ("symbol", pa.string()),          # the symbol the action applies to
    ("old_symbol", pa.string()),
    ("new_symbol", pa.string()),
    ("acquirer_symbol", pa.string()),
    ("ex_date", pa.string()),
    ("process_date", pa.string()),
    ("record_date", pa.string()),
    ("payable_date", pa.string()),
    ("old_rate", pa.float64()),
    ("new_rate", pa.float64()),
    ("rate", pa.float64()),
    ("old_cusip", pa.string()),
    ("new_cusip", pa.string()),
    ("raw", pa.string()),             # full record as JSON, nothing dropped
])


def load_env() -> dict:
    env = {}
    for line in (REPO / ".env").read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def quarters():
    today = date.today()
    y, q = START_YEAR, 1
    while (y, q) <= (today.year, (today.month - 1) // 3 + 1):
        start = date(y, 3 * (q - 1) + 1, 1)
        nxt = date(y + (q == 4), (3 * q) % 12 + 1, 1)
        yield f"{y}Q{q}", start, min(nxt - timedelta(days=1), today), (y, q) == (today.year, (today.month - 1) // 3 + 1)
        q += 1
        if q == 5:
            y, q = y + 1, 1


def num(x):
    try:
        return float(x) if x is not None else None
    except (TypeError, ValueError):
        return None


def flatten(kind: str, a: dict) -> dict:
    return {
        "type": kind,
        "id": a.get("id"),
        "symbol": a.get("symbol") or a.get("new_symbol") or a.get("acquiree_symbol") or a.get("source_symbol"),
        "old_symbol": a.get("old_symbol") or a.get("acquiree_symbol"),
        "new_symbol": a.get("new_symbol"),
        "acquirer_symbol": a.get("acquirer_symbol"),
        "ex_date": a.get("ex_date"),
        "process_date": a.get("process_date"),
        "record_date": a.get("record_date"),
        "payable_date": a.get("payable_date"),
        "old_rate": num(a.get("old_rate")),
        "new_rate": num(a.get("new_rate")),
        "rate": num(a.get("rate")),
        "old_cusip": a.get("old_cusip"),
        "new_cusip": a.get("new_cusip") or a.get("cusip"),
        "raw": json.dumps(a, sort_keys=True),
    }


def fetch_quarter(session: requests.Session, start: date, end: date) -> tuple[list[dict], int]:
    rows, token, pages = [], None, 0
    while True:
        params = {"start": start.isoformat(), "end": end.isoformat(), "limit": 1000}
        if token:
            params["page_token"] = token
        for attempt in range(8):
            time.sleep(60.0 / RATE_PER_MIN)
            r = session.get(URL, params=params, timeout=120)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(min(60, 2 ** attempt))
                continue
            r.raise_for_status()
            break
        else:
            raise RuntimeError(f"gave up after 8 attempts: {start}..{end}")
        body = r.json()
        pages += 1
        for kind, items in (body.get("corporate_actions") or {}).items():
            rows.extend(flatten(kind, a) for a in items)
        token = body.get("next_page_token")
        if not token:
            return rows, pages


def main():
    env = load_env()
    session = requests.Session()
    session.headers.update({"APCA-API-KEY-ID": env["ALPACA_API_KEY_ID"], "APCA-API-SECRET-KEY": env["ALPACA_API_SECRET_KEY"]})
    OUT.mkdir(parents=True, exist_ok=True)
    total, t0 = 0, time.time()
    for label, start, end, current in quarters():
        path = OUT / f"{label}.parquet"
        if path.exists() and not current:
            continue
        rows, pages = fetch_quarter(session, start, end)
        tmp = path.with_suffix(".parquet.tmp")
        pq.write_table(pa.Table.from_pylist(rows, schema=SCHEMA), tmp, compression="zstd")
        tmp.rename(path)
        total += len(rows)
        kinds = {}
        for r in rows:
            kinds[r["type"]] = kinds.get(r["type"], 0) + 1
        splits = kinds.get("reverse_splits", 0)
        print(f"{label}: {len(rows):>6,} actions over {pages} page(s), {splits} reverse splits, {kinds.get('name_changes', 0)} name changes "
              f"({(time.time() - t0) / 60:.1f}m elapsed)", flush=True)
    print(f"done: {total:,} actions written this run to {OUT}")


if __name__ == "__main__":
    sys.exit(main())
