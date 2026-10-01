"""
Charter API: a read-only query service over the local research warehouse
for the /charter page. Standard library + duckdb only.

SECURITY (it is designed to be reachable from the live site later)
  - every endpoint except /health needs `Authorization: Bearer <Supabase
    access token>`; the token is checked against Supabase (/auth/v1/user)
    and the user id must be in CHARTER_ALLOWED_USER_IDS. Results cached
    5 minutes per token (never past the token's own expiry); rejected
    tokens are cached too, so a replayed bad token never reaches Supabase.
  - rate limits (it is public through Tailscale Funnel): a client that
    fails auth 20 times in 5 minutes is refused (429) until the window
    clears; a signed-in user gets 240 requests/minute; /cross runs at
    most 2 at a time.
  - read-only: the warehouse and every file are opened read-only, and the
    API answers a fixed set of queries. Browser input never becomes SQL:
    symbols are validated against a pattern and bound as parameters,
    dates are parsed, metric ids are checked against the catalog.
  - CORS only for the site and local dev origins.
  - binds 127.0.0.1 only; remote access goes through Tailscale Funnel
    (public HTTPS on the Mac's ts.net name -> 127.0.0.1:8787).

ENDPOINTS (GET; JSON, or CSV with &format=csv where noted)
  /health                              liveness (no auth)
  /catalog                             metric catalog
  /symbols?q=                          symbol search (prefix), with name and last date
  /daily?symbol=&start=&end=           OHLCV + every daily metric     (csv)
  /events?symbol=&start=&end=          catalysts/filings/news/insider/splits (csv)
  /short?symbol=&start=&end=           FINRA short interest + Reg SHO short volume (csv)
  /fundamentals?symbol=                SEC share count / float / cash series (csv)
  /reddit?symbol=&start=&end=          ApeWisdom mention snapshots (daily)
  /minute?symbol=&date=                SIP minute bars for one session (csv)
  /live?symbol=                        TODAY'S IEX minute bars (separate feed, never merged)

    research/.venv/bin/python -m research.charter_api.server   (or scripts/run-charter-api.sh)
"""
import base64
import collections
import csv
import datetime as dt
import io
import json
import os
import re
import sys
import threading
import time
import traceback
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import duckdb

HERE = Path(__file__).resolve().parent
RESEARCH = HERE.parent
REPO = RESEARCH.parent
DATA = RESEARCH / "data"
WAREHOUSE = DATA / "stackslash.duckdb"
CAT = DATA / "catalysts"
EDGAR = DATA / "edgar"
sys.path.insert(0, str(HERE))
from metrics import DAILY_IDS, METRICS, SMAS  # noqa: E402
import formula_sql  # noqa: E402
from minute_index import MinuteIndex  # noqa: E402


try:  # catalyst type labels/verdict overrides live with the catalyst harness
    import importlib.util
    _spec = importlib.util.spec_from_file_location("catalyst_catalog", RESEARCH / "catalysts" / "catalog.py")
    catalyst_catalog = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(catalyst_catalog)
    CATALYST_LABELS = catalyst_catalog.LABELS
except Exception:  # pragma: no cover
    CATALYST_LABELS = {}

SYMBOL_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")
ORIGINS = {"https://r10t.netlify.app", "http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:5174", "http://127.0.0.1:5174"}
TOKEN_TTL = 300
FAIL_LIMIT, FAIL_WINDOW = 20, 300    # failed-auth requests per client per 5 minutes
USER_LIMIT, USER_WINDOW = 240, 60    # requests per signed-in user per minute
HEAVY = {"/cross", "/event_study"}                   # expensive endpoints: at most HEAVY_SLOTS concurrently
HEAVY_SLOTS = 2


def load_env():
    env = REPO / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"'))


