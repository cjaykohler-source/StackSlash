"""
Regular withdrawals from a growing account: what each simple, well-known
strategy would have paid out and left behind, month by month, from several
start dates (warehouse data begins 2016-01, so 2000/2008 can't be run).

STRATEGIES (monthly, total return: split-adjusted closes + cash dividends)
  spy          buy and hold SPY
  spy_trend    SPY while its month-end close is above its 200-day SMA, else
               BIL (T-bills)
  momentum     top --top liquid stocks by 12-1 month return (price >= $5,
               21-day average dollar volume >= --floor), equal weight,
               rebalanced monthly, --cost per unit of turnover
  blend        50% spy / 50% momentum, rebalanced monthly

WITHDRAWALS
  Each month pays --rate/12 of the account's trailing-12-month average
  value (a smoothed percentage rule: payouts shrink after bad years
  instead of eating the base).
  --buffer N: N months of withdrawals held in BIL. Payouts come from the
  buffer first; the buffer is refilled from the invested side only at a
  month-end where the invested side's trailing 12-month return is positive
  (never sell into a drawdown to refill it).

These are standard, untuned rules, so all periods are reported together
(there is nothing to overfit).

    research/.venv/bin/python research/withdrawal_sim.py [--rate 0.04] [--buffer 12]
"""
import argparse
import datetime as dt
from pathlib import Path

import duckdb
import numpy as np

ROOT = Path(__file__).resolve().parent
WAREHOUSE = ROOT / "data" / "stackslash.duckdb"
CA = ROOT / "data" / "corporate_actions" / "*.parquet"
OUT = ROOT / "data" / "study_outputs"


def monthly_panel(con, floor):
    """Month-end total-return table for every symbol: (symbol, month, tr, close_raw, dollar21, ret_12_1)."""
    con.execute(f"""
      create temp table divs as
      select symbol, date_trunc('month', ex_date::date) m, sum(rate) div
      from read_parquet('{CA}') where type = 'cash_dividends' and rate > 0 group by 1, 2
    """)
    con.execute("""
      create temp table me as
      with d as (
        select s.symbol, s.date, s.close c, r.close cr, r.close * r.volume dv,
               date_trunc('month', s.date) m,
               row_number() over (partition by s.symbol, date_trunc('month', s.date) order by s.date desc) rk,
               avg(r.close * r.volume) over (partition by s.symbol order by s.date rows between 20 preceding and current row) dollar21
        from wh.sip_bars_daily_split s join wh.sip_bars_daily_raw r using (symbol, date)
        where not (s.volume <= 0 and s.open = s.high and s.high = s.low and s.low = s.close)
      )
      select symbol, m, c, cr, dollar21 from d where rk = 1
    """)
    con.execute("""
      create temp table panel as
      select me.symbol, me.m, me.cr, me.dollar21,
        -- dividends are raw per-share; scale into the split-adjusted series
        (me.c + coalesce(dv.div, 0) * me.c / nullif(me.cr, 0)) / nullif(lag(me.c) over w, 0) - 1 as tr,
        lag(me.c, 1) over w / nullif(lag(me.c, 12) over w, 0) - 1 as ret_12_1,
        lag(me.m, 12) over w = me.m - interval 12 month as full_year
      from me left join divs dv on dv.symbol = me.symbol and dv.m = me.m
      window w as (partition by me.symbol order by me.m)
    """)


def series(con, floor, top, cost):
    months = [r[0] for r in con.execute("select distinct m from panel where symbol = 'SPY' order by 1").fetchall()]
    get = lambda sym: dict(con.execute(f"select m, tr from panel where symbol = '{sym}'").fetchall())
    spy, bil = get("SPY"), get("BIL")
    sma = dict(con.execute("""
      select date_trunc('month', date) m, arg_max(close > sma200, date) from (
        select date, close, avg(close) over (order by date rows between 199 preceding and current row) sma200,
               count(*) over (order by date rows between 199 preceding and current row) n
        from wh.sip_bars_daily_split where symbol = 'SPY'
      ) where n = 200 group by 1
    """).fetchall())

    # momentum: formed at month-end m-1 from info known then, held through m
    rows = con.execute(f"""
      with f as (
        select symbol, m, ret_12_1,
               row_number() over (partition by m order by ret_12_1 desc) rk
        from panel
        where cr >= 5 and dollar21 >= {floor} and full_year and ret_12_1 is not null
          and ret_12_1 < 20 and ret_12_1 > -0.99
      )
      select f.m, f.symbol, coalesce(n.tr, -1.0 * 0) as tr_next, n.m is not null as traded
      from f
      left join panel n on n.symbol = f.symbol and n.m = f.m + interval 1 month
      where f.rk <= {top}
    """).fetchall()
    hold = {}
    for m, s, tr, traded in rows:
        nm = (np.datetime64(m, "M") + 1).astype("datetime64[D]").item()
        # a symbol with no bar next month (delisted mid-way) is booked flat;
        # its last traded price was already in this month's close
        hold.setdefault(nm, []).append((s, tr if traded else 0.0))

    out = {k: [] for k in ("spy", "spy_trend", "momentum", "blend", "bil")}
    prev_mom = set()
    in_spy_prev = True
    for i, m in enumerate(months[1:], 1):
        pm = months[i - 1]
        r_spy, r_bil = spy.get(m), bil.get(m, 0.0) or 0.0
        if r_spy is None:
            continue
        signal = sma.get(pm)
        in_spy = True if signal is None else bool(signal)
        r_tr = r_spy if in_spy else r_bil
        if in_spy != in_spy_prev:
            r_tr -= cost
        in_spy_prev = in_spy
        h = hold.get(m)
        if h:
            names = {s for s, _ in h}
            turnover = 1 - len(names & prev_mom) / len(names) if prev_mom else 1.0
            r_mom = float(np.mean([r for _, r in h])) - cost * 2 * turnover
            prev_mom = names
        else:
            r_mom = np.nan
        out["spy"].append((m, r_spy))
        out["spy_trend"].append((m, r_tr))
        out["momentum"].append((m, r_mom))
        out["blend"].append((m, 0.5 * r_spy + 0.5 * r_mom if not np.isnan(r_mom) else np.nan))
        out["bil"].append((m, r_bil))
    return out


