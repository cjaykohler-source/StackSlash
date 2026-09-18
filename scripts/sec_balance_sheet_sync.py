#!/usr/bin/env python
"""
Latest XBRL balance sheet for every active symbol, from SEC's per-company
companyfacts API (data.sec.gov/api/xbrl/companyfacts/CIK##########.json),
into Supabase `balance_sheet` (one row per symbol per period_end).

Free and keyless; SEC asks for a contact User-Agent (SEC_USER_AGENT in .env)
and at most 10 requests/second. ~5k symbols at 8/s is ~10-15 minutes.

The period is the latest end date of a 10-K/10-Q/20-F/40-F balance-sheet
fact (Assets, else equity); every other line item is read at that same end
date so the row is one consistent balance sheet. Shares outstanding and
public float come from the cover page (dei) with their own dates. USD only:
a foreign filer reporting in another currency is skipped.

Usage:
    research/.venv/bin/python scripts/sec_balance_sheet_sync.py [--limit N] [--tickers A,B]
"""

from __future__ import annotations

import argparse
import sys
import time
import requests

from localjobs import Rest, load_env, now_iso

FORMS = {"10-K", "10-K/A", "10-Q", "10-Q/A", "20-F", "20-F/A", "40-F", "40-F/A", "10-KT"}
MIN_INTERVAL = 0.125  # 8 req/s, under SEC's 10

