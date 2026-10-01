"""
Catalyst source adapters. Each writes one parquet of point-in-time events
to research/data/catalysts/<source>.parquet with a shared schema:

  symbol      ticker as traded in the SIP warehouse
  event_date  date the event became public (filing date, ex-date, ...)
  event_ts    exact public timestamp when the source has one (UTC), else null
  source      'edgar' | 'corporate_actions' | ...
  type        catalyst type, the unit the harness tests (e.g. 8k_1.01)
  detail      free text for spot-checking (form, items, rate, ...)

The harness never enters before the first session strictly AFTER
event_date, so a same-day timestamp can't leak.

    research/.venv/bin/python research/catalysts/sources.py [edgar corporate_actions]
"""
import datetime as dt
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

RESEARCH = Path(__file__).resolve().parent.parent
DATA = RESEARCH / "data"
EDGAR = DATA / "edgar"
CA = DATA / "corporate_actions"
OUT = DATA / "catalysts"
RAW = OUT / "raw"
DOLT = "https://www.dolthub.com/api/v1alpha1/post-no-preference/earnings/master"

# 8-K items worth testing as their own catalyst (9.01 exhibits is filler)
ITEMS_8K = ["1.01", "1.02", "1.03", "2.01", "2.02", "2.03", "2.04", "2.05", "2.06",
            "3.01", "3.02", "3.03", "4.01", "4.02", "5.01", "5.02", "5.03", "5.07", "7.01", "8.01"]
# forms tested as a catalyst type (amendments folded into their base form)
FORMS = {
    "SC 13D": "13d_new", "SCHEDULE 13D": "13d_new", "SC 13D/A": "13d_amend", "SCHEDULE 13D/A": "13d_amend",
    "SC 13G": "13g_new", "SCHEDULE 13G": "13g_new", "SC 13G/A": "13g_amend", "SCHEDULE 13G/A": "13g_amend",
    "4": "form4", "144": "form144",
    "S-1": "s1", "S-3": "s3", "F-1": "s1", "F-3": "s3", "S-8": "s8",
    "424B4": "424b4", "424B5": "424b5", "424B3": "424b3",
    "NT 10-Q": "nt_late_filing", "NT 10-K": "nt_late_filing",
    "10-Q": "10q", "10-K": "10k",
    "PRE 14A": "proxy_pre", "DEF 14A": "proxy_def", "PRE 14C": "info_stmt_pre",
    "425": "merger_425", "SC TO-T": "tender_offer", "SC 14D9": "tender_response",
    "25-NSE": "delisting_25", "15-12G": "deregistration", "15-12B": "deregistration",
    "EFFECT": "registration_effective",
}


def edgar(con):
    e = str(EDGAR)
    con.execute(f"""
      create or replace temp table ticker_cik as
      select ticker, cik from (
        select ticker, cik from read_parquet('{e}/edgar_tickers.parquet')
        union select unnest(tickers) ticker, cik from read_parquet('{e}/edgar_companies.parquet')
      )
    """)
    forms = ", ".join(f"('{k}', '{v}')" for k, v in FORMS.items())
    items = ", ".join(f"('{i}')" for i in ITEMS_8K)
    con.execute(f"""
      create or replace temp table ev as
      with f as (
        select cik, form, filing_date::date d, acceptance_datetime, items
        from read_parquet('{e}/edgar_filings.parquet') where filing_date >= '2015-06-01'
      ),
      by_form as (
        select f.cik, f.d, f.acceptance_datetime, m.t as type, f.form as detail
        from f join (values {forms}) m(form, t) on m.form = f.form
      ),
      by_item as (
        select f.cik, f.d, f.acceptance_datetime, '8k_' || i.item as type, f.items as detail
        from f join (values {items}) i(item) on f.form in ('8-K', '8-K/A') and list_contains(string_split(f.items, ','), i.item)
      )
      select tc.ticker as symbol, x.d as event_date,
             try_cast(replace(x.acceptance_datetime, 'Z', '') as timestamp) as event_ts,
             'edgar' as source, x.type, any_value(x.detail) as detail
      from (select * from by_form union all select * from by_item) x
      join ticker_cik tc on tc.cik = x.cik
      group by all
    """)
    return "ev"


