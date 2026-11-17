"""Layer 3 audit, auditor B: catalyst study, SEC 8-K item 2.02 events.

Independent re-implementation from the written spec only. SQL-first (DuckDB).
Run: research/.venv/bin/python research/audit/catalyst_l3_b.py
"""
import csv
import os
import time

import duckdb

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB = os.path.join(ROOT, "research/data/stackslash.duckdb")
EDGAR = os.path.join(ROOT, "research/data/edgar")
OUT = os.path.join(ROOT, "research/data/audit/catalyst_l3_b.csv")

PX_LO, PX_HI = 0.10, 5.00
DV_MIN = 2_500_000.0
DV_WIN = 20
HORIZONS = (1, 5, 20)
COST_MIN, TICK = 0.01, 0.01


def connect():
    for i in range(60):
        try:
            return duckdb.connect(DB, read_only=True)
        except duckdb.IOException as e:  # locked by a writer
            print(f"warehouse locked ({e}); retry {i + 1}/60 in 10 s")
            time.sleep(10)
    raise SystemExit("warehouse stayed locked")


con = connect()
con.execute("SET threads TO 8")


def one(sql):
    return con.execute(sql).fetchone()


def n(table):
    return one(f"SELECT count(*) FROM {table}")[0]


def step(label, table):
    k = n(table)
    print(f"[{label}] {table}: {k:,} rows")
    return k


# ---------------------------------------------------------------- 1. bars
# Raw (as-traded) bars drive gates; split-adjusted bars drive returns.
con.execute("""
CREATE TEMP TABLE cal AS
SELECT date, row_number() OVER (ORDER BY date) AS sk
FROM (SELECT DISTINCT date FROM sip_bars_daily_raw)
""")
step("1a market calendar (distinct SIP dates)", "cal")

raw_n = n("sip_bars_daily_raw")
con.execute("""
CREATE TEMP TABLE bars AS
SELECT r.symbol, r.date, c.sk,
       r.close  AS raw_close,
       r.volume AS raw_volume,
       s.close  AS adj_close,
       row_number() OVER (PARTITION BY r.symbol ORDER BY r.date) AS rk
FROM sip_bars_daily_raw r
JOIN sip_bars_daily_split s USING (symbol, date)
JOIN cal c USING (date)
""")
k = step("1b raw JOIN split JOIN cal", "bars")
assert k == raw_n, f"raw->split join dropped {raw_n - k} rows"
assert one("SELECT count(*) FROM bars WHERE raw_close IS NULL OR adj_close IS NULL OR raw_close<=0 OR adj_close<=0")[0] == 0
assert one("SELECT count(*) FROM (SELECT symbol,date FROM bars GROUP BY 1,2 HAVING count(*)>1)")[0] == 0
print(f"    split rows without a raw row (ignored, no as-traded gate possible): "
      f"{one('SELECT count(*) FROM sip_bars_daily_split s ANTI JOIN sip_bars_daily_raw r USING (symbol,date)')[0]:,}")

# ------------------------------------------- 2. features per (symbol, date)
# dv20: mean of raw_close*raw_volume over the symbol's own last 20 bars,
# entry day inclusive (all known at the entry close). Requires 20 bars.
# fwd_h: the symbol's own bar h rows later (split-adjusted close).
fwd_cols = ",\n       ".join(
    f"lead(adj_close, {h}) OVER w AS adj_fwd_{h}, lead(sk, {h}) OVER w - sk AS span_{h}"
    for h in HORIZONS)
con.execute(f"""
CREATE TEMP TABLE feat AS
SELECT symbol, date, sk, raw_close, adj_close,
       avg(raw_close * raw_volume) OVER (w ROWS BETWEEN {DV_WIN - 1} PRECEDING AND CURRENT ROW) AS dv20,
       count(*)                    OVER (w ROWS BETWEEN {DV_WIN - 1} PRECEDING AND CURRENT ROW) AS dv_nbars,
       {fwd_cols}
FROM bars
WINDOW w AS (PARTITION BY symbol ORDER BY date)
""")
k = step("2 features", "feat")
assert k == raw_n

