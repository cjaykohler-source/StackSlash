"""
Phase 1 of the agentic-trader plan: does trading the volume-spike signal
(docs/breakout-study.md, "Noise floor" -- the one breakout precursor that
carries timing information) make money after costs? Trade-level only; a
portfolio simulation (capital, position caps, overlap) comes after, if
this survives.

SIGNAL (known at the session close, day t)
  volume >= --spike x its prior-20-session average, raw close in the
  $0.10-$5 band, 20-day dollar volume >= --floor, no zero-volume
  placeholder bar. Variants split it by the spike day's direction.

TRADE (split-adjusted prices, entries/exits never use day t's future)
  entry   open of t+1
  stop    entry - --stop-atr x ATR14 (ATR as of t). Gap through the stop
          fills at the open, not the stop.
  trail   chandelier: stop ratchets to highest high since entry
          - --trail-atr x ATR14 ("let winners run")
  time    close of t+--hold if nothing else hit
  cost    round trip max(--cost, one tick / price), as daily_trigger_study.py
  A trade whose path has a >=10x or <=0.1x daily ratio is dropped
  (split/reorg artifact), and counted.

CONTROL
  For every trade, one random eligible day (same band, same floor, same
  period, any symbol) traded with identical rules. A signal has to beat
  zero AND the control, net of costs.

VARIANTS
  all, up_day (close > open on t), down_day, and point-in-time EDGAR
  exclusions from daily_trigger_study.py: excl_offer (S-1/S-3/F-1/F-3/
  424B4/424B5 in the prior 30 days), excl_red (nano-cap < $50M, shares
  +50% YoY, <= 2 quarters of cash runway).

HOLDOUT
  Exits and variants get tuned on 2016-21 only. 2022+ is printed only
  with --holdout, and should be run once, at the end.

    research/.venv/bin/python research/swing_backtest.py [--floor 250000] [--holdout]
"""
import argparse
import datetime as dt
from pathlib import Path

import duckdb
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view as swv

ROOT = Path(__file__).resolve().parent
WAREHOUSE = ROOT / "data" / "stackslash.duckdb"
EDGAR = ROOT / "data" / "edgar"
OUT = ROOT / "data" / "study_outputs"
OFFER_FORMS = ("S-1", "S-3", "F-1", "F-3", "424B4", "424B5")


def load_bars(con, min_price=0.10, max_price=5.0):
    print(f"loading SIP daily bars for symbols trading ${min_price:g}-${max_price:g}...", flush=True)
    d = con.execute(f"""
      with band as (
        select symbol from sip_bars_daily_raw
        where date >= date '2016-01-01' and close between {min_price} and {max_price}
        group by symbol having count(*) >= 60
      )
      select s.symbol, s.date, s.open o, s.high h, s.low l, s.close c, s.volume v, r.close cr
      from sip_bars_daily_split s
      join sip_bars_daily_raw r using (symbol, date)
      join band using (symbol)
      where s.date >= date '2015-06-01'
        and not (s.volume <= 0 and s.open = s.high and s.high = s.low and s.low = s.close)
      order by s.symbol, s.date
    """).fetchnumpy()
    out = {k: np.asarray(v) for k, v in d.items()}
    for k in ("o", "h", "l", "c", "v", "cr"):
        out[k] = out[k].astype(float)
    out["date"] = out["date"].astype("datetime64[D]")
    print(f"  {len(out['c']):,} bars, {len(np.unique(out['symbol'])):,} symbols", flush=True)
    return out


def features(b):
    """Per-row prior-session features, computed within each symbol."""
    sym = b["symbol"]
    n = len(sym)
    starts = np.flatnonzero(np.r_[True, sym[1:] != sym[:-1]])
    ends = np.r_[starts[1:], n]
    f = {k: np.full(n, np.nan) for k in ("adv20", "dollar20", "atr14", "ratio", "sma50", "sma200", "hi50")}
    for a, e in zip(starts, ends):
        c, h, l, v, cr = b["c"][a:e], b["h"][a:e], b["l"][a:e], b["v"][a:e], b["cr"][a:e]
        m = e - a
        pc = np.r_[np.nan, c[:-1]]
        tr = np.fmax(h - l, np.fmax(np.abs(h - pc), np.abs(l - pc)))
        cs_v = np.r_[0, np.cumsum(v)]
        cs_d = np.r_[0, np.cumsum(cr * v)]
        cs_t = np.r_[0, np.cumsum(np.nan_to_num(tr))]
        i = np.arange(m)
        ok20 = i >= 20
        f["adv20"][a:e] = np.where(ok20, (cs_v[i] - cs_v[np.maximum(i - 20, 0)]) / 20, np.nan)
        f["dollar20"][a:e] = np.where(ok20, (cs_d[i] - cs_d[np.maximum(i - 20, 0)]) / 20, np.nan)
        # ATR14 through day t inclusive (known at t's close)
        ok14 = i >= 14
        f["atr14"][a:e] = np.where(ok14, (cs_t[i + 1] - cs_t[np.maximum(i + 1 - 14, 0)]) / 14, np.nan)
        f["ratio"][a:e] = c / pc
        # trend state through day t inclusive; hi50 = highest close of the 50 sessions BEFORE t
        cs_c = np.r_[0, np.cumsum(c)]
        f["sma50"][a:e] = np.where(i >= 49, (cs_c[i + 1] - cs_c[np.maximum(i + 1 - 50, 0)]) / 50, np.nan)
        f["sma200"][a:e] = np.where(i >= 199, (cs_c[i + 1] - cs_c[np.maximum(i + 1 - 200, 0)]) / 200, np.nan)
        if m > 50:
            f["hi50"][a + 50:e] = swv(c[:-1], 50).max(axis=1)[: m - 50]
    return f, starts, ends


