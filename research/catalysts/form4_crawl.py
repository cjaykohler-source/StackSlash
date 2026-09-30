"""
Resumable Form 4 fetch-and-parse, so insider activity can be split into
open-market buys (code P) vs sales (S) vs grants/exercises/tax (A/M/F...).
The headline-only insider-buy signal (docs/catalyst-harness.md) was the
largest positive effect but n=379; this is the full sample.

Scope: Form 4s filed 2016+ for issuers that had a harness-eligible session
(raw close --min-price..--max-price, 20-day dollar volume >= --floor)
within 5 sessions of the filing -- no point fetching filings the harness
would drop.

Fetches https://www.sec.gov/Archives/edgar/data/<cik>/<accession>/<xml>
(the raw XML beside EDGAR's xsl-rendered primary document) at <= 8
requests/second with SEC_USER_AGENT, parses every non-derivative
transaction and every reporting owner's role, and stores them in
research/data/catalysts/raw/form4.duckdb:
  tx    (accession, cik, filing_date, owner_cik, owner, is_director,
         is_officer, officer_title, is_ten_pct, code, shares, price, acq_disp)
  done  (accession, status) -- a finished accession is never re-fetched

    research/.venv/bin/python research/catalysts/form4_crawl.py [--limit N]
"""
import argparse
import os
import threading
import time
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import duckdb

RESEARCH = Path(__file__).resolve().parent.parent
EDGAR = RESEARCH / "data" / "edgar"
WAREHOUSE = RESEARCH / "data" / "stackslash.duckdb"
DB = RESEARCH / "data" / "catalysts" / "raw" / "form4.duckdb"
RATE = 8.0  # requests/second, under SEC's 10


class Limiter:
    def __init__(self, rate):
        self.gap, self.next, self.lock = 1.0 / rate, time.time(), threading.Lock()

    def wait(self):
        with self.lock:
            now = time.time()
            t = max(now, self.next)
            self.next = t + self.gap
        time.sleep(max(0.0, t - now))


def targets(min_price, max_price, floor):
    e = str(EDGAR)
    con = duckdb.connect()
    con.execute(f"attach '{WAREHOUSE}' as wh (read_only)")
    return con.execute(f"""
      with tc as (
        select distinct ticker, cik from (
          select ticker, cik from read_parquet('{e}/edgar_tickers.parquet')
          union select unnest(tickers) ticker, cik from read_parquet('{e}/edgar_companies.parquet'))
      ),
      g as (
        select r.symbol, r.date from (
          select symbol, date, close,
                 avg(close * volume) over (partition by symbol order by date rows between 19 preceding and current row) d20
          from wh.sip_bars_daily_raw where date >= date '2015-12-01') r
        where r.close between {min_price} and {max_price} and r.d20 >= {floor}
      ),
      f as (
        select fl.cik, fl.accession, fl.filing_date::date fd, fl.primary_document doc
        from read_parquet('{e}/edgar_filings.parquet') fl
        where fl.form = '4' and fl.filing_date >= '2016-01-01'
      )
      select distinct f.cik, f.accession, f.fd, f.doc
      from f join tc on tc.cik = f.cik
      where exists (select 1 from g where g.symbol = tc.ticker and g.date between f.fd - 7 and f.fd + 7)
      order by f.fd
    """).fetchall()


def txt(node, path):
    x = node.find(path)
    return x.text.strip() if x is not None and x.text else None


def num(node, path):
    v = txt(node, path)
    try:
        return float(v) if v is not None else None
    except ValueError:
        return None


def flag(node, path):
    return (txt(node, path) or "").lower() in ("1", "true")


def parse(xml_bytes):
    root = ET.fromstring(xml_bytes)
    owners = []
    for ro in root.findall("reportingOwner"):
        rel = ro.find("reportingOwnerRelationship")
        owners.append((txt(ro, "reportingOwnerId/rptOwnerCik"), txt(ro, "reportingOwnerId/rptOwnerName"),
                       flag(rel, "isDirector") if rel is not None else False,
                       flag(rel, "isOfficer") if rel is not None else False,
                       txt(rel, "officerTitle") if rel is not None else None,
                       flag(rel, "isTenPercentOwner") if rel is not None else False))
    owner = owners[0] if owners else (None, None, False, False, None, False)
    rows = []
    for t in root.findall("nonDerivativeTable/nonDerivativeTransaction"):
        rows.append((*owner, txt(t, "transactionCoding/transactionCode"),
                     num(t, "transactionAmounts/transactionShares/value"),
                     num(t, "transactionAmounts/transactionPricePerShare/value"),
                     txt(t, "transactionAmounts/transactionAcquiredDisposedCode/value")))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-price", type=float, default=0.10)
    ap.add_argument("--max-price", type=float, default=15.0)
    ap.add_argument("--floor", type=float, default=250_000)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()
    ua = os.environ["SEC_USER_AGENT"]

    DB.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(DB))
    con.execute("""create table if not exists tx (accession varchar, cik bigint, filing_date date, owner_cik varchar,
                   owner varchar, is_director boolean, is_officer boolean, officer_title varchar, is_ten_pct boolean,
                   code varchar, shares double, price double, acq_disp varchar)""")
    con.execute("create table if not exists done (accession varchar primary key, status varchar)")
    done = {r[0] for r in con.execute("select accession from done").fetchall()}

    print("selecting target filings...", flush=True)
    todo = [t for t in targets(args.min_price, args.max_price, args.floor) if t[1] not in done]
    if args.limit:
        todo = todo[: args.limit]
    print(f"{len(todo):,} Form 4s to fetch ({len(done):,} already done)", flush=True)

    lim, lock = Limiter(RATE), threading.Lock()
    counts = {"ok": 0, "err": 0}

    def work(t):
        cik, acc, fd, doc = t
        name = (doc or "").split("/")[-1] or "form4.xml"
        url = f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc.replace('-', '')}/{name}"
        status, rows = "ok", []
        for attempt in range(5):
            lim.wait()
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": ua}), timeout=30) as r:
                    rows = parse(r.read())
                break
            except urllib.error.HTTPError as ex:
                if ex.code in (429, 500, 502, 503):
                    time.sleep(2 ** attempt * 2)
                    continue
                status = f"http{ex.code}"
                break
            except ET.ParseError:
                status = "parse_error"
                break
            except Exception:
                time.sleep(2 ** attempt)
        else:
            status = "failed"
        with lock:
            if rows:
                con.executemany("insert into tx values (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                                [(acc, cik, fd, *row) for row in rows])
            con.execute("insert or replace into done values (?, ?)", [acc, status])
            counts["ok" if status == "ok" else "err"] += 1
            n = counts["ok"] + counts["err"]
            if n % 5000 == 0:
                print(f"  {n:,}/{len(todo):,} ({counts['err']:,} errors)", flush=True)

    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(work, todo))
    print(f"done: {counts['ok']:,} ok, {counts['err']:,} errors", flush=True)


if __name__ == "__main__":
    main()
