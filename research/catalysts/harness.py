"""
Catalyst test harness: every catalyst type from every source table in
research/data/catalysts/*.parquet (see sources.py) through one standard
event study, with the same controls, and every test logged.

ENTRY / OUTCOME
  Entry at the close of the first session strictly AFTER event_date (public
  by then whatever time it was accepted). Gates at entry: raw close
  --min-price to --max-price, 20-day dollar volume >= --floor. Outcome:
  split-adjusted return over the next 5 and 20 sessions, net of
  max(--cost, one tick), artifact-guarded, winsorized 1/99, reported as
  EXCESS over the same day's average for every gated row.
  One event per (type, symbol, entry session).

CONTROLS
  null   each symbol's events of that type rotated to a random other point
         in the same symbol's history (>= 60 sessions away) --reps times:
         keeps WHICH names have the catalyst, breaks WHEN. p = share of
         rotations with excess >= observed (one-sided, both directions
         reported via the sign of the effect).
  CI     symbol-clustered bootstrap 90% interval on mean excess.
  q      Benjamini-Hochberg across every type in the run (discovery
         period, 20-session horizon) -- a type is a candidate only if
         q <= 0.10 AND its CI excludes the null median on the same side
         (the effect is the gap to the same names at random dates, not to
         zero).
  Returns are price-only (split-adjusted, no dividends), so dividend
  events are shown but never flagged: a 20-session window around a
  monthly payer's next ex-date drops by the dividend mechanically.

LOG
  Every (run, type, period, horizon) row goes to
  research/data/catalysts/registry.duckdb, so later "winners" can be
  judged against how many things were ever tried.

2022+ is only computed with --holdout. Run it once per candidate.

    research/.venv/bin/python research/catalysts/harness.py [--types 8k_1.01,13d_new] [--holdout]
"""
import argparse
import datetime as dt
import sys
from pathlib import Path

import duckdb
import numpy as np

RESEARCH = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(RESEARCH))
from swing_backtest import WAREHOUSE, load_bars, features  # noqa: E402

CAT = RESEARCH / "data" / "catalysts"
REGISTRY = CAT / "registry.duckdb"
HORIZONS = (5, 20)


def fwd_excess(b, f, elig, starts, ends, h, cost):
    """Per-row winsorized net forward return minus the same day's gated mean, and the winsorized
    net return itself (not de-meaned). The cost is in both terms of the excess, so it cancels there;
    the net return is the one that says whether the trade itself made money after costs."""
    n = len(b["c"])
    c, ratio = b["c"], f["ratio"]
    r = np.full(n, np.nan)
    bad = ((ratio >= 10) | (ratio <= 0.1)).astype(np.int64)
    cb = np.r_[0, np.cumsum(bad)]
    for a, e in zip(starts, ends):
        if e - a > h:
            i = np.arange(a, e - h)
            clean = (cb[i + h + 1] - cb[i + 1]) == 0
            r[i] = np.where(clean, c[i + h] / c[i] - 1, np.nan)
    tick = np.where(b["cr"] >= 1, 0.01, 0.0001) / b["cr"]
    net = r - np.maximum(cost, tick)
    ok = elig & ~np.isnan(net)
    lo, hi = np.quantile(net[ok], [0.01, 0.99])
    w = np.clip(net, lo, hi)
    d = b["date"].astype("int64")
    ud, inv = np.unique(d[ok], return_inverse=True)
    mean = np.bincount(inv, weights=w[ok]) / np.bincount(inv)
    base = np.full(n, np.nan)
    pos = np.searchsorted(ud, d)
    pos = np.clip(pos, 0, len(ud) - 1)
    has = ud[pos] == d
    base[has] = mean[pos[has]]
    x = np.where(ok, w - base, np.nan)
    return x, np.where(ok, w, np.nan)


