"""
Portfolio replay of swing_backtest.py's trades: what an account trading the
signal would actually have experienced -- risk-based sizing, a cap on open
positions, no leverage, daily mark-to-market. Trade-level means (the
backtest) are the wrong lens for a trailing-stop system; this is the one
that answers "would the agent's account have grown, and how badly would it
have drawn down along the way?"

RULES (all fixed before looking at results)
  signals     swing_backtest.py's --signal, same eligibility and exits
  ranking     when there are more entries on a day than free slots, take
              the highest 20-day dollar volume first (a liquidity rule, not
              a tuned score)
  sizing      notional = equity x --risk / (initial stop distance / entry),
              capped at --max-pos of equity and --adv-frac of 20-day dollar
              volume; skipped if cash can't cover it; one position per symbol
  costs       as the backtest: net return per trade already includes them
  control     same machinery on random entries: each signal day's entry
              count, drawn at random from that day's eligible rows

    research/.venv/bin/python research/trend_portfolio.py --signal trend \\
        --min-price 5 --max-price 100000 --floor 10000000 --cost 0.002 \\
        --stop-atr 3 --trail-atr 5 --hold 120 [--holdout]
"""
import argparse
import datetime as dt
from pathlib import Path

import duckdb
import numpy as np

from swing_backtest import WAREHOUSE, OUT, load_bars, features, simulate


def replay(b, f, idx, net, exit_row, args, start, end):
    """Day-by-day equity curve for the trades in idx (rows of day t; entry t+1)."""
    ok = ~np.isnan(net) & (exit_row >= 0)
    idx, net, exit_row = idx[ok], net[ok], exit_row[ok]
    entry_row = idx + 1
    entry_px = b["o"][entry_row]
    atr = f["atr14"][idx]
    risk_frac = np.maximum(args.stop_atr * atr, args.min_risk * entry_px) / entry_px
    liq = f["dollar20"][idx]
    edate, xdate = b["date"][entry_row], b["date"][exit_row]
    keep = (edate >= start) & (edate < end)
    order = np.lexsort((-liq[keep], edate[keep]))
    cand = np.flatnonzero(keep)[order]

    days = np.unique(b["date"][(b["date"] >= start) & (b["date"] < end)])
    by_day = {}
    for j in cand:
        by_day.setdefault(edate[j], []).append(j)

    cash, equity0 = args.capital, args.capital
    open_pos = {}  # j -> dict(notional, ptr, symbol)
    held = set()
    curve = np.empty(len(days))
    taken = 0
    expo = np.empty(len(days))
    for di, d in enumerate(days):
        # exits dated today realize at the trade's exit price, net of costs
        for j in [j for j in open_pos if xdate[j] <= d]:
            p = open_pos.pop(j)
            cash += p["notional"] * (1 + net[j])
            held.discard(p["symbol"])
        # mark open positions (yesterday's equity) for sizing
        mtm = 0.0
        for j, p in open_pos.items():
            while p["ptr"] + 1 < len(b["date"]) and b["date"][p["ptr"] + 1] <= d and b["symbol"][p["ptr"] + 1] == p["symbol"]:
                p["ptr"] += 1
            mtm += p["notional"] * b["c"][p["ptr"]] / entry_px[j]
        equity = cash + mtm
        for j in by_day.get(d, []):
            if len(open_pos) >= args.max_positions:
                break
            s = b["symbol"][idx[j]]
            if s in held:
                continue
            notional = min(equity * args.risk / risk_frac[j], equity * args.max_pos, args.adv_frac * liq[j])
            if notional > cash or notional <= 0:
                continue
            cash -= notional
            open_pos[j] = dict(notional=notional, ptr=entry_row[j], symbol=s)
            held.add(s)
            taken += 1
        mtm = sum(p["notional"] * b["c"][p["ptr"]] / entry_px[j] for j, p in open_pos.items())
        curve[di] = cash + mtm
        expo[di] = mtm / curve[di]
    return days, curve / equity0, taken, expo