def corporate_actions(con):
    con.execute(f"""
      create or replace temp table ev as
      select symbol, try_cast(ex_date as date) as event_date, null::timestamp as event_ts,
             'corporate_actions' as source, 'ca_' || type as type,
             concat_ws(' ', 'rate=' || rate, 'old=' || old_rate, 'new=' || new_rate) as detail
      from read_parquet('{CA}/*.parquet')
      where symbol is not null and try_cast(ex_date as date) is not null
    """)
    return "ev"


def dolt_query(sql):
    hdr = {"Accept": "application/json", "User-Agent": "stackslash-research"}
    if os.environ.get("DOLTHUB_TOKEN"):
        hdr["authorization"] = f"token {os.environ['DOLTHUB_TOKEN']}"
    url = f"{DOLT}?q=" + urllib.parse.quote(sql)
    for attempt in range(6):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=hdr), timeout=90) as r:
                body = json.load(r)
            if body.get("query_execution_status") != "Error":
                return body.get("rows") or []
            err = body.get("query_execution_message")
        except Exception as ex:  # network / 429 / 5xx
            err = str(ex)
        time.sleep(2 ** attempt)
    raise RuntimeError(f"DoltHub: {err}")


def dolt_eps_history(page=1000, polite=0.25):
    """Keyset-paginate eps_history on its primary key (deep OFFSETs time out)."""
    rows, last = [], ("", "1900-01-01")
    while True:
        got = dolt_query(
            "select act_symbol, period_end_date, reported, estimate from eps_history "
            f"where (act_symbol, period_end_date) > ('{last[0]}', '{last[1]}') "
            f"order by act_symbol, period_end_date limit {page}")
        rows += got
        if len(got) < page:
            return rows
        last = (got[-1]["act_symbol"].replace("'", "''"), got[-1]["period_end_date"])
        if len(rows) % 20000 == 0:
            print(f"    {len(rows):,} rows...", flush=True)
        time.sleep(polite)


def earnings(con):
    """EPS surprise events. DoltHub's eps_history (Zacks-derived: reported vs
    consensus estimate per fiscal quarter) has no announcement date, and its
    calendar only starts 2020, so each quarter is dated by the company's first
    8-K item 2.02 filed within 120 days after the period end -- the moment the
    number became public, timestamped by EDGAR."""
    RAW.mkdir(parents=True, exist_ok=True)
    cache = RAW / "dolt_eps_history.parquet"
    if not cache.exists() or "--refresh-earnings" in sys.argv:
        print("  pulling eps_history from DoltHub...", flush=True)
        rows = dolt_eps_history()
        f = lambda k: [float(r[k]) if r[k] is not None else None for r in rows]
        pq.write_table(pa.table({
            "symbol": [r["act_symbol"] for r in rows],
            "period_end": pa.array([r["period_end_date"] for r in rows]).cast(pa.date32()),
            "reported": f("reported"), "estimate": f("estimate"),
        }), cache)
    e = str(EDGAR)
    con.execute(f"""
      create or replace temp table ticker_cik as
      select ticker, cik from (
        select ticker, cik from read_parquet('{e}/edgar_tickers.parquet')
        union select unnest(tickers) ticker, cik from read_parquet('{e}/edgar_companies.parquet')
      )
    """)
    con.execute(f"""
      create or replace temp table ev as
      with eps as (
        select * from read_parquet('{cache}') where reported is not null and estimate is not null
      ),
      k202 as (
        select tc.ticker symbol, fl.filing_date::date fd,
               try_cast(replace(fl.acceptance_datetime, 'Z', '') as timestamp) ts
        from read_parquet('{e}/edgar_filings.parquet') fl join ticker_cik tc on tc.cik = fl.cik
        where fl.form in ('8-K', '8-K/A') and list_contains(string_split(fl.items, ','), '2.02')
      ),
      dated as (
        select eps.*, arg_min(k.fd, k.fd) fd, arg_min(k.ts, k.fd) ts
        from eps join k202 k on k.symbol = eps.symbol and k.fd > eps.period_end and k.fd <= eps.period_end + interval 120 day
        group by all
      ),
      s as (
        select *, (reported - estimate) / greatest(abs(estimate), 0.02) as surprise from dated
      )
      select symbol, fd as event_date, ts as event_ts, 'earnings' as source,
             unnest(list_filter([
               case when reported > estimate then 'earn_beat' when reported < estimate then 'earn_miss' else 'earn_inline' end,
               case when surprise >= 0.25 then 'earn_big_beat' when surprise <= -0.25 then 'earn_big_miss' end,
               case when reported > estimate and estimate < 0 and reported >= 0 then 'earn_turn_profitable' end
             ], x -> x is not null)) as type,
             printf('q=%s rep=%.2f est=%.2f surp=%.0f%%', period_end, reported, estimate, 100 * surprise) as detail
      from s
    """)
    return "ev"