# column -> concepts tried in order, (taxonomy, concept)
FIELDS = {
    "total_assets": [("us-gaap", "Assets"), ("ifrs-full", "Assets")],
    "total_liabilities": [("us-gaap", "Liabilities"), ("ifrs-full", "Liabilities")],
    "current_assets": [("us-gaap", "AssetsCurrent"), ("ifrs-full", "CurrentAssets")],
    "current_liabilities": [("us-gaap", "LiabilitiesCurrent"), ("ifrs-full", "CurrentLiabilities")],
    "cash": [
        ("us-gaap", "CashAndCashEquivalentsAtCarryingValue"),
        ("us-gaap", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"),
        ("us-gaap", "Cash"),
        ("ifrs-full", "CashAndCashEquivalents"),
    ],
    "short_term_debt": [
        ("us-gaap", "DebtCurrent"),
        ("us-gaap", "LongTermDebtCurrent"),
        ("us-gaap", "ShortTermBorrowings"),
        ("us-gaap", "ConvertibleNotesPayableCurrent"),
        ("us-gaap", "NotesPayableCurrent"),
        ("ifrs-full", "CurrentBorrowings"),
    ],
    "long_term_debt": [
        ("us-gaap", "LongTermDebtNoncurrent"),
        ("us-gaap", "LongTermNotesPayable"),
        ("us-gaap", "ConvertibleLongTermNotesPayable"),
        ("us-gaap", "LongTermDebt"),
        ("ifrs-full", "NoncurrentBorrowings"),
    ],
    "stockholders_equity": [
        ("us-gaap", "StockholdersEquity"),
        ("us-gaap", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"),
        ("ifrs-full", "Equity"),
    ],
}


class Sec:
    def __init__(self, ua: str):
        self.s = requests.Session()
        self.s.headers.update({"User-Agent": ua, "Accept-Encoding": "gzip"})
        self.last = 0.0

    def get(self, url: str):
        for attempt in range(4):
            wait = MIN_INTERVAL - (time.monotonic() - self.last)
            if wait > 0:
                time.sleep(wait)
            self.last = time.monotonic()
            r = self.s.get(url, timeout=60)
            if r.status_code == 404:
                return None
            if r.status_code in (429, 503):
                time.sleep(10 * (attempt + 1))
                continue
            r.raise_for_status()
            return r.json()
        raise RuntimeError(f"SEC kept throttling {url}")


def observations(facts: dict, tax: str, concept: str, unit: str) -> list[dict]:
    return [o for o in (facts.get(tax, {}).get(concept, {}).get("units", {}).get(unit) or [])
            if o.get("form") in FORMS and o.get("end")]


def at_end(facts: dict, choices, end: str):
    """Value at period end `end` from the first concept that has one (latest filing wins)."""
    for tax, concept in choices:
        hits = [o for o in observations(facts, tax, concept, "USD") if o["end"] == end]
        if hits:
            return max(hits, key=lambda o: o.get("filed", ""))
    return None


def latest_dei(facts: dict, concept: str, unit: str):
    obs = [o for o in (facts.get("dei", {}).get(concept, {}).get("units", {}).get(unit) or []) if o.get("end")]
    return max(obs, key=lambda o: (o["end"], o.get("filed", ""))) if obs else None


def balance_sheet_row(symbol_id: int, cik: int, facts: dict) -> dict | None:
    anchor_obs = []
    for choices in (FIELDS["total_assets"], FIELDS["stockholders_equity"]):
        for tax, concept in choices:
            anchor_obs = observations(facts, tax, concept, "USD")
            if anchor_obs:
                break
        if anchor_obs:
            break
    if not anchor_obs:
        return None
    end = max(o["end"] for o in anchor_obs)
    meta = max((o for o in anchor_obs if o["end"] == end), key=lambda o: o.get("filed", ""))
    row = {
        "symbol_id": symbol_id, "cik": cik, "period_end": end,
        "form": meta.get("form"), "filed": meta.get("filed"), "accession": meta.get("accn"),
        "updated_at": now_iso(),
    }
    for col, choices in FIELDS.items():
        hit = at_end(facts, choices, end)
        row[col] = hit["val"] if hit else None
    if row["total_liabilities"] is None and row["stockholders_equity"] is not None:
        # Many small filers tag only the balance-sheet total and equity.
        total = at_end(facts, [("us-gaap", "LiabilitiesAndStockholdersEquity")], end)
        if total:
            row["total_liabilities"] = total["val"] - row["stockholders_equity"]
    shares = latest_dei(facts, "EntityCommonStockSharesOutstanding", "shares")
    row["shares_outstanding"] = shares["val"] if shares else None
    row["shares_outstanding_date"] = shares["end"] if shares else None
    flt = latest_dei(facts, "EntityPublicFloat", "USD")
    row["public_float_usd"] = flt["val"] if flt else None
    row["public_float_date"] = flt["end"] if flt else None
    return row


def sync(rest: Rest, sec: Sec, tickers: str | None, limit: int | None) -> int:
    ciks = {t["ticker"].upper(): int(t["cik_str"])
            for t in sec.get("https://www.sec.gov/files/company_tickers.json").values()}
    symbols = rest.active_symbols()
    if tickers:
        wanted = {t.strip().upper() for t in tickers.split(",")}
        symbols = [s for s in symbols if s["ticker"].upper() in wanted]
    if limit:
        symbols = symbols[:limit]

    rows, written, no_cik, no_facts = [], 0, 0, 0
    for i, s in enumerate(symbols, 1):
        cik = ciks.get(s["ticker"].upper().replace(".", "-"))
        if cik is None:
            no_cik += 1
            continue
        doc = sec.get(f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json")
        row = balance_sheet_row(s["id"], cik, (doc or {}).get("facts", {}))
        if row is None:
            no_facts += 1
        else:
            rows.append(row)
        if len(rows) >= 200:
            rest.upsert("balance_sheet", rows, "symbol_id,period_end")
            written += len(rows)
            rows = []
        if i % 250 == 0:
            print(f"{i}/{len(symbols)} written={written + len(rows)} no_cik={no_cik} no_facts={no_facts}", flush=True)
    rest.upsert("balance_sheet", rows, "symbol_id,period_end")
    written += len(rows)
    print(f"done: {len(symbols)} symbols, {written} rows, no_cik={no_cik}, no_usd_facts={no_facts}")
    return written


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int)
    ap.add_argument("--tickers")
    args = ap.parse_args()
    env = load_env()
    ua = env.get("SEC_USER_AGENT") or sys.exit("SEC_USER_AGENT missing from .env")
    rest = Rest(env)
    rest.run("sec-balance-sheet-sync", lambda: sync(rest, Sec(ua), args.tickers, args.limit))


if __name__ == "__main__":
    main()
