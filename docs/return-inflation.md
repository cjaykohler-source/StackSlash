# Why a random in-band stock shows +2.3% per 20 sessions (2026-10-01)

`research/return_inflation_check.py` (2016-21 only). The harness's
universe — raw close $0.10-$5, 20-day dollar volume ≥ $250k — shows a
mean 20-session return of **+2.34% after costs** (winsorized 1/99) for a
random stock-day. The catalyst pre-registration called this "inflated" and
said the phase-4 equal-weight index contradicts it. **That was wrong** —
the index rose over 2016-21 (≈89 → a 316 peak in 2021) and only fell
2022-26. This note records what actually produces the number.

| 20-session return after costs, in-band 2016-21 | mean | winsorized | median | compounded |
|---|---|---|---|---|
| all full windows, no artifact guard | +15.55% | +2.60% | −1.00% | +0.39% |
| **harness view (guard on)** | +3.19% | **+2.34%** | −1.00% | −0.17% |
| + names delisted inside the window, at their last close | +3.15% | +2.30% | −1.00% | −0.22% |
| + those names at −100% (worst case) | +2.67% | +1.96% | −1.00% | −4.80% |

1. **Right skew, not a typical gain.** The median stock-day loses 1% and
   the compounded return is about zero; the arithmetic mean is positive
   because of a fat right tail, which survives 1/99 winsorizing. It is the
   expected return of many small equal positions — not of a typical trade.
2. **Two small-cap rallies.** Exchange-listed names by year: 2016 +4.42%,
   2017 +0.99%, 2018 −1.44%, 2019 +0.86%, **2020 +7.39%**, 2021 +0.19%
   (winsorized). The 2016-21 average leans on 2016 and 2020.
3. **The artifact guard is correct.** It drops 663 rows averaging
   +7,000% — data errors such as unadjusted reverse splits — not real crashes.
4. **End of history is small.** 0.5% of rows lose their window to a
   delisting; counting them at −100% only lowers the winsorized mean to +1.96%.
5. **Survivorship is real but concentrated.** Delisted OTC names have
   almost no bars (100 of 16,302; Alpaca keeps little OTC history), and
   ~23% of delisted NASDAQ names are missing (vs 4-8% on NYSE/ARCA/BATS).
   OTC is only 6% of the gated rows and returns *less* than the listed
   venues (+0.75% winsorized, median −4.57%), so it is not what lifts the
   pooled mean; the missing NASDAQ delistings bias it up by an unmeasured,
   likely small amount.

**What to do with absolute returns.** Relative measures (vs random dates,
vs the same day's universe) are unaffected. For any "does it make money"
check, report the **median and the compounded return by year next to the
mean**, compare against the universe over the same dates, and treat a
positive mean that rests on 2016/2020 or on the right tail as regime and
skew, not an edge.
