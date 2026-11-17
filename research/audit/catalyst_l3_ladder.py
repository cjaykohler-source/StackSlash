"""Layer 3 audit, attribution ladder: catalyst study, SEC 8-K item 2.02.

Starts from auditor B's build (research/audit/catalyst_l3_b.py) and adds the
original study's undocumented choices one at a time, cumulatively, scoring
each rung against the original re-run on the same data
(catalyst_study_2500000_20261117T141858.csv). The rung that closes a gap is
the explanation the disagreement protocol asks for.

Run: research/.venv/bin/python research/audit/catalyst_l3_ladder.py
"""
import csv
import os
import time

import duckdb

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DB = os.path.join(ROOT, "research/data/stackslash.duckdb")
EDGAR = os.path.join(ROOT, "research/data/edgar")
ORIGINAL = os.path.join(ROOT, "research/data/study_outputs/catalyst_study_2500000_20261117T141858.csv")
OUT = os.path.join(ROOT, "research/data/audit/catalyst_l3_ladder.csv")
HORIZONS = (1, 5, 20)

# Cumulative rungs: each adds one of the original's choices to the last.
RUNGS = [
    ("L0 auditors (spec as written)", {}),
    ("L1 tick $0.0001 below $1", {"subpenny": True}),
    ("L2 void returns over bad prints / long gaps", {"badprint": True}),
    ("L3 drop zero-volume flat bars", {"flatbars": True}),
    ("L4 universe: >=60 in-band days since 2016", {"universe": True}),
    ("L5 dollar volume on split-adjusted series", {"split_dv": True}),
    ("L6 entry on symbol's own next bar", {"own_bar": True}),
    ("L7 ticker map as original (one CIK, no '-'->'.')", {"orig_map": True}),
    ("L8 a filing with item 1.01 counts as 1.01, not 2.02", {"precedence": True}),
]


def connect():
    for i in range(60):
        try:
            return duckdb.connect(DB, read_only=True)
        except duckdb.IOException as e:
            print(f"warehouse locked ({e}); retry {i + 1}/60 in 10 s")
            time.sleep(10)
    raise SystemExit("warehouse stayed locked")


con = connect()
con.execute("SET threads TO 8")
F = os.path.join(EDGAR, "edgar_filings.parquet")
T = os.path.join(EDGAR, "edgar_tickers.parquet")
C = os.path.join(EDGAR, "edgar_companies.parquet")

con.execute("CREATE TEMP TABLE cal AS SELECT date, row_number() OVER (ORDER BY date) sk FROM (SELECT DISTINCT date FROM sip_bars_daily_raw)")
con.execute(f"""
CREATE TEMP TABLE f202 AS
SELECT cik, CAST(filing_date AS DATE) filing_date,
  list_contains(list_transform(string_split(coalesce(items,''), ','), x -> trim(x)), '1.01') AS has_101
FROM read_parquet('{F}')
WHERE form = '8-K' AND list_contains(list_transform(string_split(coalesce(items,''), ','), x -> trim(x)), '2.02')
  AND CAST(filing_date AS DATE) >= DATE '2016-01-01'
""")


