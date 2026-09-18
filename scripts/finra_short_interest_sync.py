#!/usr/bin/env python
"""
FINRA consolidated short interest into Supabase `short_interest`, for every
active symbol. Public API, no key:
    POST https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest

Settlement is twice a month (mid-month and month end) and FINRA publishes
~1-2 weeks later. The API can't sort, so the latest published settlement is
found by probing calendar days backwards with an EQUAL filter on
settlementDate. Safe to run daily: a settlement already loaded is skipped
unless --force.

Usage:
    research/.venv/bin/python scripts/finra_short_interest_sync.py [--settlements N] [--force]
"""

from __future__ import annotations

import argparse
from datetime import date, timedelta

import requests

from localjobs import Rest, load_env, now_iso

URL = "https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest"
PAGE = 5000


def fetch(day: str, limit: int, offset: int = 0) -> list[dict]:
    r = requests.post(URL, timeout=120, headers={"Accept": "application/json"}, json={
        "limit": limit, "offset": offset,
        "compareFilters": [{"compareType": "EQUAL", "fieldName": "settlementDate", "fieldValue": day}],
    })
    r.raise_for_status()
    return r.json() if r.text.strip() else []


def published_settlements(n: int, lookback_days: int = 200) -> list[str]:
    """The n most recent settlement dates with data, newest first."""
    found, d = [], date.today()
    for _ in range(lookback_days):
        if d.weekday() < 5 and fetch(d.isoformat(), 1):
            found.append(d.isoformat())
            if len(found) == n:
                break
        d -= timedelta(days=1)
    return found


def loaded(rest: Rest, day: str) -> bool:
    r = rest.s.get(f"{rest.base}/short_interest",
                   params={"select": "symbol_id", "settlement_date": f"eq.{day}", "limit": 1})
    r.raise_for_status()
    return bool(r.json())


def sync(rest: Rest, settlements: int, force: bool) -> int:
    ids = {s["ticker"].upper(): s["id"] for s in rest.active_symbols()}
    written = 0
    for day in published_settlements(settlements):
        if not force and loaded(rest, day):
            print(f"{day}: already loaded")
            continue
        rows, offset = [], 0
        while True:
            page = fetch(day, PAGE, offset)
            for x in page:
                sid = ids.get((x.get("symbolCode") or "").upper())
                if sid is None or x.get("currentShortPositionQuantity") is None:
                    continue
                rows.append({
                    "symbol_id": sid, "settlement_date": day,
                    "short_shares": x["currentShortPositionQuantity"],
                    "prev_short_shares": x.get("previousShortPositionQuantity"),
                    "change_pct": x.get("changePercent"),
                    "avg_daily_volume": x.get("averageDailyVolumeQuantity"),
                    "days_to_cover": x.get("daysToCoverQuantity"),
                    "market": x.get("marketClassCode"),
                    "updated_at": now_iso(),
                })
            if len(page) < PAGE:
                break
            offset += PAGE
        # A symbol can appear once per market class; keep the largest position.
        best = {}
        for r in rows:
            if r["symbol_id"] not in best or r["short_shares"] > best[r["symbol_id"]]["short_shares"]:
                best[r["symbol_id"]] = r
        rest.upsert("short_interest", list(best.values()), "symbol_id,settlement_date")
        written += len(best)
        print(f"{day}: {offset + len(page)} FINRA rows, {len(best)} matched active symbols")
    return written


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--settlements", type=int, default=2, help="how many recent settlements to (re)check")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    rest = Rest(load_env())
    rest.run("finra-short-interest-sync", lambda: sync(rest, args.settlements, args.force))


if __name__ == "__main__":
    main()