GC_PHRASES = [
    "substantial doubt about the Company's ability to continue as a going concern",
    "substantial doubt about our ability to continue as a going concern",
    "substantial doubt about its ability to continue as a going concern",
]


def efts(params):
    ua = os.environ.get("SEC_USER_AGENT")
    if not ua:
        raise RuntimeError("SEC_USER_AGENT is not set")
    url = "https://efts.sec.gov/LATEST/search-index?" + urllib.parse.urlencode(params)
    for attempt in range(6):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": ua}), timeout=60) as r:
                return json.load(r)
        except Exception:
            time.sleep(2 ** attempt)
    raise RuntimeError(f"EFTS failed: {url}")


def going_concern(con):
    """10-K / 10-Q filings containing going-concern language, via EDGAR
    full-text search (month windows, three phrasings, 100 hits per page).
    Hypothetical risk-factor wording can match too; the event is 'the
    filing says it', dated by filing date."""
    RAW.mkdir(parents=True, exist_ok=True)
    cache = RAW / "efts_going_concern.parquet"
    full = not cache.exists() or "--refresh-going-concern" in sys.argv
    hits = {}
    if not full:
        # incremental: keep the cache, re-search only the last two months
        old = pq.read_table(cache).to_pylist()
        cutoff = (dt.date.today().replace(day=1) - dt.timedelta(days=1)).replace(day=1)
        hits = {(r["adsh"], r["cik"]): (r["file_date"].isoformat(), r["form"]) for r in old if r["file_date"] < cutoff}
    m = dt.date(2016, 1, 1) if full else (dt.date.today().replace(day=1) - dt.timedelta(days=1)).replace(day=1)
    today = dt.date.today()
    while m <= today:
        nxt = (m.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
        for phrase in GC_PHRASES:
            for form in ("10-K", "10-Q"):
                frm = 0
                while True:
                    d = efts({"q": f'"{phrase}"', "forms": form, "dateRange": "custom",
                              "startdt": m.isoformat(), "enddt": (nxt - dt.timedelta(days=1)).isoformat(), "from": frm})
                    page = d["hits"]["hits"]
                    for x in page:
                        src = x["_source"]
                        if src.get("root_forms", [form])[0] not in ("10-K", "10-Q"):
                            continue
                        for cik in src.get("ciks", []):
                            hits[(src["adsh"], int(cik))] = (src["file_date"], src["form"])
                    frm += len(page)
                    time.sleep(0.15)
                    if not page or frm >= d["hits"]["total"]["value"] or frm >= 10000:
                        break
        print(f"    {m:%Y-%m}: {len(hits):,} filings so far", flush=True)
        m = nxt
    pq.write_table(pa.table({
        "adsh": [k[0] for k in hits], "cik": [k[1] for k in hits],
        "file_date": pa.array([v[0] for v in hits.values()]).cast(pa.date32()),
        "form": [v[1] for v in hits.values()],
    }), cache)
    e = str(EDGAR)
    con.execute(f"""
      create or replace temp table ticker_cik as
      select ticker, cik from (
        select ticker, cik from read_parquet('{e}/edgar_tickers.parquet')
        union select unnest(tickers) ticker, cik from read_parquet('{e}/edgar_companies.parquet')
      )
    """)
    con.execute(f"""
      create or replace temp table ev as
      select tc.ticker symbol, g.file_date event_date, null::timestamp as event_ts, 'going_concern' as source,
             case when g.form like '10-K%' then 'gc_10k' else 'gc_10q' end as type,
             any_value(g.adsh) detail
      from read_parquet('{cache}') g join ticker_cik tc on tc.cik = g.cik
      group by all
    """)
    return "ev"


# Headline taxonomy, fixed up front (each pattern is a case-insensitive regex;
# a headline can carry several types). Wording follows Benzinga's house style.
NEWS_TYPES = {
    "news_fda_approval": r"\bFDA (?:approv|grants? (?:accelerated |full )?approval)|receives? FDA approval|FDA clears|510\(k\) clearance",
    "news_fda_setback": r"complete response letter|\bCRL\b|FDA (?:rejects|declines)|refuse to file|clinical hold",
    "news_trial_positive": r"(?:positive|successful|met (?:its |the )?primary) (?:top-?line |interim )?(?:data|results|endpoint)|met primary endpoint",
    "news_trial_negative": r"(?:did not|failed to|does not) meet (?:its |the )?primary|missed (?:its |the )?primary endpoint|discontinu\w+ (?:trial|study|program)",
    "news_contract": r"\b(?:awarded|wins?|secures?|receives?|lands?) .{0,40}(?:contract|order|purchase order|award)\b",
    "news_partnership": r"\b(?:partnership|collaboration|strategic alliance|licens(?:e|ing) agreement|joint venture)\b",
    "news_acquired": r"\bto be acquired\b|agrees? to be acquired|enters? (?:into )?(?:a )?definitive (?:merger )?agreement to be acquired|takeover offer|buyout offer",
    "news_offering": r"\b(?:prices?|pricing of|announces?) .{0,40}(?:public offering|registered direct|private placement|at-the-market|ATM offering)|proposed (?:public )?offering",
    "news_upgrade": r"\bupgrades?\b",
    "news_downgrade": r"\bdowngrades?\b",
    "news_initiate": r"\binitiates? coverage\b",
    "news_pt_raise": r"(?:raises?|boosts?) (?:price target|PT)|price target (?:raised|increased)",
    "news_pt_cut": r"(?:lowers?|cuts?) (?:price target|PT)|price target (?:lowered|cut)",
    "news_guidance_raise": r"(?:raises?|boosts?|lifts?) .{0,20}(?:guidance|outlook|forecast)",
    "news_guidance_cut": r"(?:lowers?|cuts?|reduces?|withdraws?) .{0,20}(?:guidance|outlook|forecast)",
    "news_buyback": r"\b(?:buyback|share repurchase|stock repurchase)\b",
    "news_listing_deficiency": r"(?:Nasdaq|NYSE)[^.]{0,40}(?:deficiency|non-?compliance|delisting notice|notice of delisting)|minimum bid price",
    "news_reverse_split": r"reverse (?:stock )?split",
    "news_uplisting": r"\buplist",
    "news_bankruptcy": r"chapter 11|bankruptcy|insolven",
    "news_investigation": r"\b(?:SEC investigation|subpoena|class action|securities fraud|investor alert|shareholder alert)\b",
    "news_short_report": r"short (?:seller|report)|(?:Hindenburg|Muddy Waters|Citron|Spruce Point|Kerrisdale|Culper|Grizzly)",
    "news_halt": r"\bhalted\b|trading halt",
    "news_patent": r"\bpatent (?:granted|issued|award)|\breceives? .{0,20}patent",
    "news_insider_buy": r"(?:CEO|CFO|director|insider|chairman)[^.]{0,30}\b(?:buys|bought|purchases|purchased|acquires)\b",
}


def news(con):
    """Headline catalysts from the Alpaca/Benzinga crawl (news_crawl.py).
    Only headlines naming <= --max-syms symbols count (multi-ticker roundups
    say little about any one name); dated by publication in US/Eastern, so
    the harness enters no earlier than the next session's close."""
    src = RAW / "news"
    if not any(src.glob("*.parquet")):
        raise RuntimeError("no news yet: run research/catalysts/news_crawl.py first")
    cases = ",\n".join(f"case when regexp_matches(headline, '{pat.replace(chr(39), chr(39) * 2)}', 'i') then '{t}' end"
                       for t, pat in NEWS_TYPES.items())
    con.execute(f"""
      create or replace temp table ev as
      with n as (
        select id, created_at, headline, symbols from read_parquet('{src}/*.parquet')
        where len(symbols) between 1 and 3
      ),
      typed as (
        select id, created_at, headline, symbols,
               list_filter([{cases}, 'news_any'], x -> x is not null) as types
        from n
      )
      , by_sym as (
        select unnest(symbols) as symbol, id, created_at, headline, types from typed
      ),
      by_type as (
        select symbol, created_at, headline, unnest(types) as type from by_sym
      )
      select symbol,
             (created_at at time zone 'America/New_York')::date as event_date,
             min(created_at)::timestamp as event_ts, 'news' as source,
             type, any_value(headline) as detail
      from by_type
      group by symbol, event_date, type
    """)
    return "ev"


def form4(con):
    """Insider transactions parsed from Form 4 XML (form4_crawl.py). Dated by
    filing date (the public moment; the trade itself can be up to 2 business
    days earlier). Open-market buys (code P) and sales (S) only -- grants,
    option exercises and tax withholding carry no view."""
    src = RAW / "form4.duckdb"
    e = str(EDGAR)
    con.execute(f"attach '{src}' as f4 (read_only)")
    con.execute(f"""
      create or replace temp table ticker_cik as
      select ticker, cik from (
        select ticker, cik from read_parquet('{e}/edgar_tickers.parquet')
        union select unnest(tickers) ticker, cik from read_parquet('{e}/edgar_companies.parquet')
      )
    """)
    # point-in-time market cap per (cik, date) for the size-conditioned types (README item 43):
    # SEC shares outstanding (latest filed on/before the date, restated to that date's split basis
    # with the warehouse split factor) x that date's raw close
    m = str(RAW.parent.parent / "charter" / "daily_metrics")
    con.execute(f"""
      create or replace temp table f4_mcap as
      with px as (select symbol, date, raw_close, split_factor from read_parquet('{m}/*/*.parquet', hive_partitioning = true)
                  where symbol in (select ticker from ticker_cik)),
      sh as (select cik, filed::date filed, max(val) shares from read_parquet('{e}/edgar_facts.parquet')
             where concept in ('EntityCommonStockSharesOutstanding','CommonStockSharesOutstanding') and unit = 'shares' and val > 0
             group by 1, 2 order by 1, 2),
      d as (select distinct t.cik, t.filing_date, tc.ticker from f4.tx t join ticker_cik tc using (cik) where t.code = 'P'),
      a as (select d.*, p.raw_close, p.split_factor f_now from d asof join px p on p.symbol = d.ticker and d.filing_date >= p.date),
      b as (select a.*, sh.shares, sh.filed from a asof join sh on sh.cik = a.cik and a.filing_date >= sh.filed),
      c as (select b.*, p.split_factor f_filed from b asof left join px p on p.symbol = b.ticker and b.filed >= p.date)
      select cik, filing_date, max(shares * f_now / nullif(f_filed, 0) * raw_close) as mcap
      from c where filing_date - filed <= 400 group by 1, 2
    """)
    con.execute("""
      create or replace temp table ev as
      with t as (
        select accession, cik, filing_date, coalesce(owner_cik, owner) as who, is_director, is_officer, is_ten_pct,
               code, shares * price as value,
               regexp_matches(coalesce(officer_title, ''), '(chief executive|chief financial|\bceo\b|\bcfo\b)', 'i') as ceo_cfo
        from f4.tx where code in ('P', 'S') and shares > 0 and price > 0
      ),
      filing as (
        select cik, filing_date, accession, who,
               sum(value) filter (where code = 'P') buy_v, sum(value) filter (where code = 'S') sell_v,
               bool_or(is_officer) officer, bool_or(is_director) director, bool_or(is_ten_pct) ten_pct,
               bool_or(ceo_cfo) ceo_cfo
        from t group by all
      ),
      -- an insider's open-market buy with none by the same insider at the same issuer in the prior 365 days;
      -- events from 2017 only, so every one has a full year of history in the parse (which starts 2016)
      first_buy as (
        select f.cik, f.filing_date, sum(f.buy_v) v from filing f
        where f.buy_v > 0 and f.filing_date >= date '2017-01-01'
          and not exists (select 1 from filing p where p.cik = f.cik and p.who = f.who and p.buy_v > 0
                          and p.filing_date < f.filing_date and p.filing_date >= f.filing_date - 365)
        group by all
      ),
      day_buys as (
        select f.cik, f.filing_date, sum(f.buy_v) v, any_value(m.mcap) mcap
        from filing f left join f4_mcap m using (cik, filing_date) where f.buy_v > 0 group by all
      ),
      buyers as (
        select cik, filing_date, who from filing where buy_v > 0
      ),
      cluster as (
        -- a date on which the issuer has >= 2 distinct insiders buying within the trailing 14 days
        select b.cik, b.filing_date from buyers b join buyers o
          on o.cik = b.cik and o.filing_date between b.filing_date - 14 and b.filing_date and o.who <> b.who
        group by all
      ),
      typed as (
        select cik, filing_date, 'f4_buy' as type, sum(buy_v) as v from filing where buy_v > 0 group by all
        union all select cik, filing_date, 'f4_buy_officer', sum(buy_v) from filing where buy_v > 0 and officer group by all
        union all select cik, filing_date, 'f4_buy_director', sum(buy_v) from filing where buy_v > 0 and director and not officer group by all
        union all select cik, filing_date, 'f4_buy_ten_pct', sum(buy_v) from filing where buy_v > 0 and ten_pct group by all
        union all select cik, filing_date, 'f4_buy_large', sum(buy_v) from filing where buy_v > 0 group by all having sum(buy_v) >= 100000
        union all select cik, filing_date, 'f4_buy_cluster', null from cluster
        union all select cik, filing_date, 'f4_buy_ceo_cfo', sum(buy_v) from filing where buy_v > 0 and ceo_cfo group by all
        union all select cik, filing_date, 'f4_buy_mcap_0.1pct', v from day_buys where mcap > 0 and v >= 0.001 * mcap
        union all select cik, filing_date, 'f4_buy_mcap_0.5pct', v from day_buys where mcap > 0 and v >= 0.005 * mcap
        union all select cik, filing_date, 'f4_buy_first_1y', v from first_buy
        union all select cik, filing_date, 'f4_sell', sum(sell_v) from filing where sell_v > 0 group by all
        union all select cik, filing_date, 'f4_sell_officer', sum(sell_v) from filing where sell_v > 0 and officer group by all
        union all select cik, filing_date, 'f4_sell_large', sum(sell_v) from filing where sell_v > 0 group by all having sum(sell_v) >= 250000
      )
      select tc.ticker symbol, t.filing_date event_date, null::timestamp as event_ts, 'form4' as source, t.type,
             printf('$%,.0f', coalesce(max(t.v), 0)) as detail
      from typed t join ticker_cik tc on tc.cik = t.cik
      group by all
    """)
    return "ev"


ADAPTERS = {"edgar": edgar, "corporate_actions": corporate_actions, "earnings": earnings,
            "going_concern": going_concern, "news": news, "form4": form4}


def main():
    names = [a for a in sys.argv[1:] if not a.startswith("--")] or list(ADAPTERS)
    OUT.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    failed = []
    for name in names:
        try:
            tbl = ADAPTERS[name](con)
        except Exception as ex:  # one bad source shouldn't block the others
            print(f"{name}: FAILED: {ex}", flush=True)
            failed.append(name)
            continue
        path = OUT / f"{name}.parquet"
        con.execute(f"copy (select * from {tbl} order by event_date, symbol) to '{path}' (format parquet)")
        n, types, syms = con.execute(f"select count(*), count(distinct type), count(distinct symbol) from {tbl}").fetchone()
        print(f"{name}: {n:,} events, {types} types, {syms:,} symbols -> {path}")
        for t, c in con.execute(f"select type, count(*) from {tbl} group by 1 order by 2 desc").fetchall():
            print(f"    {t:<24}{c:>10,}")
    if failed:
        sys.exit(f"failed sources: {', '.join(failed)}")


if __name__ == "__main__":
    main()
