"""
Overnight cycle test: on stocks the lead-up flags, buy during the day, sell
at the NEXT open, and repeat daily until an exit signal. Motivated by the
lead-up finding that these stocks gap up overnight and fade intraday.

FLAG (a cycle can start on day t): watchlist profile -- ATR14 >= 8% of
  price and close <= 60% of the 252-session high -- AND volume building:
  day-t volume >= its pre-window normal (mean of t-40..t-21) and the last
  3 days' mean volume > the mean of days t-19..t-15.
ENTRY each cycle day d (the stock is held from d to d+1's open):
  A  at d's close (market-on-close)                          -- realistic
  B  limit at d's open - 0.5 x ATR14 (fills only if d's low reaches it;
     at the open if d gaps below it)                         -- realistic
  C  at d's actual low                                        -- IMPOSSIBLE,
     shown only as the ceiling (nobody knows the low until the close)
EXIT signal (checked each morning after selling; stop cycling when hit):
  X1 after 3 cycles
  X2 when day d's volume falls below the stock's normal (max 10 cycles)
  X3 after the first night that doesn't gap up (next open <= d's close;
     max 10 cycles)
EACH CYCLE return = next open / entry - 1 - cost, cost max(1%, one tick).
CONTROL the same routine started on random eligible stock-days (same days,
  no flag requirement).
SPLIT choose on 2016-2019, score 2020-2021 once; 2022+ stays sealed.

    research/.venv/bin/python research/overnight_cycle.py
"""
import datetime as dt
from pathlib import Path

import duckdb
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view as swv

ROOT = Path(__file__).resolve().parent
WAREHOUSE = ROOT / "data" / "stackslash.duckdb"
OUT = ROOT / "data" / "study_outputs"


