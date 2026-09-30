"""
Publish research results from the local warehouse to Supabase for the web
UI's Research page and the symbol-page catalyst timeline.

  research_catalyst_types   every type's label, description, verdict
  research_catalyst_tests   the latest FULL harness run (the run that
                            tested the most types, so q values are the
                            family-wide ones) plus any holdout rows
  research_catalyst_events  rolling --days window of catalyst events
                            (minus firehose types: news_any, generic form4,
                            cash dividends); older rows are deleted
  research_studies          the study write-ups in docs/, as Markdown
  research_reddit_daily     per-symbol daily mention counts (ApeWisdom
                            snapshots of r/pennystocks, r/stocks,
                            r/wallstreetbets), once the collector has data

Writes with the service role over PostgREST (SUPABASE_URL,
SUPABASE_SERVICE_ROLE_KEY from .env). Touches only research_* tables.

    research/.venv/bin/python research/publish_research.py [--days 365]
"""
import argparse
import datetime as dt
import json
import math
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

import duckdb

RESEARCH = Path(__file__).resolve().parent
REPO = RESEARCH.parent
CAT = RESEARCH / "data" / "catalysts"
sys.path.insert(0, str(RESEARCH / "catalysts"))
from catalog import LABELS, OVERRIDES  # noqa: E402

SKIP_TYPES = ("news_any", "form4", "ca_cash_dividends")
STUDIES = [
    ("catalyst-harness", "Catalyst harness", "docs/catalyst-harness.md", 1),
    ("filing-state", "Dilution & filing state", "docs/filing-state-study.md", 2),
    ("breakout", "Breakout-event study", "docs/breakout-study.md", 3),
]


class Rest:
    def __init__(self):
        self.base = os.environ["SUPABASE_URL"].rstrip("/") + "/rest/v1"
        key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        self.h = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}

    def call(self, method, table, params=None, body=None, prefer=None):
        url = f"{self.base}/{table}" + (f"?{urllib.parse.urlencode(params)}" if params else "")
        h = dict(self.h, **({"Prefer": prefer} if prefer else {}))
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, headers=h, method=method)
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status

    def upsert(self, table, rows, on_conflict, chunk=2000):
        for i in range(0, len(rows), chunk):
            self.call("POST", table, {"on_conflict": on_conflict}, rows[i:i + chunk],
                      "resolution=merge-duplicates,return=minimal")


def clean(v):
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    if isinstance(v, (dt.date, dt.datetime)):
        return v.isoformat()
    return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=365)
    args = ap.parse_args()
    rest = Rest()
    con = duckdb.connect()
    now = dt.datetime.now(dt.timezone.utc).isoformat()

    # --- tests: latest full run + holdout rows ---
    reg = CAT / "registry.duckdb"
    con.execute(f"attach '{reg}' as reg (read_only)")
    full = con.execute("""
      select run_ts from reg.tests where period = '2016-21' and h = 20
      group by run_ts order by count(distinct type) desc, run_ts desc limit 1
    """).fetchone()[0]
    cols = ["type", "period", "h", "run_ts", "n", "syms", "mean_x", "ci_lo", "ci_hi", "null_med", "p", "q",
            "candidate", "min_price", "max_price", "floor"]
    tests = con.execute(f"""
      select {', '.join(cols)} from reg.tests where run_ts = '{full}'
      union all
      select {', '.join(cols)} from (
        select *, row_number() over (partition by type, period, h order by run_ts desc) rk
        from reg.tests where period = '2022+') where rk = 1
    """).fetchall()
    trows = [{**{("horizon" if c == "h" else c): clean(v) for c, v in zip(cols, r)}, "updated_at": now} for r in tests]
    rest.upsert("research_catalyst_tests", trows, "type,period,horizon")
    print(f"tests: {len(trows)} rows from run {full}")

    # --- types: labels + verdicts ---
    disc = {r["type"]: r for r in trows if r["period"] == "2016-21" and r["horizon"] == 20}
    src_of = dict(con.execute(f"select type, any_value(source) from read_parquet('{CAT}/*.parquet', union_by_name=true) group by 1").fetchall())
    types = []
    for t, source in sorted(src_of.items()):
        label, desc = LABELS.get(t, (t, None))
        r = disc.get(t)
        if t in OVERRIDES:
            verdict, note = OVERRIDES[t]
        elif r is None:
            verdict, note = "untested", "Too few liquid events in 2016-21, or not yet run."
        elif r["candidate"]:
            gap = (r["mean_x"] or 0) - (r["null_med"] or 0)
            verdict = "avoid" if gap < 0 else "positive"
            note = f"Gap {gap * 100:+.2f}% vs random dates over 20 sessions, q {r['q']:.3f} (2016-21)."
        else:
            verdict, note = "none", "No separation from the same names at random dates."
        types.append({"type": t, "source": source, "label": label, "description": desc,
                      "verdict": verdict, "verdict_note": note, "updated_at": now})
    rest.upsert("research_catalyst_types", types, "type")
    print(f"types: {len(types)}")

    # --- events: rolling window ---
    since = dt.date.today() - dt.timedelta(days=args.days)
    skip = ", ".join(f"'{t}'" for t in SKIP_TYPES)
    ev = con.execute(f"""
      select symbol, event_date, max(event_ts) event_ts, source, type, left(any_value(detail), 300) detail
      from read_parquet('{CAT}/*.parquet', union_by_name=true)
      where event_date >= date '{since}' and event_date <= current_date and type not in ({skip})
      group by symbol, event_date, source, type
    """).fetchall()
    erows = [{"symbol": s, "event_date": clean(d), "event_ts": (ts.isoformat() + "Z") if ts else None,
              "source": so, "type": t, "detail": de} for s, d, ts, so, t, de in ev]
    rest.upsert("research_catalyst_events", erows, "symbol,event_date,source,type")
    rest.call("DELETE", "research_catalyst_events", {"event_date": f"lt.{since}"}, prefer="return=minimal")
    print(f"events: {len(erows):,} since {since}")

    # --- studies ---
    srows = [{"key": k, "title": title, "summary_md": (REPO / path).read_text(), "sort": sort, "updated_at": now}
             for k, title, path, sort in STUDIES if (REPO / path).exists()]
    rest.upsert("research_studies", srows, "key")
    print(f"studies: {len(srows)}")

    # --- reddit daily mentions ---
    rdb = CAT / "raw" / "reddit.duckdb"
    if rdb.exists():
        # ApeWisdom snapshots (reddit_collect.py): each day's LAST snapshot of
        # the rolling 24-hour mention count, summed over the three subreddits;
        # `posts` carries how many of them ranked the ticker that day
        con.execute(f"attach '{rdb}' as rd (read_only)")
        rr = con.execute(f"""
          with last as (
            select subreddit, seen_at::date day, max(seen_at) ts from rd.ape_snapshots
            where seen_at >= current_date - interval {args.days} day group by 1, 2
          )
          select s.ticker, l.day, sum(s.mentions)::int, count(*)::int, sum(s.upvotes)::int, null
          from rd.ape_snapshots s join last l on l.subreddit = s.subreddit and l.ts = s.seen_at
          group by 1, 2
        """).fetchall()
        rest.upsert("research_reddit_daily", [{"symbol": a, "day": clean(b), "mentions": c, "posts": d,
                                               "score_sum": e, "comments_sum": f} for a, b, c, d, e, f in rr],
                    "symbol,day")
        print(f"reddit: {len(rr):,} symbol-days")


if __name__ == "__main__":
    main()