def simulate(b, f, idx, end_of, args):
    """Trade each signal row in idx; returns (net_ret, r_mult, days, reason, exit_row), NaN when dropped.

    The initial risk is max(--stop-atr x ATR14, --min-risk x entry): a floor on
    the stop distance, so a tiny ATR can't turn an ordinary move into a 50R trade."""
    O, H, L, C = b["o"], b["h"], b["l"], b["c"]
    ratio = f["ratio"]
    k = len(idx)
    net = np.full(k, np.nan)
    rmult = np.full(k, np.nan)
    days = np.zeros(k, int)
    reason = np.empty(k, dtype=object)
    exit_row = np.full(k, -1)
    for j, t in enumerate(idx):
        e = t + 1
        last = min(t + args.hold, end_of[t] - 1)
        if e > last:
            continue
        seg = ratio[e:last + 1]
        if np.any((seg >= 10) | (seg <= 0.1)):
            reason[j] = "artifact"
            continue
        atr = f["atr14"][t]
        entry = O[e]
        if not (entry > 0 and atr > 0):
            continue
        risk = max(args.stop_atr * atr, args.min_risk * entry)
        stop = entry - risk
        hh = -np.inf
        exit_px, why, i = None, "time", e
        for i in range(e, last + 1):
            if i > e and O[i] <= stop:
                exit_px, why = O[i], "stop_gap"
                break
            if L[i] <= stop:
                exit_px, why = stop, "stop"
                break
            hh = max(hh, H[i])
            stop = max(stop, hh - args.trail_atr * atr)
        if exit_px is None:
            exit_px = C[last]
        cost = max(args.cost, (0.01 if b["cr"][t] >= 1 else 0.0001) / b["cr"][t])
        gross = exit_px / entry - 1
        net[j] = gross - cost
        rmult[j] = (exit_px - entry - cost * entry) / risk
        days[j] = i - e + 1
        reason[j] = why
        exit_row[j] = i
    return net, rmult, days, reason, exit_row