def main():
    rng = np.random.default_rng(7)
    con = duckdb.connect()
    con.execute(f"attach '{WAREHOUSE}' as wh (read_only)")
    print("loading bars...", flush=True)
    d = con.execute("""
      with band as (
        select symbol from wh.sip_bars_daily_raw where date >= date '2016-01-01' and close between 0.10 and 5
        group by symbol having count(*) >= 60
      )
      select r.symbol, r.date, r.close rc, r.volume v, s.open o, s.high h, s.low l, s.close c
      from wh.sip_bars_daily_raw r join wh.sip_bars_daily_split s using (symbol, date) join band using (symbol)
      where r.date >= date '2015-06-01' and r.date <= date '2022-01-31'
        and not (r.volume <= 0 and r.open = r.high and r.high = r.low and r.low = r.close)
      order by r.symbol, r.date
    """).fetchnumpy()
    b = {k: np.asarray(v) for k, v in d.items()}
    for k in ("rc", "v", "o", "h", "l", "c"):
        b[k] = b[k].astype(float)
    sym, dates = b["symbol"], b["date"].astype("datetime64[D]")
    O, Hh, L, C, V, rc = b["o"], b["h"], b["l"], b["c"], b["v"], b["rc"]
    n = len(sym)
    starts = np.flatnonzero(np.r_[True, sym[1:] != sym[:-1]])
    ends = np.r_[starts[1:], n]
    end_of = np.repeat(ends, ends - starts)
    year = dates.astype("datetime64[Y]").astype(int) + 1970

    flag = np.zeros(n, bool)
    elig = np.zeros(n, bool)
    atr = np.full(n, np.nan)
    normal_v = np.full(n, np.nan)
    ratio = np.full(n, np.nan)
    for a, e in zip(starts, ends):
        m = e - a
        if m < 80:
            continue
        c, h, l, v, r = C[a:e], Hh[a:e], L[a:e], V[a:e], rc[a:e]
        with np.errstate(invalid="ignore", divide="ignore"):
            pc = np.r_[np.nan, c[:-1]]
            tr = np.fmax(h - l, np.fmax(np.abs(h - pc), np.abs(l - pc)))
            at = np.convolve(np.nan_to_num(tr), np.ones(14) / 14, "full")[:m]
            atr[a:e] = at
            ratio[a:e] = c / pc
            nv = np.full(m, np.nan)
            nv[40:] = swv(v, 20).mean(axis=1)[: m - 40]            # v[t-40..t-21]
            normal_v[a:e] = nv
            last3 = np.convolve(v, np.ones(3) / 3, "full")[:m]
            early = np.full(m, np.nan)
            early[19:] = swv(v, 5).mean(axis=1)[: m - 19]            # v[t-19..t-15]
            hmax = np.maximum.accumulate(h)
            if m >= 252:
                hmax[251:] = swv(h, 252).max(axis=1)
            dv20 = np.convolve(r * v, np.ones(20) / 20, "full")[:m]
            ok = (np.arange(m) >= 60) & (r >= 0.10) & (r <= 5) & (dv20 >= 250_000)
            elig[a:e] = ok
            flag[a:e] = ok & (at / c >= 0.08) & (c / hmax <= 0.60) & (v >= nv) & (last3 > early)

    def run_cycles(t0, entry, exit_rule):
        """Cycle from day t0; returns list of per-cycle net returns."""
        rets = []
        d_ = t0
        cap = 3 if exit_rule == "X1" else 10
        while len(rets) < cap and d_ + 1 < end_of[t0]:
            if not (0.1 < ratio[d_ + 1] < 10):
                break  # split/reorg artifact overnight
            if entry == "A":
                px = C[d_]
            elif entry == "B":
                lim = O[d_] - 0.5 * atr[d_ - 1]
                if L[d_] > lim or lim <= 0:
                    px = np.nan  # not filled today
                else:
                    px = min(lim, O[d_])
            else:
                px = L[d_]
            if not np.isnan(px) and px > 0:
                cost = max(0.01, (0.01 if rc[d_] >= 1 else 0.0001) / rc[d_])
                rets.append(O[d_ + 1] / px - 1 - cost)
            # exit checks (after the morning sale)
            if exit_rule == "X2" and not (V[d_] >= normal_v[d_]):
                break
            if exit_rule == "X3" and O[d_ + 1] <= C[d_]:
                break
            d_ += 1
        return rets

    lines = []

    def out(s=""):
        print(s, flush=True)
        lines.append(s)

    periods = {"2016-19": (year >= 2016) & (year <= 2019), "2020-21": (year >= 2020) & (year <= 2021)}
    out("flagged stock-days: " + ", ".join(f"{p} {int((flag & m).sum()):,}" for p, m in periods.items()))
    results = {}
    for pname, pm in periods.items():
        starts_ix = np.flatnonzero(flag & pm)
        # one cycle start per symbol per 5 sessions, so overlapping flags don't stack the same trades
        keep, last_start = [], {}
        for t in starts_ix:
            s_ = sym[t]
            if s_ not in last_start or t - last_start[s_] >= 5:
                keep.append(t); last_start[s_] = t
        starts_ix = np.array(keep)
        pool = np.flatnonzero(elig & pm)
        pool_dates = dates[pool]
        by_day = {}
        for i, dd in zip(pool, pool_dates):
            by_day.setdefault(dd, []).append(i)
        ctrl = np.array([rng.choice(by_day[dates[t]]) for t in starts_ix])
        out(f"\n=== {pname}: {len(starts_ix):,} cycles started (flag), same number of random starts ===")
        out(f"  {'entry':<16}{'exit':<5}{'trades':>8}{'per-trade mean':>16}{'median':>9}{'win':>6}{'per-cycle total':>17}   | random: mean / cycle total")
        for entry in ("A", "B", "C"):
            for ex in ("X1", "X2", "X3"):
                fr = [run_cycles(t, entry, ex) for t in starts_ix]
                cr = [run_cycles(t, entry, ex) for t in ctrl]
                allf = np.concatenate([np.array(x) for x in fr if x]) if any(fr) else np.array([])
                allc = np.concatenate([np.array(x) for x in cr if x]) if any(cr) else np.array([])
                tot_f = np.mean([np.prod(1 + np.array(x)) - 1 for x in fr if x])
                tot_c = np.mean([np.prod(1 + np.array(x)) - 1 for x in cr if x])
                label = {"A": "A close", "B": "B limit -0.5ATR", "C": "C day LOW (!)"}[entry]
                out(f"  {label:<16}{ex:<5}{len(allf):>8,}{allf.mean():>+15.2%}{np.median(allf):>+9.2%}{np.mean(allf > 0):>6.0%}"
                    f"{tot_f:>+16.1%}   | {allc.mean():+.2%} / {tot_c:+.1%}")
                results[(pname, entry, ex)] = allf.mean() - allc.mean()
    out("\n(C buys at the day's actual low -- impossible in practice; it is the ceiling, not a strategy.)")

    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"overnight_cycle_{dt.datetime.now():%Y%m%dT%H%M%S}.txt"
    path.write_text("\n".join(lines) + "\n")
    print(f"\nwrote {path}")


if __name__ == "__main__":
    main()