def load_events(types):
    con = duckdb.connect()
    q = f"select symbol, event_date, source, type from read_parquet('{CAT}/*.parquet', union_by_name=true) where event_date >= date '2015-12-01'"
    if types:
        q += " and type in (" + ", ".join(f"'{t}'" for t in types) + ")"
    ev = con.execute(q).fetchnumpy()
    return {k: np.asarray(v) for k, v in ev.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-price", type=float, default=0.10)
    ap.add_argument("--max-price", type=float, default=15.0)
    ap.add_argument("--floor", type=float, default=250_000)
    ap.add_argument("--cost", type=float, default=0.01)
    ap.add_argument("--reps", type=int, default=1000)
    ap.add_argument("--boot", type=int, default=300)
    ap.add_argument("--min-n", type=int, default=200)
    ap.add_argument("--min-shift", type=int, default=60)
    ap.add_argument("--types", default="", help="comma-separated subset")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--holdout", action="store_true")
    ap.add_argument("--match-ret", action="store_true",
                    help="null only counts rotated dates whose trailing 20-session return is in the same quintile "
                         "as the real event's (separates a catalyst from plain mean reversion / momentum)")
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)
    run_ts = dt.datetime.now().strftime("%Y%m%dT%H%M%S")

    con = duckdb.connect()
    con.execute(f"attach '{WAREHOUSE}' as wh (read_only)")
    con.execute("use wh")
    b = load_bars(con, args.min_price, args.max_price)
    f, starts, ends = features(b)
    n = len(b["c"])
    sym = b["symbol"]
    early = b["date"] < np.datetime64("2022-01-01")
    with np.errstate(invalid="ignore"):
        elig = (b["date"] >= np.datetime64("2016-01-01")) & (b["cr"] >= args.min_price) & (b["cr"] <= args.max_price) \
            & (f["dollar20"] >= args.floor)
    print("forward returns...", flush=True)
    XN = {h: fwd_excess(b, f, elig, starts, ends, h, args.cost) for h in HORIZONS}
    X = {h: XN[h][0] for h in HORIZONS}
    NET = {h: XN[h][1] for h in HORIZONS}
    # the gated universe's mean net return per period: what buying random in-band stocks returned
    base_net = {(pn, h): float(np.nanmean(NET[h][elig & (early == pf)])) for pn, pf in
                [("2016-21", True), ("2022+", False)] for h in HORIZONS}
    qbin = np.zeros(n, int)
    if args.match_ret:
        local_all = np.arange(n) - np.repeat(starts, ends - starts)
        lag = np.r_[np.full(20, np.nan), b["c"][:-20]]
        with np.errstate(invalid="ignore", divide="ignore"):
            ret20 = np.where(local_all >= 20, b["c"] / lag - 1, np.nan)
        ok = elig & ~np.isnan(ret20)
        edges = np.quantile(ret20[ok], [0.2, 0.4, 0.6, 0.8])
        qbin = np.where(ok, np.searchsorted(edges, ret20), -1)
        print(f"  trailing-20d return quintile edges: {np.round(edges * 100, 1)}%", flush=True)

    # symbol -> (start, end); row -> symbol id
    sid = np.repeat(np.arange(len(starts)), ends - starts)
    lens = ends - starts
    sym_index = {s: i for i, s in enumerate(sym[starts])}

    print("mapping events to entry sessions...", flush=True)
    ev = load_events([t for t in args.types.split(",") if t])
    ev_sid = np.array([sym_index.get(s, -1) for s in ev["symbol"]])
    keep = ev_sid >= 0
    ev_sid, ev_date, ev_type, ev_src = ev_sid[keep], ev["event_date"][keep].astype("datetime64[D]"), ev["type"][keep], ev["source"][keep]
    dates = b["date"]
    entry = np.full(len(ev_sid), -1)
    for s in np.unique(ev_sid):
        m = ev_sid == s
        a, e = starts[s], ends[s]
        k = np.searchsorted(dates[a:e], ev_date[m], side="right")
        entry[m] = np.where(k < e - a, a + k, -1)
    ok = entry >= 0
    entry, ev_sid, ev_type, ev_src = entry[ok], ev_sid[ok], ev_type[ok], ev_src[ok]
    ok = elig[entry]
    entry, ev_sid, ev_type, ev_src = entry[ok], ev_sid[ok], ev_type[ok], ev_src[ok]
    print(f"  {len(entry):,} gated events", flush=True)

    periods = [("2016-21", True)] + ([("2022+", False)] if args.holdout else [])
    results = []
    types = sorted(set(ev_type))
    for t in types:
        m = ev_type == t
        rows = np.unique(entry[m])
        src = ev_src[m][0]
        rsid = sid[rows]
        local = rows - starts[rsid]
        span = lens[rsid]
        for pname, pflag in periods:
            for h in HORIZONS:
                x = X[h]
                sel = rows[(early[rows] == pflag) & ~np.isnan(x[rows]) & (qbin[rows] >= 0)]
                if len(sel) < args.min_n:
                    continue
                obs = x[sel].mean()
                # null: rotate each symbol's events within its own history
                null = np.empty(args.reps)
                for r in range(args.reps):
                    kk = args.min_shift + rng.integers(0, np.maximum(lens - 2 * args.min_shift, 1))
                    sh = starts[rsid] + (local + kk[rsid]) % span
                    v = x[sh]
                    v = v[(early[sh] == pflag) & elig[sh] & ~np.isnan(v) & (qbin[rows] >= 0) & (qbin[sh] == qbin[rows])]
                    null[r] = v.mean() if len(v) else np.nan
                p_hi = (np.sum(null >= obs) + 1) / (np.sum(~np.isnan(null)) + 1)
                p_lo = (np.sum(null <= obs) + 1) / (np.sum(~np.isnan(null)) + 1)
                # symbol-clustered bootstrap
                ss = sid[sel]
                us, inv = np.unique(ss, return_inverse=True)
                tot, cnt = np.bincount(inv, weights=x[sel]), np.bincount(inv)
                bm = np.empty(args.boot)
                for i in range(args.boot):
                    w = np.bincount(rng.integers(0, len(us), len(us)), minlength=len(us))
                    bm[i] = (w @ tot) / max(w @ cnt, 1)
                lo, hi = np.percentile(bm, [5, 95])
                results.append(dict(run_ts=run_ts, source=src, type=t, period=pname, h=h, n=len(sel), syms=len(us),
                                    mean_x=obs, ci_lo=lo, ci_hi=hi, null_med=np.nanmedian(null),
                                    p=min(p_hi, p_lo), p_hi=p_hi, p_lo=p_lo,
                                    direction="above_null" if p_hi <= p_lo else "below_null",
                                    mean_net=float(NET[h][sel].mean()), base_net=base_net[(pname, h)]))
        print(f"  tested {t}", flush=True)

    # Benjamini-Hochberg on the discovery period, 20-session horizon
    disc = [r for r in results if r["period"] == "2016-21" and r["h"] == 20]
    ps = np.array([r["p"] for r in disc])
    order = np.argsort(ps)
    q = np.empty(len(ps))
    prev = 1.0
    for rank in range(len(ps), 0, -1):
        i = order[rank - 1]
        prev = min(prev, ps[i] * len(ps) / rank)
        q[i] = prev
    for r, qq in zip(disc, q):
        r["q"] = qq
    for r in results:
        r.setdefault("q", np.nan)
        # the effect is the gap to the same names' rotated null, not to zero
        r["candidate"] = bool(r["period"] == "2016-21" and r["h"] == 20 and r["q"] <= 0.10
                              and not r["type"].startswith("ca_cash_dividends")
                              and ((r["direction"] == "above_null" and r["ci_lo"] > r["null_med"])
                                   or (r["direction"] == "below_null" and r["ci_hi"] < r["null_med"])))

    CAT.mkdir(parents=True, exist_ok=True)
    reg = duckdb.connect(str(REGISTRY))
    reg.execute("""create table if not exists tests (run_ts varchar, source varchar, type varchar, period varchar, h int,
                   n int, syms int, mean_x double, ci_lo double, ci_hi double, null_med double, p double, q double,
                   direction varchar, candidate boolean, min_price double, max_price double, floor double)""")
    reg.executemany("insert into tests values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    [(r["run_ts"], r["source"], r["type"], r["period"], r["h"], r["n"], r["syms"], r["mean_x"], r["ci_lo"],
                      r["ci_hi"], r["null_med"], r["p"], r["q"], r["direction"], r["candidate"],
                      args.min_price, args.max_price, args.floor) for r in results])
    total = reg.execute("select count(distinct type) from tests where period = '2016-21'").fetchone()[0]
    # full rows (incl. one-sided p and absolute net returns, which the registry table lacks) per run
    import json
    (CAT / "runs").mkdir(exist_ok=True)
    (CAT / "runs" / f"{run_ts}.json").write_text(json.dumps(dict(
        run_ts=run_ts, args=vars(args), results=[{k: (float(v) if isinstance(v, (np.floating, float)) else v)
                                                   for k, v in r.items()} for r in results]), indent=1, default=str))

    print(f"\n${args.min_price:g}-${args.max_price:g}, floor ${args.floor:,.0f}, cost>={args.cost:.0%}; "
          f"{len(disc)} types tested this run, {total} distinct types ever logged")
    for pname, _ in periods:
        print(f"\n=== {pname} (sorted by 20-session excess) ===")
        print(f"  {'type':<24}{'src':<6}{'n':>8}{'syms':>6}{'x5':>8}{'x20':>8}{'90% CI (20d)':>18}{'null':>8}{'gap':>7}{'p':>7}{'q':>7}")
        by = {}
        for r in results:
            if r["period"] == pname:
                by.setdefault(r["type"], {})[r["h"]] = r
        for t, hh in sorted(by.items(), key=lambda kv: kv[1].get(20, {}).get("mean_x", 0) - kv[1].get(20, {}).get("null_med", 0)):
            r20, r5 = hh.get(20), hh.get(5)
            if not r20:
                continue
            flag = "  <- candidate" if r20["candidate"] else ""
            print(f"  {t:<24}{r20['source'][:5]:<6}{r20['n']:>8,}{r20['syms']:>6,}{(r5['mean_x'] if r5 else np.nan)*100:>7.2f}%"
                  f"{r20['mean_x']*100:>7.2f}% [{r20['ci_lo']*100:>6.2f},{r20['ci_hi']*100:>6.2f}]{r20['null_med']*100:>7.2f}%"
                  f"{(r20['mean_x'] - r20['null_med'])*100:>6.2f}%{r20['p']:>7.3f}{r20['q']:>7.3f}{flag}")
    print(f"\nlogged to {REGISTRY} and {CAT / 'runs' / (run_ts + '.json')}")


if __name__ == "__main__":
    main()
