"""
Resumable crawl of Alpaca's whole-market news feed (/v1beta1/news,
Benzinga-sourced, 2015+) into one parquet per month:
research/data/catalysts/raw/news/YYYY-MM.parquet (id, created_at UTC,
headline, symbols, source). A finished month is never re-fetched unless
--refresh; the current month is always re-fetched.

~700-1,000 headlines per weekday, 50 per request. The key's 200/min limit
is shared with the live site's scans, so this uses 120/min: a full
2016-now crawl is ~45k requests, ~6-7 hours.

    research/.venv/bin/python research/catalysts/news_crawl.py [--from 2016-01] [--refresh]
"""
import argparse
import datetime as dt
import json
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

OUT = Path(__file__).resolve().parent.parent / "data" / "catalysts" / "raw" / "news"
URL = "https://data.alpaca.markets/v1beta1/news"
MIN_INTERVAL = 60 / 120  # 120/min: leaves ~80/min of the shared 200/min key for the live site


def fetch_month(first: dt.date, headers) -> list:
    nxt = (first.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
    params = {"start": f"{first}T00:00:00Z", "end": f"{nxt}T00:00:00Z", "limit": 50, "sort": "asc"}
    rows, tok, last = [], None, 0.0
    while True:
        p = dict(params, **({"page_token": tok} if tok else {}))
        wait = MIN_INTERVAL - (time.time() - last)
        if wait > 0:
            time.sleep(wait)
        for attempt in range(8):
            last = time.time()
            try:
                req = urllib.request.Request(f"{URL}?{urllib.parse.urlencode(p)}", headers=headers)
                with urllib.request.urlopen(req, timeout=60) as r:
                    body = json.load(r)
                break
            except urllib.error.HTTPError as e:
                if e.code not in (429, 500, 502, 503, 504):
                    raise
                time.sleep(min(60, 2 ** attempt))
            except Exception:
                time.sleep(min(60, 2 ** attempt))
        else:
            raise RuntimeError(f"news fetch kept failing at {first} token={tok}")
        rows += body.get("news") or []
        tok = body.get("next_page_token")
        if not tok:
            return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", default="2016-01")
    ap.add_argument("--refresh", action="store_true")
    args = ap.parse_args()
    headers = {"APCA-API-KEY-ID": os.environ["ALPACA_API_KEY_ID"], "APCA-API-SECRET-KEY": os.environ["ALPACA_API_SECRET_KEY"]}
    OUT.mkdir(parents=True, exist_ok=True)
    m = dt.date.fromisoformat(args.start + "-01")
    this = dt.date.today().replace(day=1)
    while m <= this:
        path = OUT / f"{m:%Y-%m}.parquet"
        if path.exists() and not args.refresh and m < this:
            m = (m.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
            continue
        t0 = time.time()
        rows = fetch_month(m, headers)
        tmp = path.with_suffix(".tmp")
        pq.write_table(pa.table({
            "id": [r["id"] for r in rows],
            "created_at": pa.array([r["created_at"] for r in rows]).cast(pa.timestamp("s", tz="UTC")),
            "headline": [r.get("headline") or "" for r in rows],
            "symbols": [r.get("symbols") or [] for r in rows],
            "source": [r.get("source") or "" for r in rows],
        }), tmp)
        tmp.rename(path)
        print(f"{m:%Y-%m}: {len(rows):,} articles ({time.time() - t0:.0f}s)", flush=True)
        m = (m.replace(day=28) + dt.timedelta(days=4)).replace(day=1)


if __name__ == "__main__":
    main()
