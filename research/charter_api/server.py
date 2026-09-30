"""
Charter API: a read-only query service over the local research warehouse
for the /charter page. Standard library + duckdb only.

SECURITY (it is designed to be reachable from the live site later)
  - every endpoint except /health needs `Authorization: Bearer <Supabase
    access token>`; the token is checked against Supabase (/auth/v1/user)
    and the user id must be in CHARTER_ALLOWED_USER_IDS. Results cached
    5 minutes per token.
  - read-only: the warehouse and every file are opened read-only, and the
    API answers a fixed set of queries. Browser input never becomes SQL:
    symbols are validated against a pattern and bound as parameters,
    dates are parsed, metric ids are checked against the catalog.
  - CORS only for the site and local dev origins.
  - binds 127.0.0.1 only; remote access goes through a tunnel.

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
from metrics import METRICS, SMAS  # noqa: E402
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


# ---------------------------------------------------------------- auth
_token_cache = {}
_token_lock = threading.Lock()


def check_auth(header):
    if not header or not header.startswith("Bearer "):
        raise ApiError(401, "sign in required")
    token = header[7:].strip()
    now = time.time()
    with _token_lock:
        hit = _token_cache.get(token)
        if hit and hit[1] > now:
            uid = hit[0]
            break_ok = True
        else:
            break_ok = False
    if not break_ok:
        url = os.environ["VITE_SUPABASE_URL"].rstrip("/") + "/auth/v1/user"
        req = urllib.request.Request(url, headers={"apikey": os.environ["VITE_SUPABASE_ANON_KEY"], "Authorization": f"Bearer {token}"})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                uid = json.load(r).get("id")
        except urllib.error.HTTPError:
            raise ApiError(401, "invalid or expired session")
        except Exception:
            raise ApiError(503, "could not verify the session with Supabase")
        with _token_lock:
            _token_cache[token] = (uid, now + TOKEN_TTL)
            if len(_token_cache) > 1000:
                for k in [k for k, v in _token_cache.items() if v[1] < now]:
                    _token_cache.pop(k, None)
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


ROUTES = {"/catalog": lambda q: {"metrics": METRICS}, "/symbols": ep_symbols, "/daily": ep_daily, "/events": ep_events,
          "/short": ep_short, "/fundamentals": ep_fundamentals, "/reddit": ep_reddit, "/minute": ep_minute, "/live": ep_live}
CSV_OK = {"/daily", "/events", "/fundamentals", "/minute"}


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

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _send(self, status, body, ctype="application/json", filename=None):
        data = body.encode() if isinstance(body, str) else body
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
            check_auth(self.headers.get("Authorization"))
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
            sys.stdout.write(f"{dt.datetime.now():%H:%M:%S} {u.path} {int((time.time() - t0) * 1000)}ms\n")
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