def stats(days, curve, label, out):
    r = np.diff(curve) / curve[:-1]
    yrs = (days[-1] - days[0]).astype(int) / 365.25
    cagr = curve[-1] ** (1 / yrs) - 1
    vol = r.std() * np.sqrt(252)
    sharpe = r.mean() / r.std() * np.sqrt(252) if r.std() else np.nan
    dd = (curve / np.maximum.accumulate(curve) - 1).min()
    years = days.astype("datetime64[Y]").astype(int) + 1970
    per = []
    for y in np.unique(years):
        m = years == y
        first = np.flatnonzero(m)[0]
        base = curve[first - 1] if first > 0 else 1.0
        per.append(f"{y} {curve[m][-1] / base - 1:+.0%}")
    out(f"  {label:<10} CAGR {cagr:+.1%}  vol {vol:.1%}  Sharpe {sharpe:.2f}  maxDD {dd:.1%}  | " + "  ".join(per))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--signal", choices=("spike", "trend"), default="trend")
    ap.add_argument("--spike", type=float, default=5.0)
    ap.add_argument("--floor", type=float, default=10_000_000)
    ap.add_argument("--hold", type=int, default=120)
    ap.add_argument("--stop-atr", type=float, default=3.0)
    ap.add_argument("--trail-atr", type=float, default=5.0)
    ap.add_argument("--cost", type=float, default=0.002)
    ap.add_argument("--min-price", type=float, default=5.0)
    ap.add_argument("--max-price", type=float, default=100000.0)
    ap.add_argument("--min-risk", type=float, default=0.0)
    ap.add_argument("--capital", type=float, default=100_000)
    ap.add_argument("--risk", type=float, default=0.005, help="equity risked per trade (0.5%)")
    ap.add_argument("--max-positions", type=int, default=20)
    ap.add_argument("--max-pos", type=float, default=0.10, help="max notional per position, fraction of equity")
    ap.add_argument("--adv-frac", type=float, default=0.01, help="max notional, fraction of 20-day dollar volume")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--holdout", action="store_true")
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)

    con = duckdb.connect()
    con.execute(f"attach '{WAREHOUSE}' as wh (read_only)")
    con.execute("use wh")
    b = load_bars(con, args.min_price, args.max_price)
    spy = con.execute("select date, close from sip_bars_daily_split where symbol = 'SPY' order by date").fetchnumpy()
    f, starts, ends = features(b)
    end_of = np.empty(len(b["c"]), int)
    for a, e in zip(starts, ends):
        end_of[a:e] = e

    with np.errstate(invalid="ignore", divide="ignore"):
        elig = (b["date"] >= np.datetime64("2016-01-01")) & (b["cr"] >= args.min_price) & (b["cr"] <= args.max_price) \
            & (f["dollar20"] >= args.floor) & (f["adv20"] > 0) & (f["atr14"] > 0)
        if args.signal == "spike":
            sig = elig & (b["v"] / f["adv20"] >= args.spike)
        else:
            sig = elig & (b["c"] > f["hi50"]) & (b["c"] > f["sma200"]) & (f["sma50"] > f["sma200"])
    idx = np.flatnonzero(sig)
    print(f"{len(idx):,} {args.signal} signals; simulating trades...", flush=True)
    net, _, _, _, xr = simulate(b, f, idx, end_of, args)

    # control: same number of entries per day, random eligible rows of that day
    el = np.flatnonzero(elig)
    el_dates = b["date"][el]
    o = np.argsort(el_dates, kind="stable")
    el, el_dates = el[o], el_dates[o]
    ud, first = np.unique(el_dates, return_index=True)
    cnt = np.diff(np.r_[first, len(el)])
    pos = {d: (s, c) for d, s, c in zip(ud, first, cnt)}
    sd, sc = np.unique(b["date"][idx], return_counts=True)
    cidx = np.concatenate([el[pos[d][0] + rng.integers(0, pos[d][1], k)] for d, k in zip(sd, sc) if d in pos])
    cnet, _, _, _, cxr = simulate(b, f, cidx, end_of, args)

    lines = []

    def out(s=""):
        print(s, flush=True)
        lines.append(s)

    out(f"signal={args.signal} price=${args.min_price:g}-${args.max_price:g} floor=${args.floor:,.0f} stop={args.stop_atr}ATR "
        f"trail={args.trail_atr}ATR hold={args.hold} min_risk={args.min_risk:.0%} cost>={args.cost:.1%} | "
        f"risk/trade={args.risk:.2%} max_positions={args.max_positions} max_pos={args.max_pos:.0%} adv_frac={args.adv_frac:.1%}")
    periods = [("2016-21", np.datetime64("2016-01-01"), np.datetime64("2022-01-01"))]
    if args.holdout:
        periods.append(("2022+", np.datetime64("2022-01-01"), np.datetime64("2100-01-01")))
    sdates, sclose = spy["date"].astype("datetime64[D]"), spy["close"].astype(float)
    for pname, start, end in periods:
        out(f"\n=== {pname} ===")
        days, curve, taken, expo = replay(b, f, idx, net, xr, args, start, end)
        stats(days, curve, "strategy", out)
        out(f"             trades taken {taken:,}, average exposure {expo.mean():.0%}")
        cdays, ccurve, ctaken, cexpo = replay(b, f, cidx, cnet, cxr, args, start, end)
        stats(cdays, ccurve, "random", out)
        out(f"             trades taken {ctaken:,}, average exposure {cexpo.mean():.0%}")
        m = (sdates >= start) & (sdates < end)
        stats(sdates[m], sclose[m] / sclose[m][0], "SPY", out)

    OUT.mkdir(parents=True, exist_ok=True)
    ts = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    path = OUT / f"trend_portfolio_{ts}.txt"
    path.write_text("\n".join(lines) + "\n")
    print(f"\nwrote {path}")


if __name__ == "__main__":
    main()
