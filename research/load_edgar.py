#!/usr/bin/env python
"""
Load SEC EDGAR bulk data (research/data/edgar/submissions.zip and
companyfacts.zip, downloaded from sec.gov) into Parquet tables beside it:

  edgar_companies.parquet  one row per company: CIK, name, current tickers
                           and exchanges, SIC, entity type, state, former
                           names
  edgar_tickers.parquet    (ticker, exchange, cik) for every current ticker
  edgar_filings.parquet    every filing for those companies, recent AND the
                           older overflow pages: form, filing/report dates,
                           acceptance time, 8-K items, primary document
  edgar_facts.parquet      selected XBRL facts, long format: shares
                           outstanding, public float, cash, net income,
                           revenue, stockholders' equity, operating cash flow

Why it matters for the sub-$5 band: dilution drives these names.
S-1/S-3/424B* filings date share offerings, shares outstanding shows the
dilution actually landing, and cash plus operating cash flow give burn and
runway, the reason an offering is coming.

WHICH COMPANIES: submissions.zip covers every SEC filer, individuals and
funds included (~984k). Kept: any filer with a current ticker, plus any
CIK present in companyfacts.zip, meaning it has filed XBRL financials.
The second group is what keeps delisted companies, whose ticker list is
now empty, so the research universe's survivorship fix carries over.

POINT IN TIME: every fact keeps `filed`, the date the number became
public. Research must join on `filed`, never on period `end`, or it will
use numbers before anyone could have seen them.

Parquet, not the main DuckDB warehouse, so the schema lab can keep reading
the warehouse while this runs (DuckDB allows one writer per file).

Usage:
    research/.venv/bin/python research/load_edgar.py
"""

from __future__ import annotations

import json
import time
import zipfile
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

REPO = Path(__file__).resolve().parent.parent
EDGAR = REPO / "research" / "data" / "edgar"
SUBMISSIONS = EDGAR / "submissions.zip"
FACTS = EDGAR / "companyfacts.zip"
BATCH = 2_000  # companies per Parquet row group

# (taxonomy, concept) pairs kept from companyfacts.
CONCEPTS = [
    ("dei", "EntityCommonStockSharesOutstanding"),
    ("dei", "EntityPublicFloat"),
    ("us-gaap", "CommonStockSharesOutstanding"),
    ("us-gaap", "WeightedAverageNumberOfSharesOutstandingBasic"),
    ("us-gaap", "CashAndCashEquivalentsAtCarryingValue"),
    ("us-gaap", "NetIncomeLoss"),
    ("us-gaap", "Revenues"),
    ("us-gaap", "RevenueFromContractWithCustomerExcludingAssessedTax"),
    ("us-gaap", "StockholdersEquity"),
    ("us-gaap", "NetCashProvidedByUsedInOperatingActivities"),
]

COMPANY_SCHEMA = pa.schema([
    ("cik", pa.int64()), ("name", pa.string()), ("tickers", pa.list_(pa.string())),
    ("exchanges", pa.list_(pa.string())), ("sic", pa.string()), ("sic_description", pa.string()),
    ("entity_type", pa.string()), ("category", pa.string()), ("state_of_incorporation", pa.string()),
    ("fiscal_year_end", pa.string()), ("former_names", pa.string()), ("has_xbrl_facts", pa.bool_()),
])
TICKER_SCHEMA = pa.schema([("ticker", pa.string()), ("exchange", pa.string()), ("cik", pa.int64())])
FILING_SCHEMA = pa.schema([
    ("cik", pa.int64()), ("accession", pa.string()), ("form", pa.string()),
    ("filing_date", pa.string()), ("report_date", pa.string()), ("acceptance_datetime", pa.string()),
    ("items", pa.string()), ("primary_document", pa.string()), ("primary_doc_description", pa.string()),
    ("size", pa.int64()), ("is_xbrl", pa.bool_()),
])
FACT_SCHEMA = pa.schema([
    ("cik", pa.int64()), ("taxonomy", pa.string()), ("concept", pa.string()), ("unit", pa.string()),
    ("start", pa.string()), ("end", pa.string()), ("val", pa.float64()), ("form", pa.string()),
    ("filed", pa.string()), ("fy", pa.int64()), ("fp", pa.string()), ("accn", pa.string()), ("frame", pa.string()),
])


def cik_of(filename: str) -> int:
    return int(filename[3:13])


def filing_rows(cik: int, block: dict) -> list[dict]:
    """Columnar filings block (recent or an overflow page) -> rows."""
    forms = block.get("form") or []
    col = lambda k: block.get(k) or [None] * len(forms)
    acc, fd, rd, adt, items, pdoc, pdesc, size, xbrl = (
        col("accessionNumber"), col("filingDate"), col("reportDate"), col("acceptanceDateTime"),
        col("items"), col("primaryDocument"), col("primaryDocDescription"), col("size"), col("isXBRL"),
    )
    return [
        {
            "cik": cik, "accession": acc[i], "form": forms[i], "filing_date": fd[i] or None,
            "report_date": rd[i] or None, "acceptance_datetime": adt[i] or None, "items": items[i] or None,
            "primary_document": pdoc[i] or None, "primary_doc_description": pdesc[i] or None,
            "size": int(size[i]) if size[i] not in (None, "") else None,
            "is_xbrl": bool(xbrl[i]) if xbrl[i] not in (None, "") else None,
        }
        for i in range(len(forms))
    ]