def edgar_flags(con, sig_sym, sig_date, price):
    """Point-in-time offer30 / nano / dilution50 / runway2q per signal (daily_trigger_study.py logic)."""
    e = str(EDGAR)
    con.execute("create or replace temp table sig as select * from (select unnest(?) symbol, unnest(?) date, unnest(?) price, unnest(?) k)",
                [list(sig_sym), [d.item() for d in sig_date], list(price), list(range(len(price)))])
    con.execute(f"""
      create or replace temp table ticker_cik as
      select ticker, min(cik) cik from (
        select ticker, cik from read_parquet('{e}/edgar_tickers.parquet')
        union select unnest(tickers) ticker, cik from read_parquet('{e}/edgar_companies.parquet')
      ) group by ticker
    """)
    con.execute(f"""
      create or replace temp table sh as
      select cik, filed::date filed, max(val) shares from read_parquet('{e}/edgar_facts.parquet')
      where concept in ('EntityCommonStockSharesOutstanding', 'CommonStockSharesOutstanding') and unit = 'shares' and val > 0
      group by 1, 2 order by 1, 2
    """)
    con.execute(f"""
      create or replace temp table cash as
      select cik, filed::date filed, max(val) cash from read_parquet('{e}/edgar_facts.parquet')
      where concept = 'CashAndCashEquivalentsAtCarryingValue' and unit = 'USD'
      group by 1, 2 order by 1, 2
    """)
    con.execute(f"""
      create or replace temp table burn as
      select cik, filed::date filed,
             max(case when val < 0 then -val * 91.0 / date_diff('day', "start"::date, "end"::date) end) burn_q
      from read_parquet('{e}/edgar_facts.parquet')
      where concept = 'NetCashProvidedByUsedInOperatingActivities' and unit = 'USD'
        and start is not null and date_diff('day', "start"::date, "end"::date) between 80 and 370
      group by 1, 2 order by 1, 2
    """)
    forms = ", ".join(f"'{x}'" for x in OFFER_FORMS)
    con.execute(f"""
      create or replace temp table offers as
      select cik, filing_date::date fd from read_parquet('{e}/edgar_filings.parquet') where form in ({forms})
    """)
    rows = con.execute("""
      with base as (
        select s.*, tc.cik, s.date - interval 365 day as date_1y from sig s left join ticker_cik tc on tc.ticker = s.symbol
      ),
      s_now as (select b.*, sh.shares from base b asof left join sh on b.cik = sh.cik and b.date >= sh.filed),
      s_1y as (select b.*, sh.shares shares_1y from s_now b asof left join sh on b.cik = sh.cik and b.date_1y >= sh.filed),
      c_now as (select b.*, cash.cash from s_1y b asof left join cash on b.cik = cash.cik and b.date >= cash.filed),
      bn as (select b.*, burn.burn_q from c_now b asof left join burn on b.cik = burn.cik and b.date >= burn.filed)
      select bn.k,
        exists(select 1 from offers o where o.cik = bn.cik and o.fd between bn.date - interval 30 day and bn.date) offer30,
        coalesce(bn.shares * bn.price < 50e6, false)
          or coalesce(bn.shares_1y > 0 and bn.shares / bn.shares_1y - 1 >= 0.5, false)
          or coalesce(bn.burn_q > 0 and bn.cash / bn.burn_q <= 2, false) as red,
        coalesce(bn.shares * bn.price < 10e6, false)
          or coalesce(bn.shares_1y > 0 and bn.shares / bn.shares_1y - 1 >= 1.0, false) as dil_state
      from bn order by bn.k
    """).fetchnumpy()
    offer30 = np.asarray(rows["offer30"], bool)
    # the rule validated on 2022+ by filing_state_study.py: offering form in 30d,
    # shares >= 2x a year ago, or market cap < $10M
    return offer30, np.asarray(rows["red"], bool), offer30 | np.asarray(rows["dil_state"], bool)


