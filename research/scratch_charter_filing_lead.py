"""
One-off diagnostic (2026-09-25/26, not a standing instrument): does an 8-K
item 5.03 (charter amendment) or 3.03 (material modification to
shareholder rights) filing actually precede a reverse split's ex-date, and
by how much? upcoming_catalysts (2026-09-25) surfaces these filings as an
unverified "lead" -- this checks the claim against the full 2016-2026
EDGAR + corporate-actions history rather than trusting it.
"""
import duckdb
from pathlib import Path

ROOT = Path(__file__).resolve().parent
EDGAR = ROOT / "data" / "edgar"
CA = ROOT / "data" / "corporate_actions"

con = duckdb.connect()

con.execute(f"""
  create temp table ticker_cik as
  select ticker, min(cik) cik from (
    select ticker, cik from read_parquet('{EDGAR}/edgar_tickers.parquet')
    union select unnest(tickers) ticker, cik from read_parquet('{EDGAR}/edgar_companies.parquet')
  ) group by ticker
""")

con.execute(f"""
  create temp table charter_filings as
  select distinct tc.ticker symbol, fl.filing_date::date fdate, fl.items
  from read_parquet('{EDGAR}/edgar_filings.parquet') fl
  join ticker_cik tc on tc.cik = fl.cik
  where fl.form = '8-K'
    and (regexp_matches(coalesce(fl.items, ''), '(^|,)5\\.03(,|$)')
      or regexp_matches(coalesce(fl.items, ''), '(^|,)3\\.03(,|$)'))
    and fl.filing_date >= '2016-01-01'
""")

con.execute(f"""
  create temp table rs as
  select distinct symbol, ex_date::date xdate
  from read_parquet('{CA}/*.parquet', union_by_name = true)
  where type = 'reverse_splits' and ex_date between '2016-01-01' and '2030-01-01'
""")

# For every reverse split, the nearest charter-type 8-K within [-120, +30]
# days of the ex-date (negative = filed before it, i.e. a real lead).
con.execute("""
  create temp table matched as
  select rs.symbol, rs.xdate, cf.fdate, (cf.fdate - rs.xdate) as offset_days
  from rs
  join charter_filings cf on cf.symbol = rs.symbol
    and cf.fdate between rs.xdate - interval 120 day and rs.xdate + interval 30 day
""")

total_rs = con.execute("select count(*) from rs").fetchone()[0]
matched_rs = con.execute("select count(distinct symbol || xdate::text) from matched").fetchone()[0]
print(f"Reverse splits total: {total_rs:,}")
print(f"Reverse splits with a charter-type (5.03/3.03) 8-K within -120d..+30d of ex-date: {matched_rs:,} "
      f"({matched_rs / total_rs * 100:.1f}%)")
print()

# One row per split: its EARLIEST matching charter filing (the one that
# would actually have been seen first).
con.execute("""
  create temp table first_match as
  select symbol, xdate, min(offset_days) as offset_days
  from matched
  group by symbol, xdate
""")

print("Distribution of (charter filing date - ex-date), days -- negative = filed BEFORE the split:")
buckets = [
    ("filed > 30d before", "offset_days < -30"),
    ("filed 8-30d before", "offset_days between -30 and -8"),
    ("filed 1-7d before", "offset_days between -7 and -1"),
    ("filed same day", "offset_days = 0"),
    ("filed after ex-date", "offset_days > 0"),
]
for label, cond in buckets:
    n = con.execute(f"select count(*) from first_match where {cond}").fetchone()[0]
    pct = n / matched_rs * 100 if matched_rs else 0
    print(f"  {label:>22}: {n:>5}  ({pct:4.1f}% of matched)")

med = con.execute("select median(offset_days) from first_match where offset_days <= 0").fetchone()[0]
print(f"\nMedian lead time (splits filed on/before ex-date only): {-med:.0f} days before" if med is not None else "")