# ---------------------------------------------------------- 3. gated days
con.execute(f"""
CREATE TEMP TABLE gated AS
SELECT *,
       CASE WHEN date < DATE '2022-01-01' THEN '2016-2021' ELSE '2022+' END AS period,
       greatest({COST_MIN}, {TICK} / raw_close) AS cost
FROM feat
WHERE raw_close BETWEEN {PX_LO} AND {PX_HI}
  AND dv_nbars = {DV_WIN}
  AND dv20 >= {DV_MIN}
""")
print(f"    in band {PX_LO}-{PX_HI}: {one(f'SELECT count(*) FROM feat WHERE raw_close BETWEEN {PX_LO} AND {PX_HI}')[0]:,}; "
      f"of those with 20 bars: {one(f'SELECT count(*) FROM feat WHERE raw_close BETWEEN {PX_LO} AND {PX_HI} AND dv_nbars={DV_WIN}')[0]:,}")
step("3 gated in-band days (= baseline universe)", "gated")
assert one(f"SELECT max(raw_close) FROM gated")[0] <= PX_HI  # holdout seal

# --------------------------------------------------------------- 4. events
F = os.path.join(EDGAR, "edgar_filings.parquet")
T = os.path.join(EDGAR, "edgar_tickers.parquet")
con.execute(f"""
CREATE TEMP TABLE f202 AS
SELECT cik, accession, CAST(filing_date AS DATE) AS filing_date, items
FROM read_parquet('{F}')
WHERE form = '8-K'
  AND list_contains(list_transform(string_split(coalesce(items,''), ','), x -> trim(x)), '2.02')
""")
step("4a 8-K filings with item 2.02 (all years)", "f202")
assert one("SELECT count(*) FROM f202 WHERE filing_date IS NULL")[0] == 0
assert one("SELECT count(*) - count(DISTINCT (cik, accession)) FROM f202")[0] == 0
print(f"    co-registrant rows (same accession, extra CIK): "
      f"{one('SELECT count(*) - count(DISTINCT accession) FROM f202')[0]:,}")

con.execute(f"""
CREATE TEMP TABLE f202w AS
SELECT * FROM f202
WHERE filing_date >= (SELECT min(date) FROM cal) AND filing_date <= (SELECT max(date) FROM cal)
""")
step("4b inside SIP date range", "f202w")

# CIK -> ticker: SEC current company_tickers snapshot; EDGAR '-' class
# separator -> SIP '.' (BRK-B -> BRK.B). One row per (filing, ticker).
con.execute(f"""
CREATE TEMP TABLE tick AS
SELECT DISTINCT cik, replace(upper(trim(ticker)), '-', '.') AS symbol
FROM read_parquet('{T}') WHERE ticker IS NOT NULL
""")
step("4c distinct (cik, symbol) pairs", "tick")
con.execute("CREATE TEMP TABLE syms AS SELECT DISTINCT symbol FROM bars")
con.execute("""
CREATE TEMP TABLE fmap AS
SELECT f.*, t.symbol, (t.symbol IN (SELECT symbol FROM syms)) AS in_sip
FROM f202w f LEFT JOIN tick t USING (cik)
""")
k = step("4d filings LEFT JOIN tickers", "fmap")
no_tick = one("SELECT count(*) FROM fmap WHERE symbol IS NULL")[0]
no_sip = one("SELECT count(*) FROM fmap WHERE symbol IS NOT NULL AND NOT in_sip")[0]
in_sip = one("SELECT count(*) FROM fmap WHERE in_sip")[0]
print(f"    filing-rows with no current ticker: {no_tick:,}; ticker not in SIP bars: {no_sip:,}; mapped to SIP symbol: {in_sip:,}")
assert no_tick + no_sip + in_sip == k

# Session rule: s0 = first market session with date >= filing_date;
# entry = the session after s0 (sk + 1).
con.execute("""
CREATE TEMP TABLE ev AS
SELECT m.cik, m.accession, m.filing_date, m.symbol, c0.date AS s0_date, c0.sk + 1 AS entry_sk
FROM fmap m
ASOF JOIN cal c0 ON m.filing_date <= c0.date
WHERE m.in_sip
""")
k = step("4e mapped filings ASOF-joined to session on/after filing", "ev")
assert k == in_sip, "ASOF join dropped filings"
con.execute("""
CREATE TEMP TABLE ev2 AS
SELECT e.*, c.date AS entry_date FROM ev e JOIN cal c ON c.sk = e.entry_sk
""")
k2 = step("4f entry session exists in calendar", "ev2")
print(f"    dropped: s0 is the last calendar session (no next session): {k - k2:,}")
assert k - k2 == one("SELECT count(*) FROM ev WHERE entry_sk > (SELECT max(sk) FROM cal)")[0]

