"""
Resumable local backfill of FINRA short-selling data for the breakout
feature table (research/breakout_features_v2.py). Free, keyless sources;
history limits were probed 2026-09-30.

  si   consolidated short interest, every settlement 2018-01 onward
       (api.finra.org; earlier dates return nothing). Twice a month;
       FINRA publishes ~7-8 business days after settlement, so consumers
       must join on a publication date, never the settlement date.
       -> research/data/catalysts/raw/short_interest/<settlement>.parquet
  vol  Reg SHO daily short-sale volume, every trading day 2018-08-01 onward
       (cdn.finra.org; earlier files are 403). Shares sold short that day,
       NOT the open short position.
       -> research/data/catalysts/raw/short_volume/<YYYY-MM>.parquet

A finished settlement / month is never re-fetched unless --refresh (the
current and previous month always are).

    research/.venv/bin/python research/catalysts/short_backfill.py si|vol [--refresh]
"""
import datetime as dt
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

RESEARCH = Path(__file__).resolve().parent.parent
RAW = RESEARCH / "data" / "catalysts" / "raw"
WAREHOUSE = RESEARCH / "data" / "stackslash.duckdb"
SI_URL = "https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest"
VOL_URL = "https://cdn.finra.org/equity/regsho/daily/CNMSshvol{d}.txt"
UA = {"User-Agent": "stackslash-research", "Accept": "application/json"}


def si_page(day, limit, offset):
    body = json.dumps({"limit": limit, "offset": offset,
                       "compareFilters": [{"compareType": "EQUAL", "fieldName": "settlementDate", "fieldValue": day}]}).encode()
    for attempt in range(6):
        try:
            req = urllib.request.Request(SI_URL, data=body, method="POST", headers=dict(UA, **{"Content-Type": "application/json"}))
            with urllib.request.urlopen(req, timeout=120) as r:
                t = r.read()
            return json.loads(t) if t.strip() else []
        except Exception:
            time.sleep(2 ** attempt)
    raise RuntimeError(f"FINRA short interest failed: {day} offset {offset}")


def si(refresh):
    out = RAW / "short_interest"
    out.mkdir(parents=True, exist_ok=True)
    done = {p.stem for p in out.glob("*.parquet")}
    today = dt.date.today()
    m = dt.date(2018, 1, 1)
    while m <= today:
        # one settlement near mid-month, one near month end
        for window in (range(9, 19), range(24, 32)):
            days = []
            for d in window:
                try:
                    x = m.replace(day=d)
                except ValueError:
                    continue
                if x.weekday() < 5 and x <= today:
                    days.append(x)
            if any(x.isoformat() in done for x in days) and not refresh:
                continue
            for x in days:
                first = si_page(x.isoformat(), 5000, 0)
                if not first:
                    continue
                rows, offset, page = list(first), 5000, first
                while len(page) == 5000:
                    page = si_page(x.isoformat(), 5000, offset)
                    rows += page
                    offset += 5000
                pq.write_table(pa.table({
                    "symbol": [(r.get("symbolCode") or "").upper() for r in rows],
                    "settlement_date": pa.array([x] * len(rows), pa.date32()),
                    "short_interest": [r.get("currentShortPositionQuantity") for r in rows],
                    "prev_short_interest": [r.get("previousShortPositionQuantity") for r in rows],
                    "avg_daily_volume": [r.get("averageDailyVolumeQuantity") for r in rows],
                    "days_to_cover": [r.get("daysToCoverQuantity") for r in rows],
                    "market": [r.get("marketClassCode") for r in rows],
                }), out / f"{x.isoformat()}.parquet")
                print(f"si {x}: {len(rows):,} rows", flush=True)
                break
        m = (m.replace(day=28) + dt.timedelta(days=4)).replace(day=1)


def vol(refresh):
    out = RAW / "short_volume"
    out.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(WAREHOUSE), read_only=True)
    days = [r[0] for r in con.execute(
        "select distinct date from sip_bars_daily_raw where symbol = 'SPY' and date >= date '2018-08-01' order by 1").fetchall()]
    con.close()
    this = dt.date.today().replace(day=1)
    prev = (this - dt.timedelta(days=1)).replace(day=1)
    by_month = {}
    for d in days:
        by_month.setdefault(d.replace(day=1), []).append(d)
    for month, ds in sorted(by_month.items()):
        path = out / f"{month:%Y-%m}.parquet"
        if path.exists() and not refresh and month < prev:
            continue
        sym, date, sv, sev, tv = [], [], [], [], []
        for d in ds:
            u = VOL_URL.format(d=d.strftime("%Y%m%d"))
            text = None
            for attempt in range(5):
                try:
                    with urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=60) as r:
                        text = r.read().decode()
                    break
                except urllib.error.HTTPError as e:
                    if e.code in (403, 404):
                        break
                    time.sleep(2 ** attempt)
                except Exception:
                    time.sleep(2 ** attempt)
            if not text:
                print(f"vol {d}: missing", flush=True)
                continue
            for line in text.splitlines()[1:]:
                p = line.split("|")
                if len(p) < 5 or not p[0].isdigit():
                    continue
                try:
                    sym.append(p[1])
                    date.append(d)
                    sv.append(float(p[2]))
                    sev.append(float(p[3]))
                    tv.append(float(p[4]))
                except ValueError:
                    sym.pop(); date.pop()
            time.sleep(0.1)
        pq.write_table(pa.table({"symbol": sym, "date": pa.array(date, pa.date32()), "short_volume": sv,
                                 "short_exempt_volume": sev, "total_volume": tv}), path)
        print(f"vol {month:%Y-%m}: {len(sym):,} rows over {len(ds)} days", flush=True)


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    refresh = "--refresh" in sys.argv
    {"si": si, "vol": vol}[mode](refresh)
