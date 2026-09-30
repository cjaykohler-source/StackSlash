"""
Charter metric catalog (served at /catalog): every metric the API can serve, with its label,
group, unit, source, first date of coverage and a one-line definition.
The Charter page renders its metric pickers and help text from this, so a
metric is added in exactly one place.

`kind`:
  daily   a per-symbol daily series computed by /daily (SIP warehouse)
  series  a per-symbol series from another endpoint (short, fundamentals, reddit)
Units: price | pct (fraction, 0.05 = 5%) | ratio | count | shares | usd | index
"""

SMAS = (5, 10, 20, 40, 50, 60, 200)

METRICS = [
    # --- price & volume (SIP daily warehouse) ---
    dict(id="open", label="Open", group="Price", unit="price", kind="daily", source="SIP daily (split-adjusted)", since="2016-01-04", desc="Session open, split-adjusted to today's share basis."),
    dict(id="high", label="High", group="Price", unit="price", kind="daily", source="SIP daily (split-adjusted)", since="2016-01-04", desc="Session high, split-adjusted."),
    dict(id="low", label="Low", group="Price", unit="price", kind="daily", source="SIP daily (split-adjusted)", since="2016-01-04", desc="Session low, split-adjusted."),
    dict(id="close", label="Close", group="Price", unit="price", kind="daily", source="SIP daily (split-adjusted)", since="2016-01-04", desc="Session close, split-adjusted."),
    dict(id="raw_close", label="Close (as traded)", group="Price", unit="price", kind="daily", source="SIP daily (raw)", since="2016-01-04", desc="Close as it actually printed that day, not split-adjusted — what the price band filters use."),
    dict(id="vwap", label="VWAP", group="Price", unit="price", kind="daily", source="SIP daily", since="2016-01-04", desc="Volume-weighted average traded price for the session (split-adjusted)."),
    dict(id="volume", label="Volume", group="Volume", unit="shares", kind="daily", source="SIP daily", since="2016-01-04", desc="Consolidated shares traded (all venues), as reported that day."),
    dict(id="trade_count", label="Trade count", group="Volume", unit="count", kind="daily", source="SIP daily", since="2016-01-04", desc="Number of individual trades in the session."),
    dict(id="dollar_volume", label="Dollar volume", group="Volume", unit="usd", kind="daily", source="SIP daily", since="2016-01-04", desc="Raw close x volume."),
    dict(id="dollar20", label="20-day avg dollar volume", group="Volume", unit="usd", kind="daily", source="derived", since="2016-02-02", desc="Mean dollar volume over the last 20 sessions (incl. today) — the liquidity floor metric."),
    dict(id="vol_ratio", label="Volume vs 20-day avg", group="Volume", unit="ratio", kind="daily", source="derived", since="2016-02-02", desc="Today's volume / mean volume of the previous 20 sessions (1.0 = normal)."),
    dict(id="avg_trade_size", label="Avg trade size", group="Volume", unit="shares", kind="daily", source="derived", since="2016-01-04", desc="Volume / trade count."),
    dict(id="ret_1", label="Daily return", group="Returns", unit="pct", kind="daily", source="derived", since="2016-01-05", desc="Close vs previous close."),
    dict(id="gap", label="Gap (overnight)", group="Returns", unit="pct", kind="daily", source="derived", since="2016-01-05", desc="Open vs previous close."),
    dict(id="body", label="Open→close (candle body)", group="Returns", unit="pct", kind="daily", source="derived", since="2016-01-04", desc="Close vs the same day's open (green > 0, red < 0)."),
    dict(id="ret_5", label="5-day return", group="Returns", unit="pct", kind="daily", source="derived", since="2016-01-11", desc="Close vs 5 sessions ago."),
    dict(id="ret_20", label="20-day return", group="Returns", unit="pct", kind="daily", source="derived", since="2016-02-02", desc="Close vs 20 sessions ago."),
    dict(id="range_pct", label="Day range", group="Volatility", unit="pct", kind="daily", source="derived", since="2016-01-04", desc="(High - low) / previous close."),
    dict(id="atr14_pct", label="ATR 14 (% of price)", group="Volatility", unit="pct", kind="daily", source="derived", since="2016-01-22", desc="Average true range over 14 sessions, as a fraction of the close."),
    dict(id="clv", label="Close location in range", group="Price", unit="ratio", kind="daily", source="derived", since="2016-01-04", desc="Where the close sat in the day's range: 0 = at the low, 1 = at the high."),
    dict(id="close_vs_vwap", label="Close vs VWAP", group="Price", unit="pct", kind="daily", source="derived", since="2016-01-04", desc="Close / VWAP - 1: above 0 means the close held above the day's average traded price."),
    dict(id="pct_52w_high", label="% of 52-week high", group="Trend", unit="ratio", kind="daily", source="derived", since="2016-01-04", desc="Close / highest high of the last 252 sessions (or all history if shorter)."),
    dict(id="pct_52w_low", label="% of 52-week low", group="Trend", unit="ratio", kind="daily", source="derived", since="2016-01-04", desc="Close / lowest low of the last 252 sessions."),
    *[dict(id=f"sma{k}", label=f"SMA {k}", group="Trend", unit="price", kind="daily", source="derived", since="2016-01-04",
           desc=f"Simple moving average of the close over {k} sessions.") for k in SMAS],
    *[dict(id=f"dist_sma{k}", label=f"Distance from SMA {k}", group="Trend", unit="pct", kind="daily", source="derived", since="2016-01-04",
           desc=f"Close / SMA {k} - 1.") for k in SMAS],
    *[dict(id=f"slope_sma{k}", label=f"SMA {k} slope (5d)", group="Trend", unit="pct", kind="daily", source="derived", since="2016-01-04",
           desc=f"SMA {k} vs its value 5 sessions earlier - 1 (rising > 0).") for k in SMAS],
    dict(id="split_factor", label="Split factor", group="Corporate", unit="ratio", kind="daily", source="SIP daily", since="2016-01-04", desc="Split-adjusted / raw close: changes when a split takes effect."),
    # --- short selling (FINRA) ---
    dict(id="short_interest", label="Short interest", group="Short", unit="shares", kind="series", source="FINRA consolidated", since="2018-01-12", desc="Shares sold short at each twice-monthly settlement, restated to today's share basis. Dated by publication (~settlement + 8 business days)."),
    dict(id="days_to_cover", label="Days to cover", group="Short", unit="ratio", kind="series", source="FINRA consolidated", since="2018-01-12", desc="Short interest / average daily volume, as FINRA reports it."),
    dict(id="short_float", label="Short float", group="Short", unit="pct", kind="series", source="FINRA + SEC", since="2018-01-12", desc="Short interest / shares outstanding (latest filed), both on today's share basis."),
    dict(id="short_volume_ratio", label="Short volume ratio", group="Short", unit="pct", kind="series", source="FINRA Reg SHO", since="2018-08-01", desc="Share of the day's volume that was short sales (not the open short position)."),
    # --- fundamentals (SEC EDGAR, as filed) ---
    dict(id="shares_outstanding", label="Shares outstanding", group="Fundamentals", unit="shares", kind="series", source="SEC EDGAR", since="2009", desc="Cover-page / balance-sheet shares, dated by filing, restated to today's share basis."),
    dict(id="public_float", label="Public float ($)", group="Fundamentals", unit="usd", kind="series", source="SEC EDGAR", since="2009", desc="Market value of non-affiliate shares, from the 10-K cover page (annual)."),
    dict(id="cash", label="Cash", group="Fundamentals", unit="usd", kind="series", source="SEC EDGAR", since="2009", desc="Cash and equivalents at each filing."),
    dict(id="operating_cash_flow", label="Operating cash flow", group="Fundamentals", unit="usd", kind="series", source="SEC EDGAR", since="2009", desc="Net cash from operations for the filed period (negative = burn)."),
    # --- attention ---
    dict(id="reddit_mentions", label="Reddit mentions (24h)", group="Attention", unit="count", kind="series", source="ApeWisdom", since="2026-09-30", desc="Rolling 24-hour ticker mentions on r/pennystocks + r/stocks + r/wallstreetbets, latest snapshot each day."),
    dict(id="reddit_upvotes", label="Reddit upvotes (24h)", group="Attention", unit="count", kind="series", source="ApeWisdom", since="2026-09-30", desc="Upvotes on mentioning posts/comments, latest snapshot each day."),
]

DAILY_IDS = [m["id"] for m in METRICS if m["kind"] == "daily"]
BY_ID = {m["id"]: m for m in METRICS}