class Sink:
    """Batched Parquet writer (write-then-rename on close)."""

    def __init__(self, name: str, schema: pa.Schema):
        self.path = EDGAR / f"{name}.parquet"
        self.tmp = self.path.with_suffix(".parquet.tmp")
        self.schema = schema
        self.writer = pq.ParquetWriter(self.tmp, schema, compression="zstd")
        self.buf: list[dict] = []
        self.rows = 0

    def add(self, rows: list[dict]):
        self.buf.extend(rows)
        if len(self.buf) >= 200_000:
            self.flush()

    def flush(self):
        if self.buf:
            self.writer.write_table(pa.Table.from_pylist(self.buf, schema=self.schema))
            self.rows += len(self.buf)
            self.buf = []

    def close(self):
        self.flush()
        self.writer.close()
        self.tmp.rename(self.path)
        return self.rows


def main():
    t0 = time.time()
    fz = zipfile.ZipFile(FACTS)
    fact_ciks = {cik_of(i.filename) for i in fz.infolist() if i.filename.startswith("CIK")}
    print(f"companyfacts: {len(fact_ciks):,} companies with XBRL facts", flush=True)

    sz = zipfile.ZipFile(SUBMISSIONS)
    names = {i.filename for i in sz.infolist()}
    mains = sorted(n for n in names if n.startswith("CIK") and "-submissions-" not in n)

    companies = Sink("edgar_companies", COMPANY_SCHEMA)
    tickers = Sink("edgar_tickers", TICKER_SCHEMA)
    filings = Sink("edgar_filings", FILING_SCHEMA)
    kept = 0
    for n, fname in enumerate(mains, 1):
        cik = cik_of(fname)
        s = json.loads(sz.read(fname))
        tks = s.get("tickers") or []
        if not tks and cik not in fact_ciks:
            continue  # individuals, funds, shells with neither a ticker nor financials
        kept += 1
        exs = s.get("exchanges") or []
        companies.add([{
            "cik": cik, "name": s.get("name"), "tickers": tks, "exchanges": exs,
            "sic": s.get("sic") or None, "sic_description": s.get("sicDescription") or None,
            "entity_type": s.get("entityType") or None, "category": s.get("category") or None,
            "state_of_incorporation": s.get("stateOfIncorporation") or None,
            "fiscal_year_end": s.get("fiscalYearEnd") or None,
            "former_names": json.dumps(s.get("formerNames") or []), "has_xbrl_facts": cik in fact_ciks,
        }])
        tickers.add([
            {"ticker": t, "exchange": exs[i] if i < len(exs) else None, "cik": cik} for i, t in enumerate(tks)
        ])
        fil = s.get("filings") or {}
        filings.add(filing_rows(cik, fil.get("recent") or {}))
        for extra in fil.get("files") or []:
            if extra.get("name") in names:
                filings.add(filing_rows(cik, json.loads(sz.read(extra["name"]))))
        if n % 50_000 == 0:
            print(f"  submissions {n:,}/{len(mains):,} scanned, {kept:,} companies kept, "
                  f"{filings.rows + len(filings.buf):,} filings ({(time.time() - t0) / 60:.1f}m)", flush=True)
    print(f"edgar_companies: {companies.close():,} | edgar_tickers: {tickers.close():,} | "
          f"edgar_filings: {filings.close():,}  ({(time.time() - t0) / 60:.1f}m)", flush=True)

    facts = Sink("edgar_facts", FACT_SCHEMA)
    for n, info in enumerate(i for i in fz.infolist() if i.filename.startswith("CIK")):
        cik = cik_of(info.filename)
        tree = (json.loads(fz.read(info.filename)).get("facts") or {})
        rows = []
        for tax, concept in CONCEPTS:
            for unit, obs in (tree.get(tax, {}).get(concept, {}).get("units") or {}).items():
                for o in obs:
                    try:
                        val = float(o["val"])
                    except (KeyError, TypeError, ValueError):
                        continue
                    rows.append({
                        "cik": cik, "taxonomy": tax, "concept": concept, "unit": unit,
                        "start": o.get("start"), "end": o.get("end"), "val": val, "form": o.get("form"),
                        "filed": o.get("filed"), "fy": int(o["fy"]) if o.get("fy") is not None else None,
                        "fp": o.get("fp"), "accn": o.get("accn"), "frame": o.get("frame"),
                    })
        facts.add(rows)
        if (n + 1) % 5_000 == 0:
            print(f"  companyfacts {n + 1:,}/{len(fact_ciks):,}, {facts.rows + len(facts.buf):,} facts "
                  f"({(time.time() - t0) / 60:.1f}m)", flush=True)
    print(f"edgar_facts: {facts.close():,}  (total {(time.time() - t0) / 60:.1f}m)", flush=True)


if __name__ == "__main__":
    main()
