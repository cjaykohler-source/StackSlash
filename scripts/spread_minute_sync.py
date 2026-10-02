"""
Per-symbol round-trip spread estimates from 1-minute SIP bars -> symbol_spread_estimates.

Replaces the weekly pg_cron job refresh-spread-estimates, whose daily
Corwin-Schultz estimate (two-day high/low ranges) overstates spreads 5-15x on
this $0.10-$5 universe: daily ranges are mostly volatility (docs/overnight-cost.md).
Applied to consecutive 1-minute bars, Abdi & Ranaldo's (2017) estimator sees far
less volatility per bar and lands near the effective spread:

  per minute pair:  4 (c_t - eta_t)(c_t - eta_{t+1}), log prices, eta = (log high + log low) / 2,
                    floored at 0
  per session:      sqrt(mean over the session's pairs), regular hours 09:30-15:59 ET, >= 30 bars
  per symbol:       the median of its last 20 sessions' estimates, >= 5 sessions

Read by netlify/functions/lib/tradingCosts.ts roundTripCostPct (which keeps the
one-tick floor) for fire_outcomes.cost_pct and sim-flip-exits. Symbols with too
little minute data keep their previous row. Runs on launchd after the nightly
research-update (minute warehouse), 21:00 ET weekdays.

    research/.venv/bin/python scripts/spread_minute_sync.py            # compute + upsert
    research/.venv/bin/python scripts/spread_minute_sync.py --measure  # compare with the stored values, no writes
"""
from __future__ import annotations

import sys
from pathlib import Path

import duckdb
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from localjobs import Rest, load_env, now_iso  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
DATA = REPO / "research" / "data"
METRICS = DATA / "charter" / "daily_metrics"
MIDX = DATA / "charter" / "minute_index.parquet"
SESSIONS, MIN_SESSIONS, MIN_BARS = 20, 5, 30


def estimates(con: duckdb.DuckDBPyConnection, tickers: list[str]) -> list[tuple]:
    con.execute("create or replace temp table want (symbol varchar)")
    con.executemany("insert into want values (?)", [(t,) for t in tickers])
    days = [r[0] for r in con.execute(f"""
      select distinct date from read_parquet('{METRICS}/*/*.parquet', hive_partitioning = true)
      where symbol = 'SPY' order by date desc limit {SESSIONS}""").fetchall()]
    d0, d1 = min(days), max(days)
    con.execute(f"""
      create or replace temp table f as
      select distinct i.file from read_parquet('{MIDX}') i join want w on w.symbol = i.symbol
      where (i.day between '{d0}' and '{d1}') or (i.day is null and i.month between date_trunc('month', date '{d0}')::date and '{d1}')
    """)
    files = [r[0] for r in con.execute("select file from f").fetchall() if Path(r[0]).exists()]
    con.execute("create or replace temp table mb (symbol varchar, ts timestamp, high double, low double, close double, volume bigint)")
    for k in range(0, len(files), 400):
        con.execute(f"""
          insert into mb
          select m.symbol, m.ts at time zone 'America/New_York', m.high, m.low, m.close, m.volume
          from read_parquet({files[k:k + 400]!r}, union_by_name = true) m join want w on w.symbol = m.symbol
          where (m.ts at time zone 'America/New_York')::date between '{d0}' and '{d1}'
            and (m.ts at time zone 'America/New_York')::time between time '09:30' and time '15:59'
            and m.low > 0 and m.high >= m.low
        """)
    return con.execute(f"""
      with b as (
        select symbol, ts::date d, ln(close) lc, (ln(high) + ln(low)) / 2 eta,
          lead((ln(high) + ln(low)) / 2) over (partition by symbol, ts::date order by ts) eta1, close, volume
        from mb
      ),
      sess as (
        select symbol, d, sqrt(avg(greatest(4 * (lc - eta) * (lc - eta1), 0))) s, count(*) pairs,
          median(close) px, sum(close * volume) dv
        from b where eta1 is not null group by 1, 2 having count(*) >= {MIN_BARS - 1}
      )
      select symbol, median(s) spread, median(px) price, avg(dv) dollar_vol, sum(pairs)::int pairs, count(*) sessions
      from sess group by 1 having count(*) >= {MIN_SESSIONS}
    """).fetchall()


def main() -> None:
    env = load_env()
    rest = Rest(env)
    measure = "--measure" in sys.argv

    def work() -> int:
        syms = rest.active_symbols()
        id_of = {s["ticker"]: s["id"] for s in syms}
        con = duckdb.connect()
        rows = estimates(con, list(id_of))
        print(f"{len(rows):,} of {len(id_of):,} active symbols have >= {MIN_SESSIONS} sessions of minute data", flush=True)
        if measure:
            old = {}
            for off in range(0, 100_000, 1000):
                r = rest.s.get(f"{rest.base}/symbol_spread_estimates", params={"select": "symbol_id,spread_pct", "order": "symbol_id.asc"},
                               headers={"Range": f"{off}-{off + 999}"})
                r.raise_for_status()
                old.update({x["symbol_id"]: float(x["spread_pct"]) for x in r.json() if x["spread_pct"] is not None})
                if len(r.json()) < 1000:
                    break
            con.execute("create or replace temp table cmp (symbol varchar, price double, new double, old double)")
            con.executemany("insert into cmp values (?, ?, ?, ?)",
                            [(s, p, sp, old.get(id_of[s])) for s, sp, p, _, _, _ in rows])
            for line in con.execute("""
              select case when price < 0.5 then 'a $0.10-0.50' when price < 1 then 'b $0.50-1' when price < 2 then 'c $1-2'
                          when price < 5 then 'd $2-5' when price < 15 then 'e $5-15' else 'f $15+' end bucket,
                count(*) n, median(new) new_med, median(old) old_med, median(old / nullif(new, 0)) ratio_med,
                quantile_cont(old / nullif(new, 0), 0.25) r25, quantile_cont(old / nullif(new, 0), 0.75) r75
              from cmp where old is not null and new > 0 group by 1 order by 1""").fetchall():
                b, n, nm, om, rm, r25, r75 = line
                print(f"  {b[2:]:<12} n={n:5,}  minute {nm:.2%}  daily (stored) {om:.2%}  stored/minute median {rm:.1f}x (IQR {r25:.1f}-{r75:.1f}x)")
            return 0
        now = now_iso()
        out = [dict(symbol_id=id_of[s], spread_pct=round(sp, 6), median_price=round(p, 6), avg_dollar_vol=round(dv, 2),
                    pairs_used=pairs, computed_at=now, method="ar_minute_20d")
               for s, sp, p, dv, pairs, _ in rows]
        rest.upsert("symbol_spread_estimates", out, "symbol_id")
        print(f"upserted {len(out):,} rows", flush=True)
        return len(out)

    if measure:
        work()
    else:
        rest.run("spread-minute-sync", work)


if __name__ == "__main__":
    try:
        main()
    except requests.HTTPError as e:
        print(f"HTTP error: {e} {e.response.text[:300] if e.response is not None else ''}", flush=True)
        raise
