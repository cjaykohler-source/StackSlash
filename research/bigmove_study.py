"""
After-close big-move watchlist + spread / liquidity tier study (SIP daily
warehouse + EDGAR).

Question 1 (tiers): how do next-session big-move rates and random-day net
returns change with 20-day SIP dollar volume and an estimated spread? Where
should the monitoring / alerting floors sit?

Question 2 (watchlist): which facts known at the close of day t (volume,
the day's move, range expansion, a filing accepted since the prior close)
raise the chance of a big move on day t+1, against a random in-band day?

Point in time: every candidate uses bars through the close of t and filings
accepted before 17:45 ET on t (when eod-scan runs). Outcomes:
  abs10     |close t+1 / close t - 1| >= 10%
  touch10   day t+1 high >= +10% or low <= -10% from close t
  touch20   same at 20%
  r1, r5    close-to-close net of cost = max(1%, tick, est. spread)
Spread estimate: Abdi-Ranaldo (2017) close/high/low estimator, 20-day mean.
Periods 2016-21 and 2022+ reported separately.

    research/.venv/bin/python research/bigmove_study.py [--floor 800000]
"""
import argparse
import datetime as dt
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent
WAREHOUSE = ROOT / "data" / "stackslash.duckdb"
EDGAR = ROOT / "data" / "edgar"
OUT = ROOT / "data" / "study_outputs"

