"""
Breakout feature table v2: every validated 75%+ breakout (breakout_events.py)
AND matched non-breakout stock-days, with every contributing factor we can
source, at several look-backs. The reverse-engineering table: compare what
preceded breakouts with what preceded ordinary days in similar stocks.

ROWS
  label=1  each validated breakout, anchored at the CLOSE BEFORE the
           breakout session (everything is knowable in advance)
  label=0  --controls stock-days per breakout, by --control-mode:
           matched      other stocks: same calendar month, $0.10-$5 raw
                        close, 20-day dollar volume within 0.5x-2x, no
                        breakout in the next 20 sessions -> tests WHICH
                        stocks break out
           same-symbol  the SAME stock 60-250 sessions BEFORE this breakout
                        (and >= 60 from any of its breakouts) -> tests WHEN;
                        the stock's traits and era cancel out, and nothing
                        after the spike (offerings, dilution, shorts piling
                        in) can leak into the comparison
  group_id ties each breakout to its controls

FEATURES (all point-in-time: only information public at the anchor close)
  Every share count (SEC shares outstanding, the float series, FINRA short
  interest) is restated to the anchor date's share basis using the
  warehouse's split factor (split-adjusted / raw close at each date), so a
  reverse split can't pose as a buyback and short float compares like with
  like.
  price/vol at look-backs lb1/lb5/lb10/lb20/lb45 (sessions before breakout):
    close, ret_1/5/20, dist from SMA 5/10/20/40/50/60/200, SMA slopes
    (SMA vs 5 sessions earlier), vol_ratio (vs prior 20d avg), dollar20,
    atr14_pct, pct of 52w high/low, close location in the day's range
  filing state (EDGAR facts, joined on `filed`): shares outstanding, YoY
    share growth, cash, quarterly burn, runway, market cap, public float $;
    float_1..3 = shares-outstanding readings filed in the last 12 weeks
  short interest (FINRA, 2018+): si_1..si_6 = the 6 most recent settlements
    PUBLISHED before the anchor (publication ~= settlement + 8 business
    days), short_float_1..6 (vs shares outstanding), days_to_cover_1..6,
    short_float_slope (fitted over the 6 points) and short_float_chg
  short volume (FINRA Reg SHO, 2018-08+): short-volume ratio averaged over
    5/10/20/40/60 sessions
  catalysts: for every catalyst type in research/data/catalysts/*.parquet,
    count in the prior 20 and 60 calendar days
  market: SPY above its 200-day SMA, SPY 20-day return

Missing data is NULL (e.g. short interest before 2018), never zero.

    research/.venv/bin/python research/breakout_features_v2.py \\
        research/data/study_outputs/breakout_events_TIMESTAMP.csv [--controls 5]
"""
import argparse
import datetime as dt
from pathlib import Path

import duckdb
import numpy as np
import pyarrow as pa
from numpy.lib.stride_tricks import sliding_window_view as swv

ROOT = Path(__file__).resolve().parent
WAREHOUSE = ROOT / "data" / "stackslash.duckdb"
EDGAR = ROOT / "data" / "edgar"
CAT = ROOT / "data" / "catalysts"
OUT = ROOT / "data" / "study_outputs"
LOOKBACKS = (1, 5, 10, 20, 45)
SMAS = (5, 10, 20, 40, 50, 60, 200)


def roll_mean(x, n):
    out = np.full(len(x), np.nan)
    if len(x) >= n:
        c = np.cumsum(np.insert(np.nan_to_num(x), 0, 0.0))
        out[n - 1:] = (c[n:] - c[:-n]) / n
    return out