def run(rets, bil, start, capital, rate, buffer_months):
    """Monthly withdrawal replay from `start`; returns summary dict."""
    rets = [(m, r) for m, r in rets if m >= start]
    bil = dict(bil)
    if not rets or any(np.isnan(r) for _, r in rets):
        return None
    invested, buf = capital, 0.0
    if buffer_months:
        buf = capital * rate / 12 * buffer_months
        invested -= buf
    hist, inv_hist, paid, peak, max_dd = [], [], [], capital, 0.0
    for m, r in rets:
        invested *= 1 + r
        buf *= 1 + (bil.get(m) or 0.0)
        total = invested + buf
        hist.append(total)
        inv_hist.append(invested)
        w = rate / 12 * np.mean(hist[-12:])
        if buf >= w:
            buf -= w
        else:
            invested -= w - buf
            buf = 0.0
        paid.append(w)
        if buffer_months and len(inv_hist) >= 13 and inv_hist[-1] > inv_hist[-13]:
            need = rate / 12 * np.mean(hist[-12:]) * buffer_months - buf
            if need > 0:
                take = min(need, invested * 0.5)
                invested -= take
                buf += take
        total = invested + buf
        peak = max(peak, total)
        max_dd = min(max_dd, total / peak - 1)
    paid = np.array(paid)
    by_year = {}
    for (m, _), p in zip(rets, paid):
        by_year[m.year] = by_year.get(m.year, 0) + p
    full = [v for y, v in by_year.items() if sum(1 for mm, _ in rets if mm.year == y) == 12]
    return dict(end=invested + buf, paid=paid.sum(), first12=paid[:12].sum(), min_m=paid.min(),
                worst_year=min(full) if full else np.nan, max_dd=max_dd, months=len(rets))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rate", type=float, default=0.04, help="annual withdrawal rate")
    ap.add_argument("--capital", type=float, default=100_000)
    ap.add_argument("--top", type=int, default=20)
    ap.add_argument("--floor", type=float, default=10_000_000)
    ap.add_argument("--cost", type=float, default=0.002)
    ap.add_argument("--starts", default="2017-02-01,2020-01-01,2022-01-01")
    args = ap.parse_args()

    con = duckdb.connect()
    con.execute(f"attach '{WAREHOUSE}' as wh (read_only)")
    print("building monthly total-return panel...", flush=True)
    monthly_panel(con, args.floor)
    s = series(con, args.floor, args.top, args.cost)
    # drop the current, incomplete month
    this_month = dt.date.today().replace(day=1)
    s = {k: [(m, r) for m, r in v if m < this_month] for k, v in s.items()}

    lines = []

    def out(x=""):
        print(x, flush=True)
        lines.append(x)

    last = s["spy"][-1][0]
    out(f"withdrawal {args.rate:.1%}/yr of trailing-12m average value, paid monthly; capital ${args.capital:,.0f}; through {last:%Y-%m}")
    out("(momentum = top %d by 12-1m return, price >= $5, 21d $vol >= $%s, cost %.1f%% per side)" % (args.top, f"{args.floor:,.0f}", args.cost * 100))
    for start in args.starts.split(","):
        sd = dt.date.fromisoformat(start)
        out(f"\n=== start {sd:%Y-%m} ===")
        out(f"  {'strategy':<11}{'buffer':>7}{'end value':>12}{'total paid':>12}{'paid yr 1':>11}{'min month':>11}{'worst full yr':>15}{'max DD':>9}")
        for name in ("spy", "spy_trend", "momentum", "blend"):
            for bm in (0, 12):
                r = run(s[name], s["bil"], sd, args.capital, args.rate, bm)
                if r is None:
                    out(f"  {name:<11}{bm:>7}  (no data)")
                    continue
                out(f"  {name:<11}{bm:>6}m{r['end']:>12,.0f}{r['paid']:>12,.0f}{r['first12']:>11,.0f}{r['min_m']:>11,.0f}"
                    f"{r['worst_year']:>15,.0f}{r['max_dd']:>9.0%}")

    OUT.mkdir(parents=True, exist_ok=True)
    ts = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    path = OUT / f"withdrawal_sim_{ts}.txt"
    path.write_text("\n".join(lines) + "\n")
    print(f"\nwrote {path}")


if __name__ == "__main__":
    main()
