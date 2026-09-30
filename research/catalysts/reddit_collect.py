"""
Forward-only Reddit collector for retail-attention catalysts.

Reddit's API serves recent listings only and Pushshift's archive is
restricted, so there is no backfill: every run stores whatever is new, and
a Reddit catalyst becomes testable only once months of history exist.

Each run pulls /new (up to 1,000 posts) and /hot from each subreddit in
SUBREDDITS, extracts tickers, and upserts into
research/data/catalysts/raw/reddit.duckdb:
  posts     one row per post (first-seen title/body snippet, created time)
  snapshots score and comment count every time a post is seen (attention
            growth, not just the final number)
  mentions  (post id, symbol) pairs

Ticker extraction: $CASHTAGS always count; bare ALL-CAPS words count only
when they are a known SIP symbol and not in COMMON_WORDS (the usual
"I", "A", "CEO", "DD", "YOLO" false positives).

Auth: a Reddit "script" app (https://www.reddit.com/prefs/apps), app-only
OAuth, read-only. Needs REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET and
REDDIT_USER_AGENT (e.g. "stackslash-research/0.1 by <reddit username>")
in the environment. Rate limit ~100 requests/minute; one run is ~30.

    research/.venv/bin/python research/catalysts/reddit_collect.py
"""
import base64
import json
import os
import re
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import duckdb

RESEARCH = Path(__file__).resolve().parent.parent
DB = RESEARCH / "data" / "catalysts" / "raw" / "reddit.duckdb"
WAREHOUSE = RESEARCH / "data" / "stackslash.duckdb"

SUBREDDITS = ["pennystocks", "wallstreetbets", "smallstreetbets", "RobinHoodPennyStocks", "Shortsqueeze",
              "stocks", "StockMarket", "Daytrading", "Biotechplays", "Canadapennystocks", "WallStreetbetsELITE"]
COMMON_WORDS = set("""A I AM AN AND ARE AS AT BE BIG BUY BY CAN CEO CFO COO CTO DD DO EOD EPS ETF FDA FOR GO HAS HE
HOLD IF IMO IN IPO IS IT ITM LOL ME MY NEW NO NOT NOW OF OK ON ONE OR OTC OTM OUT PM PR PT RSI SEC SO SPAC THE TO TOS
UP US USA WE WSB YOLO ALL ANY ATH AI EV GDP CPI FED IRS OPEN NEXT LOW HIGH BEST REAL VERY LONG GOOD CASH FREE""".split())
CASHTAG = re.compile(r"\$([A-Z]{1,5})\b")
BARE = re.compile(r"\b([A-Z]{2,5})\b")


def token():
    cid, sec = os.environ["REDDIT_CLIENT_ID"], os.environ["REDDIT_CLIENT_SECRET"]
    req = urllib.request.Request("https://www.reddit.com/api/v1/access_token",
                                 data=b"grant_type=client_credentials",
                                 headers={"Authorization": "Basic " + base64.b64encode(f"{cid}:{sec}".encode()).decode(),
                                          "User-Agent": os.environ["REDDIT_USER_AGENT"]})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)["access_token"]


def listing(tok, sub, kind, after=None):
    q = {"limit": 100, "raw_json": 1, **({"after": after} if after else {})}
    req = urllib.request.Request(f"https://oauth.reddit.com/r/{sub}/{kind}?{urllib.parse.urlencode(q)}",
                                 headers={"Authorization": f"bearer {tok}", "User-Agent": os.environ["REDDIT_USER_AGENT"]})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                remaining = float(r.headers.get("x-ratelimit-remaining") or 100)
                body = json.load(r)
            if remaining < 5:
                time.sleep(float(r.headers.get("x-ratelimit-reset") or 60))
            return body["data"]
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503):
                time.sleep(2 ** attempt * 5)
                continue
            raise
    raise RuntimeError(f"reddit listing failed: r/{sub}/{kind}")


def tickers(text, known):
    found = set(CASHTAG.findall(text))
    found |= {w for w in BARE.findall(text) if w in known and w not in COMMON_WORDS}
    return found


def main():
    DB.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(DB))
    con.execute("""create table if not exists posts (id varchar primary key, subreddit varchar, created_utc timestamp,
                   author varchar, title varchar, body varchar, flair varchar, url varchar, first_seen timestamp)""")
    con.execute("""create table if not exists snapshots (id varchar, seen_at timestamp, listing varchar,
                   score int, upvote_ratio double, num_comments int)""")
    con.execute("create table if not exists mentions (id varchar, symbol varchar, primary key (id, symbol))")
    wh = duckdb.connect(str(WAREHOUSE), read_only=True)
    known = {r[0] for r in wh.execute(
        "select distinct symbol from sip_bars_daily_raw where date >= current_date - interval 30 day").fetchall()}
    wh.close()

    tok = token()
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    new_posts = 0
    for sub in SUBREDDITS:
        for kind, pages in (("new", 10), ("hot", 1)):
            after = None
            for _ in range(pages):
                data = listing(tok, sub, kind, after)
                children = [c["data"] for c in data.get("children", [])]
                if not children:
                    break
                stop = False
                for p in children:
                    pid = p["id"]
                    exists = con.execute("select 1 from posts where id = ?", [pid]).fetchone()
                    if not exists:
                        body = (p.get("selftext") or "")[:4000]
                        con.execute("insert into posts values (?,?,?,?,?,?,?,?,?)",
                                    [pid, sub, datetime.fromtimestamp(p["created_utc"], timezone.utc).replace(tzinfo=None),
                                     p.get("author"), p.get("title"), body, p.get("link_flair_text"), p.get("url"), now])
                        for s in tickers(f"{p.get('title', '')} {body}", known):
                            con.execute("insert or ignore into mentions values (?, ?)", [pid, s])
                        new_posts += 1
                    elif kind == "new":
                        stop = True  # reached posts already stored on a previous run
                    con.execute("insert into snapshots values (?,?,?,?,?,?)",
                                [pid, now, kind, p.get("score"), p.get("upvote_ratio"), p.get("num_comments")])
                after = data.get("after")
                if stop or not after:
                    break
    total = con.execute("select count(*), min(created_utc) from posts").fetchone()
    print(f"{now:%Y-%m-%d %H:%M} UTC: +{new_posts} posts; {total[0]:,} stored since {total[1]}")


if __name__ == "__main__":
    main()
