"""
Forward-only Reddit attention collector, via ApeWisdom's free API
(https://apewisdom.io/api/) rather than Reddit's own: no Reddit account,
app or credentials, and no Reddit content is stored -- only per-ticker
numbers ApeWisdom already computes (rolling 24-hour mention counts, rank,
upvotes, and the same figures 24 hours earlier).

Subreddits: r/pennystocks, r/stocks, r/wallstreetbets.

Each run snapshots every ranked ticker in each subreddit (100 per page,
~11 requests) into research/data/catalysts/raw/reddit.duckdb:
  ape_snapshots (seen_at UTC, subreddit, ticker, rank, mentions, upvotes,
                 rank_24h_ago, mentions_24h_ago)

There is no history before the first run, so Reddit attention becomes a
testable catalyst only after months of snapshots. Hourly via launchd
(com.stackslash.reddit-collect).

    research/.venv/bin/python research/catalysts/reddit_collect.py
"""
import json
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import duckdb

RESEARCH = Path(__file__).resolve().parent.parent
DB = RESEARCH / "data" / "catalysts" / "raw" / "reddit.duckdb"
SUBREDDITS = ["pennystocks", "stocks", "wallstreetbets"]
API = "https://apewisdom.io/api/v1.0/filter/{sub}/page/{page}"


def fetch(sub, page):
    req = urllib.request.Request(API.format(sub=sub, page=page), headers={"User-Agent": "stackslash-research"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except Exception:
            time.sleep(2 ** attempt * 3)
    raise RuntimeError(f"ApeWisdom failed: {sub} page {page}")


def num(v):
    try:
        return int(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def main():
    DB.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(DB))
    con.execute("""create table if not exists ape_snapshots (seen_at timestamp, subreddit varchar, ticker varchar,
                   rank int, mentions int, upvotes int, rank_24h_ago int, mentions_24h_ago int)""")
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    total = 0
    for sub in SUBREDDITS:
        page, pages = 1, 1
        while page <= pages:
            d = fetch(sub, page)
            pages = num(d.get("pages")) or 1
            rows = [(now, sub, r["ticker"], num(r.get("rank")), num(r.get("mentions")), num(r.get("upvotes")),
                     num(r.get("rank_24h_ago")), num(r.get("mentions_24h_ago"))) for r in d.get("results", [])]
            con.executemany("insert into ape_snapshots values (?,?,?,?,?,?,?,?)", rows)
            total += len(rows)
            page += 1
            time.sleep(1)
    n = con.execute("select count(distinct seen_at), min(seen_at) from ape_snapshots").fetchone()
    print(f"{now:%Y-%m-%d %H:%M} UTC: {total} ticker rows; {n[0]} snapshots since {n[1]}")


if __name__ == "__main__":
    main()
