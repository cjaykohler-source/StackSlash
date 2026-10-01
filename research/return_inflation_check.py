"""Diagnostic: why does a random in-band stock-day show a positive mean 20-session return
after costs in the research warehouse? (2016-21 only). Not a study; see docs/return-inflation.md."""
import duckdb
import numpy as np
from swing_backtest import WAREHOUSE, load_bars, features

H = 20
con = duckdb.connect()
con.execute(f"attach '{WAREHOUSE}' as wh (read_only)")
con.execute("use wh")
b = load_bars(con, 0.10, 5.0)
f, starts, ends = features(b)
n = len(b["c"])
c, cr, dates = b["c"], b["cr"], b["date"]
sid = np.repeat(np.arange(len(starts)), ends - starts)
local = np.arange(n) - starts[sid]
span = (ends - starts)[sid]
yr = dates.astype("datetime64[Y]").astype(int) + 1970
elig = (yr >= 2016) & (yr <= 2021) & (cr >= 0.10) & (cr <= 5) & (f["dollar20"] >= 250_000)

fwd = np.full(n, np.nan)
ok = local + H < span
fwd[ok] = c[np.flatnonzero(ok) + H] / c[ok] - 1
ratio = f["ratio"]
bad = ((ratio >= 10) | (ratio <= 0.1)).astype(np.int64)
cb = np.r_[0, np.cumsum(bad)]
i = np.arange(n)
guard_bad = np.zeros(n, bool)
guard_bad[ok] = (cb[i[ok] + H + 1] - cb[i[ok] + 1]) > 0
cost = np.maximum(0.01, np.where(cr >= 1, 0.01, 0.0001) / cr)

def show(label, m, x):
    x = x[m & ~np.isnan(x)]
    lo, hi = np.quantile(x, [0.01, 0.99])
    w = np.clip(x, lo, hi)
    print(f"{label:<58} n={len(x):>9,}  mean {x.mean():+.2%}  wins {w.mean():+.2%}  median {np.median(x):+.2%}  "
          f"geo {np.expm1(np.mean(np.log1p(np.maximum(x, -0.9999)))):+.2%}")

net = fwd - cost
print("20-session forward return from the close, in-band rows 2016-21 ($250k floor)")
show("A  all rows with a full window, net (no guard)", elig, net)
show("B  harness view: guard applied, net", elig & ~guard_bad, net)
show("   rows the guard drops, net", elig & guard_bad, net)
# history ends inside the window
trunc = elig & (local + H >= span)
print(f"\nrows whose symbol's history ends within {H} sessions: {trunc.sum():,} ({trunc.mean() / elig.mean() if elig.any() else 0:.2%} of eligible rows)")
last = ends[sid] - 1
part = c[last] / c - 1
show("   those rows: return to the LAST available close, net", trunc, part - cost)
ends_early = dates[last] < np.datetime64("2026-09-01")
show("   ...where the symbol stopped trading before 2026-09", trunc & ends_early, part - cost)
# rough full-picture: count truncated rows at their last close (no delisting loss beyond it)
allx = np.where(ok, net, part - cost)
allx[ok & guard_bad] = np.nan
show("C  B + truncated rows at their last close", elig, allx)
allx2 = np.where(ok, net, np.where(ends_early, -1.0, part - cost))
allx2[ok & guard_bad] = np.nan
show("D  B + delisted-in-window rows at -100% (worst case)", elig, allx2)

sy = con.execute("""select count(*) total, count(*) filter (where last_d < date '2026-09-01') stopped,
   count(*) filter (where last_d < date '2022-01-01') stopped_before_2022
   from (select symbol, max(date) as last_d from sip_bars_daily_raw group by 1)""").fetchone()
print(f"\nwarehouse symbols: {sy[0]:,}; last bar before 2026-09: {sy[1]:,}; before 2022: {sy[2]:,}")
band_syms = np.unique(b["symbol"][elig])
stopped = np.unique(b["symbol"][elig & ends_early])
print(f"in-band symbols 2016-21: {len(band_syms):,}; of them stopped trading before 2026-09: {len(stopped):,}")

# by listing venue: survivorship should inflate the venue whose delisted names are missing (OTC)
ex = dict(con.execute("select bar_symbol, any_value(exchange) from sip_symbol_map group by 1").fetchall())
venue = np.array([ex.get(s, "?") for s in b["symbol"]])
base = elig & ~guard_bad
print()
for v in ("NASDAQ", "NYSE", "AMEX", "OTC", "ARCA", "BATS"):
    show(f"   venue {v}", base & (venue == v), net)
for y_ in range(2016, 2022):
    show(f"   year {y_}, exchange-listed (NASDAQ/NYSE/AMEX)", base & (yr == y_) & np.isin(venue, ["NASDAQ", "NYSE", "AMEX"]), net)