def summarize(net, rmult, rng, boot, sym):
    ok = ~np.isnan(net)
    x, r, s = net[ok], rmult[ok], sym[ok]
    if len(x) < 30:
        return None
    q99 = np.quantile(x, 0.99)
    wins, losses = x[x > 0].sum(), -x[x < 0].sum()
    # symbol-clustered bootstrap on mean net
    us, inv = np.unique(s, return_inverse=True)
    tot = np.bincount(inv, weights=x)
    tot_r = np.bincount(inv, weights=r)
    cnt = np.bincount(inv)
    bm, br = np.empty(boot), np.empty(boot)
    for i in range(boot):
        w = np.bincount(rng.integers(0, len(us), len(us)), minlength=len(us))
        bm[i] = (w @ tot) / max(w @ cnt, 1)
        br[i] = (w @ tot_r) / max(w @ cnt, 1)
    lo, hi = np.percentile(bm, [5, 95])
    rlo, rhi = np.percentile(br, [5, 95])
    return dict(medr=np.median(r), capr=np.clip(r, None, 10).mean(), n=len(x), win=(x > 0).mean(), mean=x.mean(), med=np.median(x), ex1=x[x < q99].mean(),
                pf=wins / losses if losses else np.nan, r=r.mean(), lo=lo, hi=hi, rlo=rlo, rhi=rhi)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--signal", choices=("spike", "trend"), default="spike",
                    help="spike: volume >= --spike x adv20. trend: new 50-session closing high, "
                         "close > SMA200, SMA50 > SMA200")
    ap.add_argument("--spike", type=float, default=5.0)
    ap.add_argument("--floor", type=float, default=250_000, help="20-day dollar-volume floor")
    ap.add_argument("--hold", type=int, default=20)
    ap.add_argument("--stop-atr", type=float, default=2.0)
    ap.add_argument("--trail-atr", type=float, default=3.0)
    ap.add_argument("--cost", type=float, default=0.01, help="round-trip cost floor (0.002 is realistic above $5)")
    ap.add_argument("--min-price", type=float, default=0.10)
    ap.add_argument("--max-price", type=float, default=5.0)
    ap.add_argument("--min-risk", type=float, default=0.0, help="floor on the initial stop distance, fraction of entry")
    ap.add_argument("--boot", type=int, default=500)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--holdout", action="store_true", help="also report 2022+ (run once, at the end)")
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)

    con = duckdb.connect()
    con.execute(f"attach '{WAREHOUSE}' as wh (read_only)")
    con.execute("use wh")
    b = load_bars(con, args.min_price, args.max_price)
    con.execute("use memory")
    f, starts, ends = features(b)
    n = len(b["c"])
    end_of = np.empty(n, int)
    for a, e in zip(starts, ends):
        end_of[a:e] = e

    in2016 = b["date"] >= np.datetime64("2016-01-01")
    early = b["date"] < np.datetime64("2022-01-01")
    with np.errstate(invalid="ignore", divide="ignore"):
        elig = in2016 & (b["cr"] >= args.min_price) & (b["cr"] <= args.max_price) & (f["dollar20"] >= args.floor) & (f["adv20"] > 0) & (f["atr14"] > 0)
        if args.signal == "spike":
            sig = elig & (b["v"] / f["adv20"] >= args.spike)
        else:
            sig = elig & (b["c"] > f["hi50"]) & (b["c"] > f["sma200"]) & (f["sma50"] > f["sma200"])
    up = b["c"] > b["o"]

    idx = np.flatnonzero(sig)
    print(f"{len(idx):,} {args.signal} signals (floor ${args.floor:,.0f})", flush=True)
    net, rm, days, why, _ = simulate(b, f, idx, end_of, args)
    print(f"  dropped as artifacts: {(why == 'artifact').sum():,}", flush=True)

    # control: one random eligible day per signal, same period
    pool_e, pool_l = np.flatnonzero(elig & early), np.flatnonzero(elig & ~early)
    cidx = np.where(early[idx], rng.choice(pool_e, len(idx)), rng.choice(pool_l, len(idx)))
    cnet, crm, _, _, _ = simulate(b, f, cidx, end_of, args)
    offer30, red, dil = edgar_flags(con, b["symbol"][idx], b["date"][idx], b["cr"][idx])
    c_offer30, c_red, c_dil = edgar_flags(con, b["symbol"][cidx], b["date"][cidx], b["cr"][cidx])

    # (signal mask, control mask): a filter variant filters the control the same way
    ones = np.ones(len(idx), bool)
    variants = {
        "all": (ones, ones),
        "up_day": (up[idx], up[cidx]),
        "down_day": (~up[idx], ~up[cidx]),
        "excl_offer": (~offer30, ~c_offer30),
        "excl_red": (~red, ~c_red),
        "excl_dilution": (~dil, ~c_dil),
        "excl_dil_red": (~dil & ~red, ~c_dil & ~c_red),
    }
    periods = [("2016-21", early[idx])] + ([("2022+", ~early[idx])] if args.holdout else [])

    lines = []

    def out(s=""):
        print(s, flush=True)
        lines.append(s)

    out(f"\nsignal={args.signal} spike>={args.spike}x floor=${args.floor:,.0f} price=${args.min_price:g}-${args.max_price:g} min_risk={args.min_risk:.0%} hold={args.hold} stop={args.stop_atr}ATR trail={args.trail_atr}ATR cost>={args.cost:.0%}")
    hdr = f"  {'variant':<14}{'n':>7}{'win':>6}{'mean':>8}{'median':>8}{'ex-top1%':>9}{'PF':>6}{'medR':>6}{'capR':>6}{'avgR':>7} [90% CI]    90% CI mean    | control mean  avgR [90% CI]"
    for pname, pm in periods:
        out(f"\n=== {pname} ===")
        out(hdr)
        for vname, (vm, cvm) in variants.items():
            m, cm = pm & vm, pm & cvm
            s = summarize(net[m], rm[m], rng, args.boot, b["symbol"][idx][m])
            c = summarize(cnet[cm], crm[cm], rng, 300, b["symbol"][cidx][cm])
            if s is None:
                out(f"  {vname:<14} too few")
                continue
            out(f"  {vname:<14}{s['n']:>7,}{s['win']*100:>5.0f}%{s['mean']*100:>7.2f}%{s['med']*100:>7.2f}%{s['ex1']*100:>8.2f}%"
                f"{s['pf']:>6.2f}{s['medr']:>6.2f}{s['capr']:>6.2f}{s['r']:>7.2f} [{s['rlo']:.2f},{s['rhi']:.2f}]  [{s['lo']*100:>5.2f}%,{s['hi']*100:>5.2f}%]  | {c['mean']*100:>7.2f}% capR {c['capr']:>5.2f} avg {c['r']:>5.2f} [{c['rlo']:.2f},{c['rhi']:.2f}]")
        m = pm & ~np.isnan(net)
        reasons, counts = np.unique(why[m].astype(str), return_counts=True)
        out("  exits: " + ", ".join(f"{r} {c / m.sum():.0%}" for r, c in zip(reasons, counts)) + f"; median days held {np.median(days[m]):.0f}")

    OUT.mkdir(parents=True, exist_ok=True)
    ts = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    path = OUT / f"swing_backtest_{ts}.txt"
    path.write_text("\n".join(lines) + "\n")
    print(f"\nwrote {path}")


if __name__ == "__main__":
    main()