def run(o):
    tick = "CASE WHEN raw_close >= 1 THEN 0.01 ELSE 0.0001 END" if o.get("subpenny") else "0.01"
    flat = "AND NOT (s.volume <= 0 AND s.open = s.high AND s.high = s.low AND s.low = s.close)" if o.get("flatbars") else ""
    univ = """AND r.symbol IN (SELECT symbol FROM sip_bars_daily_raw WHERE date >= DATE '2016-01-01'
              AND close BETWEEN 0.10 AND 5.0 GROUP BY symbol HAVING count(*) >= 60)""" if o.get("universe") else ""
    dv = "s.close * s.volume" if o.get("split_dv") else "r.close * r.volume"
    con.execute(f"""
    CREATE OR REPLACE TEMP TABLE bars AS
    SELECT r.symbol, r.date, c.sk, r.close raw_close, s.close adj_close, {dv} AS dollar
    FROM sip_bars_daily_raw r JOIN sip_bars_daily_split s USING (symbol, date) JOIN cal c USING (date)
    WHERE true {flat} {univ}
    """)
    fwd = []
    for h in HORIZONS:
        ret = f"lead(adj_close, {h}) OVER w / adj_close - 1"
        if o.get("badprint"):
            ok = (f"date_diff('day', date, lead(date, {h}) OVER w) <= {2 * h + 7} "
                  f"AND coalesce(max(art) OVER (w ROWS BETWEEN 1 FOLLOWING AND {h} FOLLOWING), false) = false")
            ret = f"CASE WHEN {ok} THEN {ret} END"
        fwd.append(f"{ret} AS r{h}")
    con.execute(f"""
    CREATE OR REPLACE TEMP TABLE feat AS
    WITH b AS (SELECT *, (adj_close / lag(adj_close) OVER (PARTITION BY symbol ORDER BY date)) AS daily FROM bars),
    b2 AS (SELECT *, coalesce(daily >= 10 OR daily <= 0.1, false) AS art FROM b)
    SELECT symbol, date, sk, raw_close,
      avg(dollar) OVER (w ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS dv20,
      count(*) OVER (w ROWS BETWEEN 19 PRECEDING AND CURRENT ROW) AS nb,
      row_number() OVER w AS rk,
      {", ".join(fwd)}
    FROM b2 WINDOW w AS (PARTITION BY symbol ORDER BY date)
    """)
    con.execute(f"""
    CREATE OR REPLACE TEMP TABLE gated AS
    SELECT *, greatest(0.01, {tick} / raw_close) AS cost FROM feat
    WHERE raw_close BETWEEN 0.10 AND 5.0 AND nb = 20 AND dv20 >= 2500000
    """)
    if o.get("orig_map"):
        con.execute(f"""
        CREATE OR REPLACE TEMP TABLE tick AS
        SELECT ticker symbol, min(cik) cik FROM (
          SELECT ticker, cik FROM read_parquet('{T}') UNION SELECT unnest(tickers) ticker, cik FROM read_parquet('{C}'))
        GROUP BY ticker
        """)
    else:
        con.execute(f"CREATE OR REPLACE TEMP TABLE tick AS SELECT DISTINCT cik, replace(upper(trim(ticker)), '-', '.') symbol FROM read_parquet('{T}') WHERE ticker IS NOT NULL")
    # The original labels each filing with one catalyst, checking item 1.01
    # before 2.02, so a filing carrying both is not an earnings event.
    prec = "WHERE NOT f.has_101" if o.get("precedence") else ""
    con.execute(f"CREATE OR REPLACE TEMP TABLE fm AS SELECT DISTINCT t.symbol, f.filing_date FROM f202 f JOIN tick t USING (cik) {prec}")
    if o.get("own_bar"):
        # s0 = the symbol's own first bar on/after the filing date; entry = its next bar.
        # The original assigns the period by s0's date.
        con.execute("""
        CREATE OR REPLACE TEMP TABLE ev AS
        SELECT DISTINCT g.*, CASE WHEN s0.date < DATE '2022-01-01' THEN '2016-2021' ELSE '2022+' END period
        FROM fm ASOF JOIN feat s0 ON fm.symbol = s0.symbol AND fm.filing_date <= s0.date
        JOIN gated g ON g.symbol = s0.symbol AND g.rk = s0.rk + 1
        """)
    else:
        con.execute("""
        CREATE OR REPLACE TEMP TABLE ev AS
        SELECT DISTINCT g.*, CASE WHEN g.date < DATE '2022-01-01' THEN '2016-2021' ELSE '2022+' END period
        FROM fm ASOF JOIN cal c0 ON fm.filing_date <= c0.date
        JOIN cal c1 ON c1.sk = c0.sk + 1
        JOIN gated g ON g.symbol = fm.symbol AND g.date = c1.date
        """)
    parts = []
    for h in HORIZONS:
        parts.append(f"SELECT 'event' kind, period, {h} h, r{h} - cost net FROM ev WHERE r{h} IS NOT NULL")
        parts.append(f"SELECT 'baseline', CASE WHEN date < DATE '2022-01-01' THEN '2016-2021' ELSE '2022+' END, {h}, r{h} - cost FROM gated WHERE r{h} IS NOT NULL")
    rows = con.execute(f"SELECT kind, period, h, count(*), avg(net) FROM ({' UNION ALL '.join(parts)}) GROUP BY 1, 2, 3").fetchall()
    return {(k, p, h): (n, m) for k, p, h, n, m in rows}


orig = {}
for r in csv.reader(open(ORIGINAL)):
    if len(r) > 6 and r[1] == "all" and r[0] in ("8k_earnings", "BASELINE (random in-band day)"):
        kind = "event" if r[0] == "8k_earnings" else "baseline"
        orig[(kind, "2016-2021" if r[2] == "2016-21" else "2022+", int(r[3]))] = (int(r[4]), float(r[6]))


def edge(d, p):
    return (d[("event", p, 20)][1] - d[("baseline", p, 20)][1]) * 100


out = []
print(f"original 20d edge: 2016-21 {edge(orig, '2016-2021'):+.2f} pp, 2022+ {edge(orig, '2022+'):+.2f} pp\n")
opts = {}
for label, add in RUNGS:
    opts.update(add)
    t0 = time.time()
    res = run(opts)
    agree = sum(1 for k in orig if abs(res[k][0] / orig[k][0] - 1) <= 0.02 and abs(res[k][1] - orig[k][1]) <= 0.003)
    worst_n = max(abs(res[k][0] / orig[k][0] - 1) for k in orig) * 100
    worst_m = max(abs(res[k][1] - orig[k][1]) for k in orig) * 100
    print(f"{label:50} agree {agree:2}/12  worst n {worst_n:5.2f}%  worst mean {worst_m:4.2f} pp  "
          f"edge 2016-21 {edge(res, '2016-2021'):+.2f}  2022+ {edge(res, '2022+'):+.2f}  ({time.time() - t0:.0f}s)")
    for k in sorted(orig):
        out.append([label, *k, res[k][0], orig[k][0], f"{res[k][1]:.6f}", f"{orig[k][1]:.6f}"])

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", newline="") as fh:
    w = csv.writer(fh)
    w.writerow(["rung", "kind", "period", "horizon", "n", "n_original", "mean_net", "mean_net_original"])
    w.writerows(out)
print(f"\nwrote {OUT}")