CANDIDATES = {
    "vr3": "vol_ratio >= 3",
    "vr5": "vol_ratio >= 5",
    "vr10": "vol_ratio >= 10",
    "vr25 (blow-off)": "vol_ratio >= 25",
    "up10": "dret >= 0.10",
    "down10": "dret <= -0.10",
    "range2x_atr": "range_x >= 2",
    "up10_close_hi_vr3": "dret >= 0.10 and close_loc >= 0.8 and vol_ratio >= 3",
    "up10_fade_vr3": "dret >= 0.10 and close_loc <= 0.3 and vol_ratio >= 3",
    "8k_any": "f_8k",
    "8k_2.02": "f_202",
    "offering_filed": "f_offer",
    "8k_any_vr3": "f_8k and vol_ratio >= 3",
    "8k_any_quiet": "f_8k and vol_ratio < 1.5",
    "score>=2": "(vol_ratio >= 3)::int + (abs(dret) >= 0.10)::int + (range_x >= 2)::int + f_8k::int >= 2",
    "score>=3": "(vol_ratio >= 3)::int + (abs(dret) >= 0.10)::int + (range_x >= 2)::int + f_8k::int >= 3",
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--floor", type=float, default=800_000)
    ap.add_argument(
        "--negative-control",
        choices=["off", "within-symbol", "within-date"],
        default="off",
        help="within-symbol: permute each symbol's outcomes across its own "
        "feature-days. Breaks the t -> t+1 link, KEEPS symbol identity, so "
        "the residual floor measures how much lift comes from simply "
        "selecting volatile names. "
        "within-date: permute outcomes across symbols inside the same "
        "session. Breaks symbol identity, KEEPS the calendar day, so the "
        "floor measures how much comes from candidates clustering on "
        "volatile market days. Run both: the true per-symbol-per-day effect "
        "is what survives above the higher of the two floors.",
    )
    ap.add_argument("--seed", type=int, default=20260921, help="seed for the negative-control permutation")
    ap.add_argument(
        "--max-price",
        type=float,
        default=5.0,
        help="upper price bound. Defaults to the live band. Anything above 5 "
        "leaves it: $5-$10 is outside the traded universe and was only ever "
        "examined incidentally (docs/research-audit-plan.md 1.3c).",
    )
    args = ap.parse_args()
    F = args.floor
    P = args.max_price
    e = str(EDGAR)
    if P > 5.0:
        print(f"WARNING: --max-price {P} is above the live band ($0.10-$5).", flush=True)

    con = duckdb.connect()
    con.execute("set threads = 8")
    con.execute(f"attach '{WAREHOUSE}' as wh (read_only)")
    print("building daily features...", flush=True)
    con.execute(f"""
      create temp table d as
      with band as (
        select symbol from wh.sip_bars_daily_raw
        where date >= date '2016-01-01' and close between 0.10 and {P} group by 1 having count(*) >= 60
      ),
      s as (
        select s.symbol, s.date, s.open o, s.high h, s.low l, s.close c, s.volume v, r.close cr, r.volume rv
        from wh.sip_bars_daily_split s join wh.sip_bars_daily_raw r using (symbol, date) join band using (symbol)
        where s.date >= date '2015-01-01' and s.volume > 0 and s.high > 0 and s.low > 0
      ),
      a as (
        select *,
          lag(c) over w pc, lead(c) over w nc, lead(h) over w nh, lead(l) over w nl, lead(c, 5) over w c5,
          lead(date, 5) over w d5, lead(date) over w nd,
          4 * (ln(lag(c) over w) - lag((ln(h) + ln(l)) / 2) over w) * (ln(lag(c) over w) - (ln(h) + ln(l)) / 2) ar_raw,
          greatest(h - l, abs(h - lag(c) over w), abs(l - lag(c) over w)) tr
        from s window w as (partition by symbol order by date)
      ),
      b as (
        select *,
          avg(rv) over (partition by symbol order by date rows between 20 preceding and 1 preceding) adv_prior,
          avg(cr * rv) over (partition by symbol order by date rows between 19 preceding and current row) dollar20,
          avg(tr) over (partition by symbol order by date rows between 14 preceding and 1 preceding) atr_prior,
          -- Abdi-Ranaldo uses eta of t and t+1; lag one day so only data through t is used
          avg(greatest(ar_raw, 0))
            over (partition by symbol order by date rows between 20 preceding and 1 preceding) ar_s2
        from a
      )
      select symbol, date, cr, dollar20, sqrt(ar_s2) spread_est,
        rv / nullif(adv_prior, 0) vol_ratio,
        c / nullif(pc, 0) - 1 dret,
        (h - l) / nullif(atr_prior, 0) range_x,
        (c - l) / nullif(h - l, 0) close_loc,
        case when nc / c between 0.1 and 10 and date_diff('day', date, nd) <= 7 then nc / c - 1 end r1,
        case when nc / c between 0.1 and 10 and date_diff('day', date, nd) <= 7 then nh / c - 1 end nh_ret,
        case when nc / c between 0.1 and 10 and date_diff('day', date, nd) <= 7 then nl / c - 1 end nl_ret,
        case when c5 / c between 0.1 and 10 and date_diff('day', date, d5) <= 17 then c5 / c - 1 end r5
      from b
      where date >= date '2016-01-01' and cr between 0.10 and {P} and pc > 0 and c / pc between 0.1 and 10
    """)

    print("attaching filings...", flush=True)
    con.execute(f"""
      create temp table tc as
      select ticker, min(cik) cik from (
        select ticker, cik from read_parquet('{e}/edgar_tickers.parquet')
        union select unnest(tickers) ticker, cik from read_parquet('{e}/edgar_companies.parquet')
      ) group by ticker
    """)
    # Filings accepted in (17:45 ET on the prior session, 17:45 ET on t] belong to t.
    con.execute(f"""
      create temp table fl as
      select tc.ticker symbol,
        case when timezone('America/New_York', acceptance_datetime::timestamptz)::time <= time '17:45'
             then timezone('America/New_York', acceptance_datetime::timestamptz)::date
             else timezone('America/New_York', acceptance_datetime::timestamptz)::date + 1 end as adate,
        form, coalesce(items, '') items
      from read_parquet('{e}/edgar_filings.parquet') f join tc on tc.cik = f.cik
      where form in ('8-K', 'S-1', 'S-3', 'F-1', 'F-3', '424B4', '424B5') and filing_date >= '2015-12-01'
        and acceptance_datetime is not null
    """)
    # adate is the calendar day whose 17:45 cutoff first follows acceptance; asof-join to the first session on/after it.
    con.execute("""
      create temp table fsess as
      select d.symbol, d.date,
        bool_or(fl.form = '8-K') f_8k,
        bool_or(fl.form = '8-K' and regexp_matches(fl.items, '(^|,)2\\.02(,|$)')) f_202,
        bool_or(fl.form <> '8-K') f_offer
      from fl asof join (select symbol, date from d) d on fl.symbol = d.symbol and fl.adate <= d.date
      where d.date - fl.adate <= 5
      group by 1, 2
    """)
    con.execute(f"""
      create temp table x as
      select d.*, coalesce(f.f_8k, false) f_8k, coalesce(f.f_202, false) f_202, coalesce(f.f_offer, false) f_offer,
        case when date < date '2022-01-01' then '2016-21' else '2022+' end period,
        greatest(case when cr >= 1 then 0.01 else 0.0001 end / cr, 0.01, coalesce(spread_est, 0)) cost_pct
      from d left join fsess f using (symbol, date)
      where r1 is not null
    """)

    lines = []

    def emit(s=""):
        print(s)
        lines.append(s)

    # ---- Stage row counts ----------------------------------------------
    # Printed on every run. Silent row loss is this project's most common
    # measurement failure (six documented instances), and a count that
    # moves between runs is the cheapest possible detector.
    emit("\n=== Stage row counts (watch for silent drops) ===")
    for label, q in (
        ("band symbols", "select count(*) from (select distinct symbol from d)"),
        ("daily feature rows (d)", "select count(*) from d"),
        ("  ... with r1 not null", "select count(*) from d where r1 is not null"),
        ("filing-session rows (fsess)", "select count(*) from fsess"),
        ("analysis rows (x)", "select count(*) from x"),
        (f"  ... above floor ${F:,.0f}", f"select count(*) from x where dollar20 >= {F}"),
        ("  ... with any 8-K", "select count(*) from x where f_8k"),
    ):
        emit(f"  {label:<32}{con.execute(q).fetchone()[0]:>12,}")

    # ---- Negative control ----------------------------------------------
    # Permute each symbol's outcome vector across its own feature-days. All
    # marginals are preserved; only the t -> t+1 alignment is destroyed.
    T = "x"
    if args.negative_control != "off":
        key = "symbol" if args.negative_control == "within-symbol" else "date"
        blurb = (
            "Outcomes permuted WITHIN SYMBOL, across that symbol's own days.\n"
            "  Symbol identity is preserved, so the residual floor is the lift\n"
            "  attributable purely to selecting volatile names."
            if key == "symbol"
            else "Outcomes permuted WITHIN SESSION, across the symbols trading that day.\n"
            "  The calendar day is preserved, so the residual floor is the lift\n"
            "  attributable to candidates clustering on volatile market days."
        )
        con.execute(f"select setseed({(args.seed % 1000) / 1000.0})")
        con.execute(f"""
          create temp table x_nc as
          select f.symbol, f.date, f.cr, f.dollar20, f.spread_est, f.vol_ratio, f.dret,
                 f.range_x, f.close_loc, f.f_8k, f.f_202, f.f_offer, f.period, f.cost_pct,
                 o.r1, o.nh_ret, o.nl_ret, o.r5
          from (select *, row_number() over (partition by {key} order by symbol, date) rn from x) f
          join (select {key} k, r1, nh_ret, nl_ret, r5,
                       row_number() over (partition by {key} order by random()) rn from x) o
            on f.{key} = o.k and f.rn = o.rn
        """)
        n_x, n_nc = (con.execute(f"select count(*) from {t}").fetchone()[0] for t in ("x", "x_nc"))
        if n_x != n_nc:
            raise SystemExit(f"negative control changed row count: {n_x:,} -> {n_nc:,}")
        T = "x_nc"
        emit("\n" + "=" * 78)
        emit(f"  NEGATIVE CONTROL ACTIVE (--negative-control {args.negative_control})")
        emit(f"  {blurb}")
        emit("  Lift above this floor is the part the trigger can actually claim.")
        emit("=" * 78)

    # ---- Q1: tiers ------------------------------------------------------
    # Skipped under the negative control: Q1 describes the universe rather
    # than testing a candidate, so shuffled outcomes make it meaningless
    # rather than informative.
    if args.negative_control != "off":
        emit("\n(Q1 liquidity/spread tiers skipped under negative control.)")
    else:
        run_q1(con, emit, F)

    run_q2(con, emit, F, T)
    run_q3(con, emit, F, T)

    OUT.mkdir(parents=True, exist_ok=True)
    suffix = "" if args.negative_control == "off" else f"_nc-{args.negative_control}"
    path = OUT / f"bigmove_study_{int(F)}{suffix}_{dt.datetime.now():%Y%m%dT%H%M%S}.txt"
    path.write_text("\n".join(lines) + "\n")
    print(f"\nsaved: {path}")


def run_q1(con, emit, F):
    emit("\n=== Liquidity tiers (all in-band days, no floor) — next session ===")
    emit(f"  {'tier':<22}{'period':<9}{'n':>10}{'spread':>8}{'abs10':>7}{'touch10':>8}{'touch20':>8}{'r1 net':>8}{'r5 net':>8}{'r5 gross':>9}")
    tier = """case when dollar20 < 250000 then '1 <$250k' when dollar20 < 800000 then '2 $250k-800k'
                   when dollar20 < 2500000 then '3 $800k-2.5M' when dollar20 < 10000000 then '4 $2.5M-10M' else '5 >=$10M' end"""
    for r in con.execute(f"""
      select {tier} t, period, count(*), median(spread_est), avg((abs(r1) >= .1)::int),
        avg((nh_ret >= .1 or nl_ret <= -.1)::int), avg((nh_ret >= .2 or nl_ret <= -.2)::int),
        avg(r1 - cost_pct), avg(r5 - cost_pct), avg(r5)
      from x where dollar20 is not null group by 1, 2 order by 1, 2""").fetchall():
        emit(f"  {r[0]:<22}{r[1]:<9}{r[2]:>10,}{(r[3] or 0)*100:>7.2f}%{r[4]*100:>6.1f}%{r[5]*100:>7.1f}%{r[6]*100:>7.1f}%{r[7]*100:>7.2f}%{(r[8] or 0)*100:>7.2f}%{(r[9] or 0)*100:>8.2f}%")
    emit("\n=== Estimated-spread tiers (dollar20 >= floor) ===")
    stier = "case when spread_est < .01 then '1 <1%' when spread_est < .02 then '2 1-2%' when spread_est < .04 then '3 2-4%' else '4 >=4%' end"
    for r in con.execute(f"""
      select {stier} t, period, count(*), avg((abs(r1) >= .1)::int), avg((nh_ret >= .1 or nl_ret <= -.1)::int), avg(r1 - cost_pct), avg(r5 - cost_pct), avg(r5)
      from x where dollar20 >= {F} and spread_est is not null group by 1, 2 order by 1, 2""").fetchall():
        emit(f"  {r[0]:<22}{r[1]:<9}{r[2]:>10,}{r[3]*100:>6.1f}%{r[4]*100:>7.1f}%{r[5]*100:>7.2f}%{(r[6] or 0)*100:>7.2f}%{(r[7] or 0)*100:>8.2f}%")


def run_q2(con, emit, F, T):
    # ---- Q2: watchlist candidates --------------------------------------
    emit(f"\n=== Big-move watchlist candidates (floor ${F:,.0f}) — next session vs random in-band day ===")
    emit(f"  {'candidate':<22}{'period':<9}{'n':>9}{'abs10':>7}{'lift':>6}{'touch10':>8}{'lift':>6}{'touch20':>8}{'lift':>6}{'r1 net':>8}{'r5 net':>8}{'up share':>9}")
    base = {p: row for p, *row in con.execute(f"""
      select period, count(*), avg((abs(r1) >= .1)::int), avg((nh_ret >= .1 or nl_ret <= -.1)::int),
        avg((nh_ret >= .2 or nl_ret <= -.2)::int), avg(r1 - cost_pct), avg(r5 - cost_pct)
      from {T} where dollar20 >= {F} group by 1""").fetchall()}
    for p in sorted(base):
        b = base[p]
        emit(f"  {'BASELINE':<22}{p:<9}{b[0]:>9,}{b[1]*100:>6.1f}%{'':>6}{b[2]*100:>7.1f}%{'':>6}{b[3]*100:>7.1f}%{'':>6}{b[4]*100:>7.2f}%{(b[5] or 0)*100:>7.2f}%")
    for name, cond in CANDIDATES.items():
        for r in con.execute(f"""
          select period, count(*), avg((abs(r1) >= .1)::int), avg((nh_ret >= .1 or nl_ret <= -.1)::int),
            avg((nh_ret >= .2 or nl_ret <= -.2)::int), avg(r1 - cost_pct), avg(r5 - cost_pct),
            avg(case when abs(r1) >= .1 then (r1 > 0)::int end)
          from {T} where dollar20 >= {F} and ({cond}) group by 1 order by 1""").fetchall():
            b = base[r[0]]
            emit(f"  {name:<22}{r[0]:<9}{r[1]:>9,}{r[2]*100:>6.1f}%{r[2]/b[1]:>5.1f}x{r[3]*100:>7.1f}%{r[3]/b[2]:>5.1f}x"
                 f"{r[4]*100:>7.1f}%{r[4]/b[3]:>5.1f}x{r[5]*100:>7.2f}%{(r[6] or 0)*100:>7.2f}%{(r[7] or 0)*100:>8.0f}%")

    # Volatile names move more on any day. Lift within estimated-spread tiers
    # (a volatility proxy here) checks the candidates add something beyond that.
    emit(f"\n=== Same candidates, lift within estimated-spread tier (abs10) — controls for how volatile the name already is ===")
    emit(f"  {'candidate':<22}{'period':<9}" + "".join(f"{t:>20}" for t in ("<2%", "2-4%", ">=4%")))
    st = "case when spread_est < .02 then 'a' when spread_est < .04 then 'b' else 'c' end"
    tb = {(p, t): (n, rate) for p, t, n, rate in con.execute(f"""
      select period, {st}, count(*), avg((abs(r1) >= .1)::int) from {T} where dollar20 >= {F} and spread_est is not null group by 1, 2""").fetchall()}
    for name in ("vr3", "vr5", "vr10", "up10_fade_vr3", "up10_close_hi_vr3", "8k_2.02", "8k_any_vr3", "score>=2", "score>=3"):
        rows = {(p, t): (n, rate) for p, t, n, rate in con.execute(f"""
          select period, {st}, count(*), avg((abs(r1) >= .1)::int) from {T}
          where dollar20 >= {F} and spread_est is not null and ({CANDIDATES[name]}) group by 1, 2""").fetchall()}
        for p in ("2016-21", "2022+"):
            cells = ""
            for t in "abc":
                if (p, t) in rows and rows[(p, t)][0] >= 100:
                    n, rate = rows[(p, t)]
                    cells += f"{rate*100:>8.1f}% {rate/tb[(p, t)][1]:>4.1f}x n{n:<5}"
                else:
                    cells += f"{'-':>20}"
            emit(f"  {name:<22}{p:<9}{cells}")

def run_q3(con, emit, F, T):
    """Direction- and cost-aware view (construct validity).

    Q2 scores candidates on abs10 -- a move of 10% in EITHER direction. A
    buy-candidate list needs to know whether that lift is upside or
    downside. This section splits the tails and charges costs.

      up_c / dn_c   next close >= +10% / <= -10% from close t
      MFE+10        next session's HIGH reaches +10%  (a reachable exit)
      MAE-10        next session's LOW  reaches -10%  (a stop-out)
      U:D           MFE+10 / MAE-10. The baseline's own ratio is the bar:
                    a selector with no directional edge lifts both tails
                    equally and leaves this unchanged.
      win_net       next close beats the modelled round-trip cost
      r1 net        mean next-session return net of that cost

    Daily bars cannot order the high and the low within a session, so MFE
    and MAE are not a path-dependent backtest -- they bound what was
    reachable, not what would have been captured.
    """
    emit(f"\n=== Direction & cost aware (floor ${F:,.0f}) — is the lift upside or downside? ===")
    cols = """count(*), avg((r1 >= .1)::int), avg((r1 <= -.1)::int),
              avg((nh_ret >= .1)::int), avg((nl_ret <= -.1)::int),
              avg((r1 - cost_pct > 0)::int), avg(r1 - cost_pct)"""
    base = {p: r for p, *r in con.execute(
        f"select period, {cols} from {T} where dollar20 >= {F} group by 1").fetchall()}

    emit(f"  {'candidate':<22}{'period':<9}{'n':>9}{'up_c':>7}{'lift':>6}{'dn_c':>7}{'lift':>6}"
         f"{'MFE+10':>8}{'lift':>6}{'MAE-10':>8}{'lift':>6}{'U:D':>6}{'win_net':>8}{'lift':>6}{'r1 net':>8}")
    for p in sorted(base):
        b = base[p]
        emit(f"  {'BASELINE':<22}{p:<9}{b[0]:>9,}{b[1]*100:>6.1f}%{'':>6}{b[2]*100:>6.1f}%{'':>6}"
             f"{b[3]*100:>7.1f}%{'':>6}{b[4]*100:>7.1f}%{'':>6}{b[3]/b[4]:>6.2f}{b[5]*100:>7.1f}%{'':>6}{b[6]*100:>7.2f}%")
    for name, cond in CANDIDATES.items():
        for r in con.execute(
            f"select period, {cols} from {T} where dollar20 >= {F} and ({cond}) group by 1 order by 1"
        ).fetchall():
            p, v = r[0], r[1:]
            b = base[p]
            emit(f"  {name:<22}{p:<9}{v[0]:>9,}{v[1]*100:>6.1f}%{v[1]/b[1]:>5.1f}x{v[2]*100:>6.1f}%{v[2]/b[2]:>5.1f}x"
                 f"{v[3]*100:>7.1f}%{v[3]/b[3]:>5.1f}x{v[4]*100:>7.1f}%{v[4]/b[4]:>5.1f}x"
                 f"{v[3]/v[4]:>6.2f}{v[5]*100:>7.1f}%{v[5]/b[5]:>5.1f}x{v[6]*100:>7.2f}%")

    emit("\n  U:D is the ratio of upside-reachable to downside-reachable next sessions.")
    emit("  A candidate with no directional edge leaves it at the BASELINE value;")
    emit("  below baseline means the selector is finding falls, not opportunities.")


if __name__ == "__main__":
    main()