# Duplicates: several 2.02 filings (or several CIKs) landing on one
# (symbol, entry_date) collapse to one event.
con.execute("""
CREATE TEMP TABLE evu AS
SELECT symbol, entry_date, count(*) AS n_filings, min(filing_date) AS first_filing
FROM ev2 GROUP BY 1, 2
""")
k3 = step("4g unique (symbol, entry_date) events", "evu")
print(f"    collapsed duplicates: {k2 - k3:,}")

con.execute("""
CREATE TEMP TABLE evb AS
SELECT e.*, b.raw_close IS NOT NULL AS has_bar
FROM evu e LEFT JOIN feat b ON b.symbol = e.symbol AND b.date = e.entry_date
""")
assert n("evb") == k3
nobar = one("SELECT count(*) FROM evb WHERE NOT has_bar")[0]
print(f"    events with no SIP bar for the symbol on the entry session (dropped): {nobar:,}")

con.execute("""
CREATE TEMP TABLE events AS
SELECT g.* FROM evu e JOIN gated g ON g.symbol = e.symbol AND g.date = e.entry_date
""")
k4 = step("4h events passing gates at entry", "events")
print(f"    with bar but failing gates: {k3 - nobar - k4:,}")

# ------------------------------------------------------------ 5. returns
def long_rows(src, kind):
    parts = []
    for h in HORIZONS:
        parts.append(f"""
        SELECT '{kind}' AS kind, period, {h} AS horizon, symbol, date, span_{h} AS span,
               adj_fwd_{h} / adj_close - 1 - cost AS net
        FROM {src} WHERE adj_fwd_{h} IS NOT NULL""")
    return " UNION ALL ".join(parts)


con.execute(f"CREATE TEMP TABLE rets AS {long_rows('events', 'event')} UNION ALL {long_rows('gated', 'baseline')}")
step("5 return rows (horizon past data end excluded)", "rets")
for kind, src in (("event", "events"), ("baseline", "gated")):
    tot = n(src)
    for h in HORIZONS:
        have = one(f"SELECT count(*) FROM rets WHERE kind='{kind}' AND horizon={h}")[0]
        at_end = one(f"SELECT count(*) FROM {src} WHERE adj_fwd_{h} IS NULL AND sk > (SELECT max(sk) FROM cal) - {h}")[0]
        print(f"    {kind} h={h}: {have:,} of {tot:,} (no forward bar: {tot - have:,}, of which past data end: {at_end:,}, "
              f"symbol series ended earlier/delisted: {tot - have - at_end:,}); "
              f"windows spanning a calendar gap: "
              f"{one(f'SELECT count(*) FROM rets WHERE kind={chr(39)}{kind}{chr(39)} AND horizon={h} AND span<>{h}')[0]:,}")

# ------------------------------------------------------------ 6. summary
res = con.execute("""
SELECT kind, period, horizon, count(*) AS n,
       avg(CASE WHEN net > 0 THEN 1.0 ELSE 0.0 END) AS win_rate,
       avg(net) AS mean_net,
       quantile_cont(net, 0.5) AS median_net,
       sum(CASE WHEN net > 0 THEN net ELSE 0 END) / nullif(abs(sum(CASE WHEN net < 0 THEN net ELSE 0 END)), 0) AS pf_net
FROM rets GROUP BY 1, 2, 3
ORDER BY CASE kind WHEN 'event' THEN 0 ELSE 1 END, period, horizon
""").fetchall()
assert len(res) == 2 * 2 * len(HORIZONS), len(res)  # kind x period x horizon
assert sum(r[3] for r in res) == n("rets")

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["kind", "period", "horizon", "n", "win_rate", "mean_net", "median_net", "pf_net"])
    for r in res:
        w.writerow([r[0], r[1], r[2], r[3]] + [f"{x:.6f}" if x is not None else "" for x in r[4:]])

print(f"\n{'kind':9}{'period':11}{'h':>3}{'n':>11}{'win':>8}{'mean':>9}{'median':>9}{'pf':>7}")
for r in res:
    print(f"{r[0]:9}{r[1]:11}{r[2]:>3}{r[3]:>11,}{r[4]:>8.4f}{r[5]:>9.4f}{r[6]:>9.4f}{r[7]:>7.3f}")
print(f"\nwrote {OUT}")
