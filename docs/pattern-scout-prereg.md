# Pattern scout: intraday confluence, three arms (pre-registration)

Written 2026-11-17. Construction only: merging records the design; discovery runs only on the user's explicit go-ahead in a session. Agent profile:
`.claude/agents/pattern-scout.md`.

## Question

Do minute-bar patterns on a day, combined with daily-bar context, line up with
the next 1, 5 or 20 sessions in a $0.10-$5 stock, by more than patterns that
carry no plausible signal?

## Data slices

| slice | entry dates | used for |
|---|---|---|
| discovery | 2016-2019, close $0.10-$5 | the scout's search |
| confirmation | 2020-2021, close $0.10-$5 | one run per candidate, after its own pre-registration merges |
| sealed | 2022+, and any day above $5 | untouched by this work |

Minute data: SIP minute warehouse (`research/data/minute/`). Daily context:
`sip_bars_daily_raw` / `sip_bars_daily_split`. Gate: 20-day SIP dollar volume
>= $2.5M ending the day before entry.

## The three arms

Each pattern is assigned an arm before its outcome is computed.

- **Gains:** patterns proposed as bullish (for example an opening-range break
  held above VWAP into the close on 3x volume after a 10-day volume build).
- **Negative:** patterns proposed as bearish or as avoid rules (for example a
  high printed in the first 30 minutes, then a close below VWAP on a gap-up
  day). These feed vetoes, like the validated dilution rule.
- **Neutral (placebo):** patterns built to carry no signal, used to measure the
  noise floor:
    1. *Shuffled real patterns:* each real pattern re-run with its event dates
       permuted within symbol.
    2. *Mechanism-free patterns:* conditions with the same structure but no
       plausible link to outcomes (for example volume above median in an
       arbitrary minute window chosen at random from a seed fixed below).
    3. *Random days:* random gated days drawn to the real pattern's event count.

  Each placebo is matched to a real pattern on event count (within 10%), price
  band, liquidity tercile and year mix, so placebo noise is measured at the same
  sample size as the patterns it judges. At least as many neutral patterns are
  tested as gains and negative patterns combined. Random seed: 20261117.

## Outcome (identical for all arms)

Excess net return over the random gated in-band day, at 1, 5 and 20 sessions:
return on split-adjusted closes from the entry close, net of max(1%, $0.01 /
as-traded entry close). Also reported: win rate, and U:D (share of events
reaching +10% before -10% against the reverse).

## Margin of error and pass bar

1. **Neutral band:** from the neutral arm's excess returns, by horizon, the
   2.5th to 97.5th percentile. This is the realistic margin of error: what
   pattern-shaped noise produces at this sample size in this data.
2. **Harness check:** the neutral arm's median excess must be within
   ±0.25 pp of zero. If not, the harness is broken; stop and report.
3. **Candidate bar:** a gains pattern must sit above the band's upper edge, a
   negative pattern below its lower edge, at the 5- or 20-session horizon;
   **and** survive Benjamini-Hochberg at q <= 0.10 across every gains and
   negative pattern in the ledger (the family = all of them, not the winners);
   **and** have at least 200 discovery events.
4. Candidates go to `research/data/scout/candidates.md` with a draft
   pre-registration for the 2020-21 confirmation run. Nothing becomes a
   trigger, flag or finding from discovery alone.

## Ledger

`research/data/scout/ledger.csv`, append-only: pattern id, arm, exact
definition, parameter grid, timestamp, then n, excess at 1/5/20, win rate,
U:D. Written before the next pattern is evaluated.

## Known limits

- `docs/minute-direction.md` found too few events (86) for rare-event minute
  features; the 200-event floor exists for that reason.
- The ticker-history survivorship issue raised in the Layer 3 catalyst audit
  applies here too; it shifts all three arms alike, so the band comparison
  is still fair, but absolute levels are not.