class ApiError(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status = status


# ---------------------------------------------------------------- rate limits
class RateLimiter:
    """Sliding-window counter per key: hit() records one event, over() says whether the key is at its limit."""

    def __init__(self, limit, window):
        self.limit, self.window = limit, window
        self.events = collections.defaultdict(collections.deque)
        self.lock = threading.Lock()

    def _trim(self, key, now):
        q = self.events[key]
        while q and q[0] <= now - self.window:
            q.popleft()
        if not q:
            del self.events[key]
        return q

    def over(self, key):
        with self.lock:
            return len(self._trim(key, time.time())) >= self.limit

    def hit(self, key):
        """Record one event; True if the key was already at its limit (the event is then not counted)."""
        now = time.time()
        with self.lock:
            q = self._trim(key, now)
            if len(q) >= self.limit:
                return True
            self.events[key].append(now)
            if len(self.events) > 10000:  # bound memory: drop keys whose windows have cleared
                for k in list(self.events):
                    self._trim(k, now)
            return False


fail_limiter = RateLimiter(FAIL_LIMIT, FAIL_WINDOW)
user_limiter = RateLimiter(USER_LIMIT, USER_WINDOW)
heavy_slots = threading.BoundedSemaphore(HEAVY_SLOTS)


# ---------------------------------------------------------------- auth
_token_cache = {}
_token_lock = threading.Lock()


def token_expiry(token):
    """The JWT's own exp claim (unverified; only used to cap the cache), or None."""
    try:
        payload = token.split(".")[1]
        return float(json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["exp"])
    except Exception:
        return None


def check_auth(header):
    if not header or not header.startswith("Bearer "):
        raise ApiError(401, "sign in required")
    token = header[7:].strip()
    now = time.time()
    with _token_lock:
        hit = _token_cache.get(token)
    if hit and hit[1] > now:
        uid = hit[0]
    else:
        url = os.environ["VITE_SUPABASE_URL"].rstrip("/") + "/auth/v1/user"
        req = urllib.request.Request(url, headers={"apikey": os.environ["VITE_SUPABASE_ANON_KEY"], "Authorization": f"Bearer {token}"})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                uid = json.load(r).get("id")
        except urllib.error.HTTPError:
            uid = None  # rejected by Supabase: cached as rejected below
        except Exception:
            raise ApiError(503, "could not verify the session with Supabase")
        exp = token_expiry(token) if uid else None
        with _token_lock:
            _token_cache[token] = (uid, min(now + TOKEN_TTL, exp) if exp else now + TOKEN_TTL)
            if len(_token_cache) > 1000:
                for k in [k for k, v in _token_cache.items() if v[1] < now]:
                    _token_cache.pop(k, None)
            if len(_token_cache) > 5000:
                _token_cache.clear()
    if not uid:
        raise ApiError(401, "invalid or expired session")
    allowed = {x.strip() for x in os.environ.get("CHARTER_ALLOWED_USER_IDS", "").split(",") if x.strip()}
    if uid not in allowed:
        raise ApiError(403, "this account is not allowed to use Charter")
    return uid


# ---------------------------------------------------------------- params
def p_symbol(q):
    s = (q.get("symbol") or [""])[0].strip().upper()
    if not SYMBOL_RE.match(s):
        raise ApiError(400, "invalid symbol")
    return s


def p_date(q, key, default=None):
    v = (q.get(key) or [None])[0]
    if not v:
        if default is None:
            raise ApiError(400, f"{key} is required (YYYY-MM-DD)")
        return default
    try:
        return dt.date.fromisoformat(v)
    except ValueError:
        raise ApiError(400, f"{key} must be YYYY-MM-DD")


def p_range(q):
    end = p_date(q, "end", dt.date.today())
    start = p_date(q, "start", end - dt.timedelta(days=365))
    if start > end:
        raise ApiError(400, "start is after end")
    return start, end


# ---------------------------------------------------------------- db
def connect():
    """Read-only warehouse connection; the nightly update briefly locks the file."""
    last = None
    for attempt in range(5):
        try:
            con = duckdb.connect()
            con.execute(f"attach '{WAREHOUSE}' as wh (read_only)")
            return con
        except duckdb.IOException as e:
            last = e
            time.sleep(1 + attempt)
    raise ApiError(503, f"the warehouse is being updated, try again in a minute ({last})")


def columns(con, sql, params=()):
    rel = con.execute(sql, list(params))
    names = [d[0] for d in rel.description]
    rows = rel.fetchall()
    out = {n: [] for n in names}
    for r in rows:
        for n, v in zip(names, r):
            if isinstance(v, (dt.date, dt.datetime)):
                v = v.isoformat()
            elif isinstance(v, float) and v != v:
                v = None
            out[n].append(v)
    return {"columns": names, "data": out, "rows": len(rows)}


# ---------------------------------------------------------------- endpoints
_symbols_cache = {"at": 0, "rows": None}


def ep_symbols(q):
    now = time.time()
    if _symbols_cache["rows"] is None or now - _symbols_cache["at"] > 3600:
        con = connect()
        e = str(EDGAR)
        rows = con.execute(f"""
          with s as (
            select symbol, max(date) last_date, arg_max(close, date) last_close, min(date) first_date
            from wh.sip_bars_daily_raw group by symbol),
          n as (select ticker, any_value(name) as name from (select unnest(tickers) as ticker, name from read_parquet('{e}/edgar_companies.parquet')) group by ticker)
          select s.symbol, n.name, s.first_date, s.last_date, s.last_close from s left join n on n.ticker = s.symbol
          order by s.symbol
        """).fetchall()
        _symbols_cache.update(at=now, rows=rows)
    term = (q.get("q") or [""])[0].strip().upper()
    lim = min(int((q.get("limit") or ["25"])[0]), 100)
    rows = _symbols_cache["rows"]
    hits = [r for r in rows if r[0].startswith(term)] if term else rows
    if term and len(hits) < lim:
        more = [r for r in rows if r[1] and term in r[1].upper() and r not in hits]
        hits += more
    return {"symbols": [dict(symbol=r[0], name=r[1], first_date=r[2].isoformat(), last_date=r[3].isoformat(),
                             last_close=r[4]) for r in hits[:lim]]}


def daily_sql():
    sma = ",\n".join(f"avg(close) over (order by date rows between {k - 1} preceding and current row) sma{k}" for k in SMAS)
    derived = ",\n".join(
        f"close / sma{k} - 1 dist_sma{k}, sma{k} / lag(sma{k}, 5) over (order by date) - 1 slope_sma{k}" for k in SMAS)
    return f"""
      with b as (
        select r.date, s.open, s.high, s.low, s.close, r.close raw_close, r.volume, r.trade_count,
               r.vwap * s.close / nullif(r.close, 0) vwap, s.close / nullif(r.close, 0) split_factor
        from wh.sip_bars_daily_raw r join wh.sip_bars_daily_split s using (symbol, date)
        where r.symbol = ? and r.date between ? and ?
          and not (r.volume <= 0 and r.open = r.high and r.high = r.low and r.low = r.close)
      ),
      w as (
        select *,
          raw_close * volume dollar_volume,
          avg(raw_close * volume) over (order by date rows between 19 preceding and current row) dollar20,
          volume / nullif(avg(volume) over (order by date rows between 20 preceding and 1 preceding), 0) vol_ratio,
          volume / nullif(trade_count, 0) avg_trade_size,
          close / lag(close) over (order by date) - 1 ret_1,
          open / lag(close) over (order by date) - 1 gap,
          close / nullif(open, 0) - 1 body,
          close / lag(close, 5) over (order by date) - 1 ret_5,
          close / lag(close, 20) over (order by date) - 1 ret_20,
          (high - low) / lag(close) over (order by date) range_pct,
          greatest(high - low, abs(high - lag(close) over (order by date)), abs(low - lag(close) over (order by date))) tr,
          case when high > low then (close - low) / (high - low) else 0.5 end clv,
          close / nullif(vwap, 0) - 1 close_vs_vwap,
          close / max(high) over (order by date rows between 251 preceding and current row) pct_52w_high,
          close / min(low) over (order by date rows between 251 preceding and current row) pct_52w_low,
          {sma}
        from b
      )
      select date, open, high, low, close, raw_close, vwap, volume, trade_count, dollar_volume, dollar20, vol_ratio,
             avg_trade_size, ret_1, gap, body, ret_5, ret_20, range_pct,
             avg(tr) over (order by date rows between 13 preceding and current row) / close atr14_pct,
             clv, close_vs_vwap, pct_52w_high, pct_52w_low, {", ".join(f"sma{k}" for k in SMAS)},
             {derived}, split_factor
      from w order by date
    """


def ep_daily(q):
    sym = p_symbol(q)
    start, end = p_range(q)
    warm = start - dt.timedelta(days=420)  # 252 sessions of warm-up for 52w / SMA200
    con = connect()
    res = columns(con, daily_sql(), (sym, warm, end))
    keep = [i for i, d in enumerate(res["data"]["date"]) if d >= start.isoformat()]
    res["data"] = {k: [v[i] for i in keep] for k, v in res["data"].items()}
    res["rows"] = len(keep)
    res["symbol"] = sym
    return res


def ep_events(q):
    sym = p_symbol(q)
    start, end = p_range(q)
    con = duckdb.connect()
    res = columns(con, f"""
      select event_date date, event_ts ts, source, type, detail
      from read_parquet('{CAT}/*.parquet', union_by_name = true)
      where symbol = ? and event_date between ? and ? and type not in ('news_any', 'form4')
      order by event_date, source, type
    """, (sym, start, end))
    res["data"]["label"] = [CATALYST_LABELS.get(t, (t, None))[0] for t in res["data"]["type"]]
    res["columns"].append("label")
    news = columns(con, f"""
      select (created_at at time zone 'America/New_York')::date date, created_at ts, headline
      from read_parquet('{CAT}/raw/news/*.parquet')
      where list_contains(symbols, ?) and created_at >= ?::date and created_at < ?::date + 1
      order by created_at
    """, (sym, start, end))
    res["headlines"] = news
    return res


def ep_short(q):
    sym = p_symbol(q)
    start, end = p_range(q)
    con = connect()
    si = CAT / "raw" / "short_interest"
    sv = CAT / "raw" / "short_volume"
    e = str(EDGAR)
    out = {"symbol": sym}
    # restate to today's share basis with the warehouse split factor at each date
    out["short_interest"] = columns(con, f"""
      with f as (select date, s.close / nullif(r.close, 0) f from wh.sip_bars_daily_raw r join wh.sip_bars_daily_split s using (symbol, date)
                 where r.symbol = ? order by date),
      si as (select settlement_date, short_interest, avg_daily_volume, days_to_cover from read_parquet('{si}/*.parquet') where symbol = ?),
      j as (select si.*, f.f from si asof left join f on si.settlement_date >= f.date),
      tc as (select min(cik) cik from (select ticker, cik from read_parquet('{e}/edgar_tickers.parquet') union
             select unnest(tickers), cik from read_parquet('{e}/edgar_companies.parquet')) where ticker = ?),
      sh as (select filed::date filed, max(val) shares from read_parquet('{e}/edgar_facts.parquet')
             where cik = (select cik from tc) and concept in ('EntityCommonStockSharesOutstanding','CommonStockSharesOutstanding')
               and unit = 'shares' and val > 0 group by 1 order by 1),
      shf as (select sh.*, f.f ff from sh asof left join f on sh.filed >= f.date),
      k as (select j.*, shf.shares, shf.ff, shf.filed from j asof left join shf on j.settlement_date >= shf.filed)
      select settlement_date, settlement_date + interval 12 day published_approx,
             short_interest / f short_interest, days_to_cover, avg_daily_volume / f avg_daily_volume,
             (short_interest / f) / nullif(shares / ff, 0) short_float, shares / ff shares_outstanding, filed shares_filed
      from k where settlement_date between ? and ? order by settlement_date
    """, (sym, sym, sym, start - dt.timedelta(days=90), end))
    out["short_volume"] = columns(con, f"""
      select date, short_volume, total_volume, short_volume / nullif(total_volume, 0) short_volume_ratio
      from read_parquet('{sv}/*.parquet') where symbol = ? and date between ? and ? order by date
    """, (sym, start, end))
    return out


def ep_fundamentals(q):
    sym = p_symbol(q)
    con = connect()
    e = str(EDGAR)
    return columns(con, f"""
      with f as (select date, s.close / nullif(r.close, 0) f from wh.sip_bars_daily_raw r join wh.sip_bars_daily_split s using (symbol, date)
                 where r.symbol = ? order by date),
      tc as (select min(cik) cik from (select ticker, cik from read_parquet('{e}/edgar_tickers.parquet') union
             select unnest(tickers), cik from read_parquet('{e}/edgar_companies.parquet')) where ticker = ?),
      x as (select filed::date filed, "end"::date period_end, form, concept, max(val) val
            from read_parquet('{e}/edgar_facts.parquet')
            where cik = (select cik from tc) and concept in ('EntityCommonStockSharesOutstanding','CommonStockSharesOutstanding',
                  'EntityPublicFloat','CashAndCashEquivalentsAtCarryingValue','NetCashProvidedByUsedInOperatingActivities')
            group by all),
      j as (select x.*, f.f from x asof left join f on x.filed >= f.date)
      select filed, period_end, form,
        case concept when 'EntityPublicFloat' then 'public_float' when 'CashAndCashEquivalentsAtCarryingValue' then 'cash'
             when 'NetCashProvidedByUsedInOperatingActivities' then 'operating_cash_flow' else 'shares_outstanding' end as metric,
        case when concept like '%SharesOutstanding' then val / coalesce(f, 1) else val end as value
      from j order by filed, metric
    """, (sym, sym))


def ep_reddit(q):
    sym = p_symbol(q)
    start, end = p_range(q)
    db = CAT / "raw" / "reddit.duckdb"
    if not db.exists():
        return {"columns": [], "data": {}, "rows": 0}
    for attempt in range(5):
        try:
            con = duckdb.connect()
            con.execute(f"attach '{db}' as rd (read_only)")
            break
        except duckdb.IOException:
            time.sleep(1)
    else:
        raise ApiError(503, "the Reddit collector is writing, try again shortly")
    return columns(con, """
      with last as (select subreddit, seen_at::date as day, max(seen_at) as ts from rd.ape_snapshots group by 1, 2)
      select l.day as date, s.subreddit, s.mentions, s.upvotes, s.rank
      from rd.ape_snapshots s join last l on l.subreddit = s.subreddit and l.ts = s.seen_at
      where s.ticker = ? and l.day between ? and ? order by 1, 2
    """, (sym, start, end))


MINUTES = None


def ep_minute(q):
    sym = p_symbol(q)
    day = p_date(q, "date")
    files = MINUTES.files(sym, day)
    if not files:
        return {"columns": [], "data": {}, "rows": 0, "note": "no minute bars stored for this symbol-day"}
    con = duckdb.connect()
    lst = "[" + ", ".join("'" + f.replace("'", "''") + "'" for f in files) + "]"
    return columns(con, f"""
      select (ts at time zone 'America/New_York') ts_et, open, high, low, close, volume, trade_count, vwap
      from read_parquet({lst}, hive_partitioning = false)
      where symbol = ? and (ts at time zone 'America/New_York')::date = ?
      order by ts
    """, (sym, day))


def ep_live(q):
    sym = p_symbol(q)
    today = dt.datetime.now(dt.timezone.utc).date()
    params = urllib.parse.urlencode({"timeframe": "1Min", "start": f"{today}T08:00:00Z", "feed": "iex", "limit": 10000})
    req = urllib.request.Request(f"https://data.alpaca.markets/v2/stocks/{sym}/bars?{params}", headers={
        "APCA-API-KEY-ID": os.environ["ALPACA_API_KEY_ID"], "APCA-API-SECRET-KEY": os.environ["ALPACA_API_SECRET_KEY"]})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            bars = json.load(r).get("bars") or []
    except Exception as ex:
        raise ApiError(502, f"Alpaca live bars unavailable: {ex}")
    names = ["ts", "open", "high", "low", "close", "volume", "trade_count", "vwap"]
    keys = ["t", "o", "h", "l", "c", "v", "n", "vw"]
    return {"feed": "IEX (real-time, partial market volume -- never merged with SIP series)", "columns": names,
            "data": {n: [b.get(k) for b in bars] for n, k in zip(names, keys)}, "rows": len(bars)}


METRICS_DIR = DATA / "charter" / "daily_metrics"
EXCHANGES = {"NASDAQ", "NYSE", "AMEX", "ARCA", "BATS", "OTC"}
# catalyst families counted over trailing windows in /cross (types from research/data/catalysts)
CAT_FAMILIES = {
    "offering": ("s1", "s3", "424b4", "424b5"),
    "halt": ("news_halt",),
    "partnership_pr": ("news_partnership",),
    "earnings_beat": ("earn_beat", "earn_big_beat"),
    "insider_buy": ("f4_buy",),
    "news": None,        # any typed headline (news_* except news_any)
    "filing": None,      # any EDGAR event
}


def p_float(q, key, default):
    v = (q.get(key) or [None])[0]
    if v in (None, ""):
        return default
    try:
        return float(v)
    except ValueError:
        raise ApiError(400, f"{key} must be a number")


def ep_cross(q):
    """Every symbol on one date (snapshot) or a sample of symbol-days across a range (pooled),
    with all daily metrics + forward outcomes, plus point-in-time short / share / catalyst context."""
    if (q.get("date") or [None])[0]:
        start = end = p_date(q, "date")
    else:
        start, end = p_range(q)
        if (end - start).days > 366 * 11:
            raise ApiError(400, "range too long")
    sample = int(p_float(q, "sample", 20000))
    sample = max(100, min(sample, 200000))
    pmin, pmax = p_float(q, "price_min", 0.10), p_float(q, "price_max", 5.0)
    dmin = p_float(q, "dollar20_min", 250000)
    exch = [e for e in (q.get("exchanges") or [""])[0].upper().split(",") if e]
    if any(e not in EXCHANGES for e in exch):
        raise ApiError(400, "unknown exchange")
    funds = (q.get("funds") or ["0"])[0] == "1"
    seed = int(p_float(q, "seed", 7))
    con = connect()
    e = str(EDGAR)
    ex_sql = f"and exchange in ({', '.join('?' for _ in exch)})" if exch else ""
    params = [start.year, end.year, start, end, pmin, pmax, dmin, *exch]
    # sample AFTER filtering (duckdb applies USING SAMPLE to the FROM clause, i.e. before WHERE)
    con.execute(f"""
      create temp table base as
      select * from (
        select * exclude (year) from read_parquet('{METRICS_DIR}/*/*.parquet', hive_partitioning = true)
        where year between ? and ? and date between ? and ? and raw_close between ? and ? and dollar20 >= ?
          {ex_sql} {'' if funds else 'and not coalesce(is_fund, false)'}
      ) using sample {sample} rows (reservoir, {seed})
    """, params)
    total = con.execute(f"""
      select count(*) from read_parquet('{METRICS_DIR}/*/*.parquet', hive_partitioning = true)
      where year between ? and ? and date between ? and ? and raw_close between ? and ? and dollar20 >= ?
        {ex_sql} {'' if funds else 'and not coalesce(is_fund, false)'}
    """, params).fetchone()[0]
    si = CAT / "raw" / "short_interest"
    fam_sql = []
    for fam, types in CAT_FAMILIES.items():
        if fam == "news":
            cond = "ev.type like 'news_%'"
        elif fam == "filing":
            cond = "ev.source = 'edgar'"
        else:
            cond = "ev.type in (" + ", ".join(f"'{t}'" for t in types) + ")"
        fam_sql.append(f"count(*) filter (where {cond} and ev.event_date > b.date - 20) as cat20_{fam}")
        fam_sql.append(f"count(*) filter (where {cond}) as cat60_{fam}")
    con.execute(f"""
      create temp table sf as
      select m.symbol, m.date, m.split_factor from read_parquet('{METRICS_DIR}/*/*.parquet', hive_partitioning = true) m
      where m.symbol in (select distinct symbol from base) and m.year between ? and ?
      order by 1, 2
    """, [start.year - 3, end.year])
    con.execute(f"""
      create temp table si as
      select symbol, settlement_date, settlement_date + interval 12 day as pub, short_interest, days_to_cover
      from read_parquet('{si}/*.parquet') where symbol in (select distinct symbol from base) order by symbol, pub
    """)
    con.execute(f"""
      create temp table tc as select ticker, min(cik) as cik from (
        select ticker, cik from read_parquet('{e}/edgar_tickers.parquet')
        union select unnest(tickers) as ticker, cik from read_parquet('{e}/edgar_companies.parquet')) group by ticker
    """)
    con.execute(f"""
      create temp table sh as select cik, filed::date as filed, max(val) as shares from read_parquet('{e}/edgar_facts.parquet')
      where concept in ('EntityCommonStockSharesOutstanding','CommonStockSharesOutstanding') and unit = 'shares' and val > 0
        and cik in (select cik from tc where ticker in (select distinct symbol from base))
      group by 1, 2 order by 1, 2
    """)
    res = columns(con, f"""
      with x as (select b.*, tc.cik, b.date - interval 365 day as d1y from base b left join tc on tc.ticker = b.symbol),
      s0 as (select x.*, sh.shares as sh0, sh.filed as f0 from x asof left join sh on x.cik = sh.cik and x.date >= sh.filed),
      s1 as (select s0.*, sh.shares as sh1, sh.filed as f1 from s0 asof left join sh on s0.cik = sh.cik and s0.d1y >= sh.filed),
      q as (select s1.*, si.short_interest as si0, si.days_to_cover, si.settlement_date as sd from s1 asof left join si
            on si.symbol = s1.symbol and s1.date >= si.pub),
      r0 as (select q.*, a.split_factor as f_f0 from q asof left join sf a on a.symbol = q.symbol and q.f0 >= a.date),
      r1 as (select r0.*, a.split_factor as f_f1 from r0 asof left join sf a on a.symbol = r0.symbol and r0.f1 >= a.date),
      r2 as (select r1.*, a.split_factor as f_sd from r1 asof left join sf a on a.symbol = r1.symbol and r1.sd >= a.date),
      ctx as (
        select r2.* exclude (cik, d1y, sh0, sh1, f0, f1, si0, sd, f_f0, f_f1, f_sd),
          sh0 * split_factor / nullif(f_f0, 0) as shares_outstanding,
          -- shares restated to this date's basis x this date's actual (raw) price
          sh0 * split_factor / nullif(f_f0, 0) * raw_close as mcap,
          (sh0 * split_factor / nullif(f_f0, 0)) / nullif(sh1 * split_factor / nullif(f_f1, 0), 0) - 1 as share_growth_1y,
          si0 * split_factor / nullif(f_sd, 0) as short_interest,
          (si0 * split_factor / nullif(f_sd, 0)) / nullif(sh0 * split_factor / nullif(f_f0, 0), 0) as short_float,
          date - sd as short_age_days
        from r2
      ),
      evs as (
        select symbol, event_date, source, type from read_parquet('{CAT}/*.parquet', union_by_name = true)
        where symbol in (select distinct symbol from base) and event_date between ?::date - 60 and ?::date
          and type not in ('news_any', 'form4')
      ),
      cats as (
        select b.symbol, b.date, {", ".join(fam_sql)}
        from base b join evs ev on ev.symbol = b.symbol and ev.event_date <= b.date and ev.event_date > b.date - 60
        group by all
      )
      select ctx.*, {", ".join(f"coalesce(cats.cat20_{f}, 0) as cat20_{f}, coalesce(cats.cat60_{f}, 0) as cat60_{f}" for f in CAT_FAMILIES)}
      from ctx left join cats using (symbol, date)
      order by date, symbol
    """, (start, end))
    res["total_matching"] = total
    res["sampled"] = total > res["rows"]
    return res


# ---------------------------------------------------------------- event studies
_types_cache = {"at": 0, "rows": None}


def ep_event_types(q):
    """Every catalyst type in research/data/catalysts with its source, label and event count (cached 1 h)."""
    if not _types_cache["rows"] or time.time() - _types_cache["at"] > 3600:
        con = duckdb.connect()
        rows = con.execute(f"""
          select type, any_value(source) as source, count(*) as n, min(event_date) as first, max(event_date) as last
          from read_parquet('{CAT}/*.parquet', union_by_name = true) group by 1 order by 2, 1
        """).fetchall()
        _types_cache["rows"] = [dict(type=t, source=src, n=n, first=str(f), last=str(la),
                                     label=CATALYST_LABELS.get(t, (t, ""))[0], desc=CATALYST_LABELS.get(t, (t, ""))[1])
                                for t, src, n, f, la in rows]
        _types_cache["at"] = time.time()
    return {"types": _types_cache["rows"]}


def p_int(q, key, default, lo, hi):
    v = p_float(q, key, default)
    return int(max(lo, min(hi, round(v))))


def ep_event_study(q):
    """Mean path of chosen metrics from day -pre to +post around every event, split winners/losers,
    against a random-date control drawn from the same symbols.

    Events: kind=catalyst (a catalyst type; optional cond on day 0) or kind=condition (a formula that is
    true at day 0's close). Day 0 for a catalyst is the first session strictly AFTER the event date
    (align=entry, the /research harness convention) or the session on/after it (align=event). Universe
    gates (price band on the raw close, 20-day dollar volume, exchanges, funds) apply on day 0. Events of
    one symbol within `cooldown` sessions of an earlier one are dropped (first of each cluster kept).
    cum_ret = close / day-0 close - 1 (split-adjusted). Windows containing a >=10x or <=0.1x day
    (split/reorg artifacts) are dropped. Means are winsorized 1/99 per offset unless wins=0.
    Control: random in-universe days of the same symbols, at least pre/post sessions away from any
    candidate event, as many as there are events."""
    kind = (q.get("kind") or ["condition"])[0]
    if kind not in ("condition", "catalyst"):
        raise ApiError(400, "kind must be condition or catalyst")
    start = p_date(q, "start", dt.date(2016, 1, 1))
    end = p_date(q, "end", dt.date(2021, 12, 31))
    if start > end:
        raise ApiError(400, "start is after end")
    pre, post = p_int(q, "pre", 20, 1, 60), p_int(q, "post", 20, 1, 60)
    k = p_int(q, "k", 5, 1, post)
    thr = p_float(q, "thr", 0.0)
    cooldown = p_int(q, "cooldown", 20, 0, 250)
    cap = p_int(q, "sample", 5000, 200, 20000)
    seed = p_int(q, "seed", 7, 0, 10 ** 6)
    wins = (q.get("wins") or ["1"])[0] != "0"
    align = (q.get("align") or ["entry"])[0]
    if align not in ("entry", "event"):
        raise ApiError(400, "align must be entry or event")
    pmin, pmax = p_float(q, "price_min", 0.10), p_float(q, "price_max", 5.0)
    dmin = p_float(q, "dollar20_min", 250000)
    exch = [e for e in (q.get("exchanges") or [""])[0].upper().split(",") if e]
    if any(e not in EXCHANGES for e in exch):
        raise ApiError(400, "unknown exchange")
    funds = (q.get("funds") or ["0"])[0] == "1"
    mets = [m for m in (q.get("metrics") or [""])[0].split(",") if m]
    if len(mets) > 6:
        raise ApiError(400, "at most 6 metrics")
    bad = [m for m in mets if m not in DAILY_IDS]
    if bad:
        raise ApiError(400, f"unknown metric {bad[0]}")
    cond_src = (q.get("cond") or [""])[0].strip()
    cond_sql, cond_cols = None, set()
    if cond_src:
        try:
            cond_sql, cond_cols = formula_sql.to_sql(cond_src, set(DAILY_IDS))
        except formula_sql.FormulaError as ex:
            raise ApiError(400, f"condition: {ex}")
    elif kind == "condition":
        raise ApiError(400, "a condition formula is required")
    ctype = None
    if kind == "catalyst":
        ctype = (q.get("type") or [""])[0]
        if ctype not in {t["type"] for t in ep_event_types({})["types"]}:
            raise ApiError(400, "unknown catalyst type")

    cols = sorted({"close", "raw_close", "dollar20", "ret_1", *mets, *cond_cols})
    gate = (f"raw_close between {float(pmin)!r} and {float(pmax)!r} and dollar20 >= {float(dmin)!r}"
            + (f" and exchange in ({', '.join(repr(e) for e in exch)})" if exch else "")
            + ("" if funds else " and not coalesce(is_fund, false)"))
    con = connect()
    con.execute("set preserve_insertion_order = false")
    sym_filter = ""
    if kind == "catalyst":
        con.execute(f"""
          create temp table ev as select distinct symbol, event_date from read_parquet('{CAT}/*.parquet', union_by_name = true)
          where type = ? and event_date between ?::date - 10 and ?
        """, [ctype, start, end])
        sym_filter = "and symbol in (select distinct symbol from ev)"
    con.execute(f"""
      create temp table b as
      select symbol, date, row_number() over (partition by symbol order by date) as idx,
        {", ".join(f'"{c}"' for c in cols)},
        close / lag(close) over (partition by symbol order by date) as _ratio,
        ({gate}) as _g
        {f", ({cond_sql}) as _cond" if cond_sql else ""}
      from read_parquet('{METRICS_DIR}/*/*.parquet', hive_partitioning = true)
      where year between {start.year - 1} and {end.year + 1} {sym_filter}
    """)
    cond_ok = "and coalesce(b._cond, 0) <> 0" if cond_sql else ""
    if kind == "catalyst":
        con.execute(f"""
          create temp table cand as
          select distinct b.symbol, b.idx, b.date, min(e.event_date) over (partition by b.symbol, b.idx) as event_date
          from ev e asof join b on e.symbol = b.symbol and e.event_date {'<' if align == 'entry' else '<='} b.date
          where b.date between ? and ? and b._g {cond_ok}
        """, [start, end])
    else:
        con.execute(f"""
          create temp table cand as
          select symbol, idx, date, null::date as event_date from b
          where date between ? and ? and _g {cond_ok}
        """, [start, end])
    n_cand = con.execute("select count(*) from cand").fetchone()[0]
    con.execute(f"""
      create temp table evall as select * from cand
      qualify lag(idx) over (partition by symbol order by idx) is null
           or idx - lag(idx) over (partition by symbol order by idx) > {cooldown}
    """)
    n_events = con.execute("select count(*) from evall").fetchone()[0]
    con.execute(f"create temp table es as select * from (select * from evall) using sample {cap} rows (reservoir, {seed})")
    n_used = con.execute("select count(*) from es").fetchone()[0]
    con.execute(f"""
      create temp table ctl as select * from (
        select x.symbol, x.idx, x.date, null::date as event_date from (
          select b.symbol, b.idx, b.date, p.idx as pidx from b asof left join cand p on b.symbol = p.symbol and b.idx >= p.idx
          where b.symbol in (select distinct symbol from es) and b.date between ? and ? and b._g
        ) x asof left join cand n on x.symbol = n.symbol and x.idx <= n.idx
        where (x.pidx is null or x.idx - x.pidx > {post}) and (n.idx is null or n.idx - x.idx > {pre})
      ) using sample {max(n_used, 1)} rows (reservoir, {seed + 1})
    """, [start, end])
    con.execute(f"""
      create temp table sel as
      select row_number() over () as eid, * from (
        select 'event' as grp, symbol, idx, date, event_date from es
        union all select 'control', symbol, idx, date, event_date from ctl)
    """)
    path = ["cum_ret", *[m for m in mets if m != "cum_ret"]]
    con.execute(f"""
      create temp table w as
      select s.eid, s.grp, b.idx - s.idx as off, b.close / nullif(b0.close, 0) - 1 as cum_ret, b._ratio,
        {", ".join(f'b."{m}"::double as "{m}"' for m in mets)}{"," if mets else ""} b0.raw_close as _p0
      from sel s join b b0 on b0.symbol = s.symbol and b0.idx = s.idx
      join b on b.symbol = s.symbol and b.idx between s.idx - {pre} and s.idx + {post}
    """)
    dropped = dict(con.execute(f"""
      with badw as (select distinct eid from w where off > -{pre} and (_ratio >= 10 or _ratio <= 0.1))
      select s.grp, count(*) from sel s join badw using (eid) group by 1
    """).fetchall())
    con.execute(f"delete from w where eid in (select eid from w where off > -{pre} and (_ratio >= 10 or _ratio <= 0.1))")
    con.execute(f"""
      create temp table lab as
      with o as (select eid, cum_ret as o from w where off = {k})
      select distinct w.eid, w.grp as g from w
      union all
      select s.eid, case when o.o >= {float(thr)!r} then 'winners' else 'losers' end
      from sel s join o using (eid) where s.grp = 'event' and o.o is not null
    """)
    unp = ", ".join(f'"{m}"' for m in path)
    con.execute(f"""
      create temp table l as
      unpivot (select lab.g, w.off, {", ".join(f'w."{m}"' for m in path)} from w join lab using (eid))
      on {unp} into name metric value v
    """)
    con.execute("delete from l where not isfinite(v)")
    clip = "least(greatest(l.v, q.lo1), q.hi1)" if wins else "l.v"
    stats = con.execute(f"""
      with q as (select g, metric, off, quantile_cont(v, 0.01) as lo1, quantile_cont(v, 0.99) as hi1 from l group by all)
      select l.g, l.metric, l.off, count(*) as n, avg({clip}) as mean, stddev_samp({clip}) as sd,
        median(l.v) as med, quantile_cont(l.v, 0.25) as q25, quantile_cont(l.v, 0.75) as q75
      from l join q using (g, metric, off) group by all order by 1, 2, 3
    """).fetchall()
    offsets = list(range(-pre, post + 1))
    groups = {}
    for g, m, off, n, mean, sd, med, q25, q75 in stats:
        d = groups.setdefault(g, {}).setdefault(m, {f: [None] * len(offsets) for f in ("n", "mean", "lo", "hi", "median", "q25", "q75")})
        i = off + pre
        se = (sd or 0) / n ** 0.5 if n > 1 else None
        d["n"][i], d["mean"][i], d["median"][i], d["q25"][i], d["q75"][i] = n, mean, med, q25, q75
        if se is not None:
            d["lo"][i], d["hi"][i] = mean - 1.96 * se, mean + 1.96 * se

    def at_k(g):
        r = con.execute(f"""
          with q as (select quantile_cont(v, 0.01) lo1, quantile_cont(v, 0.99) hi1 from l where g = ? and metric = 'cum_ret' and off = {k})
          select count(*), avg({clip}), stddev_samp({clip}), median(l.v), avg((l.v > 0)::int)
          from l, q where l.g = ? and l.metric = 'cum_ret' and l.off = {k}
        """, [g, g]).fetchone()
        return dict(n=r[0], mean=r[1], sd=r[2], median=r[3], hit=r[4])
    ev_k, ct_k = at_k("event"), at_k("control")
    summary = {"k": k, "event": ev_k, "control": ct_k}
    if ev_k["n"] > 1 and ct_k["n"] > 1 and ev_k["sd"] is not None and ct_k["sd"] is not None:
        diff = ev_k["mean"] - ct_k["mean"]
        se = (ev_k["sd"] ** 2 / ev_k["n"] + ct_k["sd"] ** 2 / ct_k["n"]) ** 0.5
        summary.update(diff=diff, diff_lo=diff - 1.96 * se, diff_hi=diff + 1.96 * se)
    events = columns(con, f"""
      select s.symbol, s.date, s.event_date, b0.raw_close, b0.dollar20, b0.ret_1,
        (select cum_ret from w where w.eid = s.eid and w.off = {k}) as outcome
      from sel s join b b0 on b0.symbol = s.symbol and b0.idx = s.idx
      where s.grp = 'event' and s.eid in (select eid from w)
      order by s.date desc, s.symbol
    """)
    counts = {"candidates": n_cand, "events": n_events, "used": n_used, "sampled": n_events > n_used,
              "dropped_artifacts": dropped.get("event", 0), "control": con.execute("select count(*) from ctl").fetchone()[0] - dropped.get("control", 0),
              "winners": groups.get("winners", {}).get("cum_ret", {}).get("n", [0])[pre + k] or 0,
              "losers": groups.get("losers", {}).get("cum_ret", {}).get("n", [0])[pre + k] or 0}
    day0 = ("the session the condition is true (at its close)" if kind == "condition" else
            "the first session strictly after the event date (the /research convention)" if align == "entry" else
            "the session on or after the event date")
    return {"offsets": offsets, "metrics": path, "groups": groups, "counts": counts, "summary": summary,
            "events": events, "day0": day0, "winsorized": wins}


ROUTES = {"/catalog": lambda q: {"metrics": METRICS}, "/cross": ep_cross, "/symbols": ep_symbols, "/daily": ep_daily, "/events": ep_events,
          "/short": ep_short, "/fundamentals": ep_fundamentals, "/reddit": ep_reddit, "/minute": ep_minute, "/live": ep_live,
          "/event_types": ep_event_types, "/event_study": ep_event_study}
CSV_OK = {"/daily", "/events", "/fundamentals", "/minute", "/cross"}


def to_csv(res):
    buf = io.StringIO()
    w = csv.writer(buf)
    cols = res["columns"]
    w.writerow(cols)
    for i in range(res["rows"]):
        w.writerow([res["data"][c][i] for c in cols])
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    server_version = "CharterAPI/1"

    def _cors(self):
        origin = self.headers.get("Origin")
        if origin in ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Max-Age", "600")
            # Chrome's Private Network Access: a public site (r10t.netlify.app) calling a private
            # address (the tailnet 100.x IP) needs the server to opt in on the preflight
            if self.headers.get("Access-Control-Request-Private-Network") == "true":
                self.send_header("Access-Control-Allow-Private-Network", "true")

    def _client(self):
        # behind Tailscale Serve/Funnel every connection comes from tailscaled on 127.0.0.1;
        # the client address is the X-Forwarded-For entry tailscaled adds (the last one)
        fwd = self.headers.get("X-Forwarded-For", "")
        return fwd.split(",")[-1].strip() or self.client_address[0]

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _send(self, status, body, ctype="application/json", filename=None):
        data = body.encode() if isinstance(body, str) else body
        self._status = status
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        t0 = time.time()
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        try:
            if u.path == "/health":
                return self._send(200, json.dumps({"ok": True, "warehouse": WAREHOUSE.exists(), "minute_index": MINUTES.size}))
            if u.path not in ROUTES:
                raise ApiError(404, "unknown endpoint")
            client = self._client()
            if fail_limiter.over(client):
                raise ApiError(429, "too many failed sign-in attempts; try again in a few minutes")
            try:
                uid = check_auth(self.headers.get("Authorization"))
            except ApiError as e:
                if e.status in (401, 403):
                    fail_limiter.hit(client)
                raise
            if user_limiter.hit(uid):
                raise ApiError(429, "too many requests; slow down for a minute")
            if u.path in HEAVY:
                if not heavy_slots.acquire(timeout=60):
                    raise ApiError(503, "busy with other cross-section queries; try again")
                try:
                    res = ROUTES[u.path](q)
                finally:
                    heavy_slots.release()
            else:
                res = ROUTES[u.path](q)
            if (q.get("format") or [""])[0] == "csv":
                if u.path not in CSV_OK:
                    raise ApiError(400, "csv not available for this endpoint")
                name = f"{u.path.strip('/')}_{(q.get('symbol') or ['all'])[0]}.csv"
                return self._send(200, to_csv(res), "text/csv", name)
            self._send(200, json.dumps(res, default=str))
        except ApiError as e:
            self._send(e.status, json.dumps({"error": str(e)}))
        except Exception:
            traceback.print_exc()
            self._send(500, json.dumps({"error": "internal error (see the API log)"}))
        finally:
            sys.stdout.write(f"{dt.datetime.now():%H:%M:%S} {getattr(self, '_status', '-')} {u.path} {int((time.time() - t0) * 1000)}ms {self._client()}\n")
            sys.stdout.flush()

    def log_message(self, *args):  # quiet default logging; do_GET logs a line per request
        pass


def main():
    global MINUTES
    load_env()
    for k in ("VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY", "CHARTER_ALLOWED_USER_IDS"):
        if not os.environ.get(k):
            raise SystemExit(f"{k} is not set in .env")
    MINUTES = MinuteIndex(DATA)
    port = int(os.environ.get("CHARTER_API_PORT", "8787"))
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Charter API on http://127.0.0.1:{port} (minute index: {MINUTES.size:,} symbol-units)", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