def load(con):
    print("loading daily bars...", flush=True)
    d = con.execute("""
      with band as (
        select symbol from wh.sip_bars_daily_raw where date >= date '2016-01-01' and close between 0.10 and 5
        group by symbol having count(*) >= 60
      )
      select s.symbol, s.date, s.open o, s.high h, s.low l, s.close c, s.volume v, r.close cr
      from wh.sip_bars_daily_split s join wh.sip_bars_daily_raw r using (symbol, date) join band using (symbol)
      where s.date >= date '2015-01-01'
        and not (s.volume <= 0 and s.open = s.high and s.high = s.low and s.low = s.close)
      order by s.symbol, s.date
    """).fetchnumpy()
    b = {k: np.asarray(v) for k, v in d.items()}
    for k in ("o", "h", "l", "c", "v", "cr"):
        b[k] = b[k].astype(float)
    b["date"] = b["date"].astype("datetime64[D]")
    return b


def features(b):
    n = len(b["c"])
    sym = b["symbol"]
    starts = np.flatnonzero(np.r_[True, sym[1:] != sym[:-1]])
    ends = np.r_[starts[1:], n]
    f = {}
    names = ["ret_1", "ret_5", "ret_20", "vol_ratio", "dollar20", "atr14_pct", "pct_52w_high", "pct_52w_low", "clv", "adv20"]
    names += [f"dist_sma{k}" for k in SMAS] + [f"slope_sma{k}" for k in SMAS]
    for k in names:
        f[k] = np.full(n, np.nan)
    for a, e in zip(starts, ends):
        c, h, l, v, cr = b["c"][a:e], b["h"][a:e], b["l"][a:e], b["v"][a:e], b["cr"][a:e]
        m = e - a
        with np.errstate(invalid="ignore", divide="ignore"):
            for k in (1, 5, 20):
                r = np.full(m, np.nan)
                if m > k:
                    r[k:] = c[k:] / c[:-k] - 1
                f[f"ret_{k}"][a:e] = r
            prior_v = np.r_[np.nan, roll_mean(v, 20)[:-1]]
            f["adv20"][a:e] = prior_v
            f["vol_ratio"][a:e] = v / prior_v
            f["dollar20"][a:e] = roll_mean(cr * v, 20)
            pc = np.r_[np.nan, c[:-1]]
            tr = np.fmax(h - l, np.fmax(np.abs(h - pc), np.abs(l - pc)))
            f["atr14_pct"][a:e] = roll_mean(tr, 14) / c
            if m >= 252:
                hi = np.full(m, np.nan); lo = np.full(m, np.nan)
                hi[251:] = swv(h, 252).max(axis=1); lo[251:] = swv(l, 252).min(axis=1)
                f["pct_52w_high"][a:e] = c / hi
                f["pct_52w_low"][a:e] = c / lo
            rng = h - l
            f["clv"][a:e] = np.where(rng > 0, (c - l) / rng, 0.5)
            for k in SMAS:
                sma = roll_mean(c, k)
                f[f"dist_sma{k}"][a:e] = c / sma - 1
                s5 = np.full(m, np.nan)
                if m > 5:
                    s5[5:] = sma[5:] / sma[:-5] - 1
                f[f"slope_sma{k}"][a:e] = s5
    return f, starts, ends


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("events_csv")
    ap.add_argument("--controls", type=int, default=5)
    ap.add_argument("--control-mode", choices=("matched", "same-symbol"), default="matched",
                    help="matched: other stocks, same month and liquidity (tests WHICH stocks break out); "
                         "same-symbol: the same stock at other times, >= 60 sessions from any of its breakouts "
                         "(tests WHEN -- the stock's own traits cancel out)")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)

    con = duckdb.connect()
    con.execute(f"attach '{WAREHOUSE}' as wh (read_only)")
    b = load(con)
    f, starts, ends = features(b)
    n = len(b["c"])
    sym, dates = b["symbol"], b["date"]
    sid_of = {s: i for i, s in enumerate(sym[starts])}
    sid = np.repeat(np.arange(len(starts)), ends - starts)

    # --- breakout anchors: the session before each validated event day ---
    ev = con.execute(f"select symbol, event_date::date d, gain_pct from read_csv_auto('{args.events_csv}')").fetchall()
    is_event = np.zeros(n, bool)
    anchors, meta = [], []
    for s, d, g in ev:
        i = sid_of.get(s)
        if i is None:
            continue
        a, e = starts[i], ends[i]
        k = a + np.searchsorted(dates[a:e], np.datetime64(d))
        if k < e and dates[k] == np.datetime64(d) and k - 1 >= a + 45:
            is_event[k] = True
            anchors.append(k - 1)
            meta.append((1, g))
    # no breakout in the next 20 sessions (same symbol)
    ce = np.r_[0, np.cumsum(is_event)]
    last = ends[sid] - 1
    nxt = np.minimum(np.arange(n) + 20, last)
    quiet_ahead = (ce[nxt + 1] - ce[np.arange(n) + 1]) == 0

    # --- matched controls ---
    month = dates.astype("datetime64[M]")
    local = np.arange(n) - starts[sid]
    elig = (b["cr"] >= 0.10) & (b["cr"] <= 5) & (local >= 45) & quiet_ahead & ~np.isnan(f["dollar20"])
    rows = [(a, 1, g, j) for j, (a, (lab, g)) in enumerate(zip(anchors, meta))]
    by_month = {}
    for idx in np.flatnonzero(elig):
        by_month.setdefault(month[idx], []).append(idx)
    by_month = {k: np.array(v) for k, v in by_month.items()}
    if args.control_mode == "same-symbol":
        # sessions to the nearest validated breakout of the same symbol, either side
        ev_idx = np.flatnonzero(is_event)
        near = np.full(n, 10**9)
        if len(ev_idx):
            pos = np.searchsorted(ev_idx, np.arange(n))
            for off in (0, -1):
                k = np.clip(pos + off, 0, len(ev_idx) - 1)
                same = sid[ev_idx[k]] == sid
                near = np.where(same, np.minimum(near, np.abs(ev_idx[k] - np.arange(n))), near)
        far = elig & (near >= 60)
    for j, a in enumerate(anchors):
        if args.control_mode == "same-symbol":
            # the same stock 60-250 sessions BEFORE this breakout: same era of the company (share count, float
            # and filing cadence drift over its life), and never after -- post-spike days carry the spike's own
            # consequences (offerings, dilution, shorts piling in), which would leak the answer
            s0, s1 = max(starts[sid[a]], a - 250), max(starts[sid[a]], a - 59)
            ok = s0 + np.flatnonzero(far[s0:s1])
            if len(ok):
                for c in rng.choice(ok, min(args.controls, len(ok)), replace=False):
                    rows.append((c, 0, None, j))
            continue
        pool = by_month.get(month[a], np.array([], int))
        if not len(pool):
            continue
        dv = f["dollar20"][a]
        ok = pool[(f["dollar20"][pool] >= 0.5 * dv) & (f["dollar20"][pool] <= 2 * dv) & (sym[pool] != sym[a])]
        if len(ok):
            for c in rng.choice(ok, min(args.controls, len(ok)), replace=False):
                rows.append((c, 0, None, j))
    print(f"{len(anchors):,} breakouts, {sum(r[1] == 0 for r in rows):,} controls", flush=True)

    # --- look-back snapshots ---
    cols = {"rid": [], "group_id": [], "label": [], "event_gain_pct": [], "symbol": [], "anchor_date": [], "anchor_close_raw": []}
    snap_keys = [k for k in f if k != "adv20"]
    for lb in LOOKBACKS:
        for k in snap_keys:
            cols[f"lb{lb}_{k}"] = []
    for rid, (r, lab, g, j) in enumerate(rows):
        cols["rid"].append(rid)
        cols["group_id"].append(j); cols["label"].append(lab); cols["event_gain_pct"].append(g)
        cols["symbol"].append(sym[r]); cols["anchor_date"].append(dates[r].item()); cols["anchor_close_raw"].append(b["cr"][r])
        for lb in LOOKBACKS:
            i = r - (lb - 1)
            ok = i >= starts[sid[r]]
            for k in snap_keys:
                cols[f"lb{lb}_{k}"].append(float(f[k][i]) if ok else np.nan)
    con.register("base_arrow", pa.table(cols))
    con.execute("create temp table base as select * from base_arrow")

    # --- filing state, float series (EDGAR, point-in-time on `filed`) ---
    e = str(EDGAR)
    print("joining EDGAR state...", flush=True)
    con.execute(f"""
      create temp table tc as select ticker, min(cik) cik from (
        select ticker, cik from read_parquet('{e}/edgar_tickers.parquet')
        union select unnest(tickers) ticker, cik from read_parquet('{e}/edgar_companies.parquet')) group by ticker
    """)
    con.execute(f"""
      create temp table sh as select cik, filed::date filed, max(val) shares from read_parquet('{e}/edgar_facts.parquet')
      where concept in ('EntityCommonStockSharesOutstanding', 'CommonStockSharesOutstanding') and unit = 'shares' and val > 0
      group by 1, 2 order by 1, 2
    """)
    con.execute(f"""
      create temp table pf as select cik, filed::date filed, max(val) public_float_usd from read_parquet('{e}/edgar_facts.parquet')
      where concept = 'EntityPublicFloat' and unit = 'USD' group by 1, 2 order by 1, 2
    """)
    con.execute(f"""
      create temp table cash as select cik, filed::date filed, max(val) cash from read_parquet('{e}/edgar_facts.parquet')
      where concept = 'CashAndCashEquivalentsAtCarryingValue' and unit = 'USD' group by 1, 2 order by 1, 2
    """)
    con.execute(f"""
      create temp table burn as select cik, filed::date filed,
        max(-val * 91.0 / date_diff('day', "start"::date, "end"::date)) burn_q
      from read_parquet('{e}/edgar_facts.parquet')
      where concept = 'NetCashProvidedByUsedInOperatingActivities' and unit = 'USD' and start is not null
        and date_diff('day', "start"::date, "end"::date) between 80 and 370
      group by 1, 2 order by 1, 2
    """)
    # Split factor per symbol-date from the warehouse itself: split-adjusted / raw close. It encodes every
    # split after that date (the corporate-actions feed misses some -- OTC names, ticker changes).
    con.execute("""
      create temp table sf as
      select s.symbol, s.date, s.close / nullif(r.close, 0) f
      from wh.sip_bars_daily_split s join wh.sip_bars_daily_raw r using (symbol, date)
      where s.symbol in (select distinct symbol from base) and r.close > 0
      order by 1, 2
    """)
    con.execute("""
      create macro sfac(sym, d) as coalesce(
        (select f from sf where sf.symbol = sym and sf.date <= d order by sf.date desc limit 1),
        (select f from sf where sf.symbol = sym order by sf.date limit 1))
    """)
    # a share count reported as of d_from, restated to d_to's share basis
    con.execute("create macro restate(v, sym, d_from, d_to) as v * sfac(sym, d_to) / sfac(sym, d_from)")
    con.execute("""
      create temp table b2 as
      with x as (select b.*, tc.cik, b.anchor_date - interval 365 day d1y from base b left join tc on tc.ticker = b.symbol),
      s0r as (select x.*, sh.shares shares_raw, sh.filed shares_filed from x asof left join sh on x.cik = sh.cik and x.anchor_date >= sh.filed),
      s0 as (select s0r.*, restate(shares_raw, symbol, shares_filed, anchor_date) shares from s0r),
      s1r as (select s0.*, sh.shares shares_1y_raw, sh.filed shares_1y_filed from s0 asof left join sh on s0.cik = sh.cik and s0.d1y >= sh.filed),
      s1 as (select s1r.*, restate(shares_1y_raw, symbol, shares_1y_filed, anchor_date) shares_1y from s1r),
      p as (select s1.*, pf.public_float_usd from s1 asof left join pf on s1.cik = pf.cik and s1.anchor_date >= pf.filed),
      c as (select p.*, cash.cash from p asof left join cash on p.cik = cash.cik and p.anchor_date >= cash.filed),
      bn as (select c.*, burn.burn_q from c asof left join burn on c.cik = burn.cik and c.anchor_date >= burn.filed)
      select bn.*, shares * anchor_close_raw mcap,
        case when shares_1y > 0 then shares / shares_1y - 1 end share_growth_1y,
        -- shares down by half in a year is rare; usually a split neither source recorded
        coalesce(shares_1y > 0 and shares / shares_1y - 1 < -0.5, false) share_count_suspect,
        case when burn_q > 0 and cash is not null then cash / burn_q when burn_q <= 0 then 99 end runway_q
      from bn
    """)
    con.execute("""
      create temp table fl as
      select b.rid, b.symbol,
        list(restate(sh.shares, b.symbol, sh.filed, b.anchor_date) order by sh.filed desc)[1] float_1,
        list(restate(sh.shares, b.symbol, sh.filed, b.anchor_date) order by sh.filed desc)[2] float_2,
        list(restate(sh.shares, b.symbol, sh.filed, b.anchor_date) order by sh.filed desc)[3] float_3,
        list(sh.filed order by sh.filed desc)[1] float_1_filed, list(sh.filed order by sh.filed desc)[2] float_2_filed,
        list(sh.filed order by sh.filed desc)[3] float_3_filed
      from b2 b join sh on sh.cik = b.cik and sh.filed <= b.anchor_date and sh.filed > b.anchor_date - interval 84 day
      group by all
    """)

    # --- short interest series: 6 latest settlements published by the anchor ---
    si_dir = CAT / "raw" / "short_interest"
    has_si = any(si_dir.glob("*.parquet"))
    if has_si:
        print("joining short interest...", flush=True)
        con.execute(f"""
          create temp table si as
          select symbol, settlement_date, short_interest, avg_daily_volume, days_to_cover
          from read_parquet('{si_dir}/*.parquet') where short_interest is not null
        """)
        pub = con.execute("select distinct settlement_date from si").fetchnumpy()["settlement_date"].astype("datetime64[D]")
        pubd = np.busday_offset(pub, 8, roll="forward")
        con.register("pubmap", pa.table({"settlement_date": pub.astype("datetime64[D]"), "pub_date": pubd}))
        con.execute("""
          create temp table sip as
          select b.rid, b.symbol, b.shares,
            list(restate(si.short_interest, b.symbol, si.settlement_date, b.anchor_date) order by si.settlement_date desc)[1:6] si_list,
            list(si.days_to_cover order by si.settlement_date desc)[1:6] dtc_list,
            list(si.settlement_date order by si.settlement_date desc)[1] si_1_settlement
          from b2 b join si on si.symbol = b.symbol
          join pubmap pm on pm.settlement_date = si.settlement_date
          where pm.pub_date <= b.anchor_date and si.settlement_date > b.anchor_date - interval 150 day
          group by all
        """)
    # --- short volume ratio windows ---
    sv_dir = CAT / "raw" / "short_volume"
    has_sv = any(sv_dir.glob("*.parquet"))
    if has_sv:
        print("joining short volume...", flush=True)
        con.execute(f"""
          create temp table sv as
          select symbol, date, short_volume / nullif(total_volume, 0) svr from read_parquet('{sv_dir}/*.parquet')
        """)
        con.execute("""
          create temp table svw as
          with j as (
            select b.rid, b.symbol, sv.date, sv.svr,
                   row_number() over (partition by b.rid order by sv.date desc) rk
            from b2 b join sv on sv.symbol = b.symbol and sv.date <= b.anchor_date and sv.date > b.anchor_date - interval 100 day
          )
          select rid,
            avg(svr) filter (where rk <= 5) svr_5, avg(svr) filter (where rk <= 10) svr_10,
            avg(svr) filter (where rk <= 20) svr_20, avg(svr) filter (where rk <= 40) svr_40,
            avg(svr) filter (where rk <= 60) svr_60
          from j group by all
        """)

    # --- catalyst counts, prior 20 / 60 calendar days ---
    print("counting catalysts...", flush=True)
    con.execute(f"""
      create temp table ev as
      select symbol, event_date, type from read_parquet('{CAT}/*.parquet', union_by_name = true)
      where type not in ('news_any', 'form4')
    """)
    types = [r[0] for r in con.execute("select distinct type from ev order by 1").fetchall()]
    aggs = ",\n".join(
        f"count(*) filter (where e.type = '{t}' and e.event_date > b.anchor_date - interval 20 day) as \"cat20_{t}\", "
        f"count(*) filter (where e.type = '{t}') as \"cat60_{t}\""
        for t in types)
    con.execute(f"""
      create temp table cats as
      select b.rid, b.symbol, {aggs}
      from b2 b join ev e on e.symbol = b.symbol and e.event_date <= b.anchor_date and e.event_date > b.anchor_date - interval 60 day
      group by all
    """)

    # --- market regime ---
    con.execute("""
      create temp table spy as
      select date, close > avg(close) over (order by date rows between 199 preceding and current row) spy_above_sma200,
             close / lag(close, 20) over (order by date) - 1 spy_ret_20
      from wh.sip_bars_daily_split where symbol = 'SPY'
    """)

    si_cols = ""
    if has_si:
        si_cols = ", " + ", ".join(
            f"sip.si_list[{i}] si_{i}, sip.si_list[{i}] / nullif(b.shares, 0) short_float_{i}, sip.dtc_list[{i}] days_to_cover_{i}"
            for i in range(1, 7)) + ", sip.si_1_settlement"
    sv_cols = ", svw.svr_5, svw.svr_10, svw.svr_20, svw.svr_40, svw.svr_60" if has_sv else ""
    cat_cols = ", " + ", ".join(f'coalesce(cats."cat20_{t}", 0) "cat20_{t}", coalesce(cats."cat60_{t}", 0) "cat60_{t}"' for t in types)
    joins = ""
    if has_si:
        joins += " left join sip using (rid)"
    if has_sv:
        joins += " left join svw using (rid)"
    con.execute(f"""
      create temp table final as
      select b.* exclude (cik, d1y), fl.* exclude (rid, symbol){si_cols}{sv_cols}{cat_cols},
             spy.spy_above_sma200, spy.spy_ret_20
      from b2 b left join fl using (rid){joins}
      left join cats using (rid)
      left join spy on spy.date = b.anchor_date
    """)
    if has_si:
        # short-float trend over the 6 points: least-squares slope per step (oldest -> newest)
        con.execute("""
          alter table final add column short_float_slope double;
          alter table final add column short_float_chg double;
          update final set
            short_float_chg = short_float_1 - short_float_6,
            short_float_slope = regr_slope_6
          from (
            select rowid rid, regr_slope(y, x) regr_slope_6 from (
              select rowid, unnest([short_float_6, short_float_5, short_float_4, short_float_3, short_float_2, short_float_1]) y,
                     unnest([1, 2, 3, 4, 5, 6]) x from final) group by rowid) s
          where final.rowid = s.rid
        """)
    OUT.mkdir(parents=True, exist_ok=True)
    ts = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    path = OUT / f"breakout_features_v2_{ts}.parquet"
    con.execute(f"copy final to '{path}' (format parquet)")
    n_rows, n_cols = con.execute("select count(*) from final").fetchone()[0], len(con.execute("select * from final limit 0").description)
    cov = con.execute(f"""
      select label, count(*), avg((shares is not null)::int), avg((float_1 is not null)::int)
        {', avg((si_1 is not null)::int), avg((si_6 is not null)::int)' if has_si else ''}
        {', avg((svr_20 is not null)::int)' if has_sv else ''}
      from final group by 1 order by 1
    """).fetchall()
    print(f"\nwrote {path}\n{n_rows:,} rows x {n_cols} columns")
    print("coverage by label (n, shares, float_1" + (", si_1, si_6" if has_si else "") + (", svr_20" if has_sv else "") + "):")
    for r in cov:
        print("  ", r[0], f"{r[1]:,}", " ".join(f"{x:.0%}" for x in r[2:]))


if __name__ == "__main__":
    main()
