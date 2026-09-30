# Automatic liquidity floors — design (not built)

Written 2026-09-30. A proposal, parked on the open-items list (README,
item 33). Replaces the retired one-off `set-sip-floors-once` job, which
only ever wrote two hard-coded numbers.

## Today

`scan_config` holds two hand-set floors on 20-day average dollar volume:

| floor | value | controls | place in the $0.10-$5 band, 2026-09-30 (1,452 names) |
|---|---|---|---|
| `monitor_min_dollar_vol_20d` | $800k | which names the live intraday scans watch | top ~45% (median ≈ $605k) |
| `min_dollar_vol_20d` | $2.5M | which fires can be promoted to alerts/positions | top ~27% (p75 ≈ $2.7M) |

Both were set on 2026-09-17 from the research studies and never move
with market volume: in a hot small-cap tape $800k admits too many
marginal names; in a quiet one it can halve the watched universe. The
promotion floor is also editable on `/settings`.

## What the floor should be based on

Each floor = the **higher** of two rules:

1. **Tradability (primary).**
   - *Size:* a position shouldn't exceed a set share of daily volume.
     Planned position $5k at a 1% participation cap → $5k / 1% = **$500k/day**.
     Position size comes from the agent-trader's risk settings, so the
     floor scales with the account.
   - *Cost:* `refresh-spread-estimates` already estimates each name's
     spread weekly. A name is tradable only if its estimated round-trip
     cost is at or below the 1% the backtests assume; the floor is the
     dollar-volume level above which most names clear that bar.
2. **Percentile guardrail (secondary).** Hold each floor near its current
   place in the distribution (≈ p55 monitor, ≈ p73 promotion), measured
   on the **trailing 60 days**, not one day — keeping the universe a
   stable size (~650 watched / ~390 promotable today) through volume
   swings.

The max means a volume drought can't drop the floor below what's
genuinely tradable, and a boom can't balloon the universe.

## Stability

- Weekly, Sunday, right after `refresh-spread-estimates` (fresh costs).
- Change only if the new value differs by > 15% (no weekly creep).
- At most ±25% per week.
- Round to $50k; clamp (e.g. monitor $300k–$3M, promotion $1M–$10M).

## Settings — never a silent overwrite

- Per-floor mode in `scan_config`: `manual` (today) or `auto`. The job
  only writes floors in `auto`.
- It always stores its **recommendation** in separate columns, so
  `/settings` can show "auto recommends $950k (you: $800k)" even in
  manual mode.
- Every change is logged to a new `scan_config_history` table: old, new,
  which rule set it, and the numbers behind it.

## Validation before switching it on

1. **Replay history** on the SIP warehouse (2016–today): what the auto
   floors would have been weekly, and how universe size would have moved.
   Check 2020–21 and 2022 for anything odd.
2. **Check the edge survives:** rerun the event studies and read
   `fire_outcomes` by liquidity tier. If the validated signals (earnings
   drift, the dilution avoid rules) weaken above or below some dollar
   volume, the floor must respect it — the catalyst research already
   found the edge fades above $5.
3. **Shadow mode 4–6 weeks:** recommendations only, visible on Settings
   and Ops, floors still manual; switch to `auto` only once the numbers
   look sensible.

## Visibility

New Ops job `recalc-liquidity-floors` (weekly), logging to `job_runs`;
its Ops drop-down shows current vs recommended floors, which rule set
each, and the last change.

## Open decisions

1. Planned position size and participation cap (suggested $5k / 1%) —
   drives the primary rule.
2. Shadow mode first (recommended: yes).
3. Scope: the $0.10–$5 band only, or also the $0.10–$15 range the
   research uses.
