# The agent-trader's shape (item 36)

**Status: PROPOSAL, 2026-10-03.** The user approves by merging. Nothing
here is built yet, and nothing here places orders. Decisions already taken
(2026-10-03): design doc first, no code; **the sleeve starts empty** and
stays empty until a rule passes a pre-registered forward test.

## 1. Why this shape

Every positive signal tried on this universe has failed out of sample or
never cleared discovery (README, "Session 2026-09-30 → 10-02"). The only
results that survived sealed 2022+ data are **avoid rules**. So the
system is built around what is known:

- **An index core** carries the return. Timing it didn't help: a 200-day
  trend rule on SPY cost ~40% of ending value 2017-26, and momentum alone
  drew down 57% (`research/withdrawal_sim.py`). Caveat: the data has no
  long bear market.
- **A rules-based sleeve** is the only place a stock-level rule can get
  capital, and only after passing a forward test. Until then it holds cash.
- **Validated vetoes** apply to anything the sleeve would buy and are
  reported on anything already held.
- **The agent is the analyst and risk officer**, not a signal-finder. It
  reads, checks, computes and reports. It never trades, and never says
  when to buy or sell.

## 2. The evidence it rests on

| Veto | Window | 2022+ result (vs same names at random dates) | Source | Live today |
|---|---|---|---|---|
| S-1/S-3/F-1/F-3 filed | last 30 days | −11.3% over 60 sessions [−13.1, −9.5]; 21% fall ≥ 30% (vs 11%) | `docs/filing-state-study.md` | red, `riskFlags.ts` (offering) |
| 424B4/424B5 priced offering | last 30 days | −9.4% / 60 sessions [−11.2, −7.7] | same | red (offering) |
| Shares ≥ 2x a year ago | point in time | −6.7% (1-3x), −11.7% (3x+) / 60 sessions | same | red at 2x+ |
| Market cap < $10M | point in time | −12.7% / 60 sessions [−14.6, −10.7] | same | red (nano-cap tiny) |
| Trading-halt headline | last 28 days | −9.5% / 20 sessions; −9.7% in $0.10-$5 | `docs/catalyst-2022-prereg.md` | red, `catalystNews.ts` |
| Partnership / licensing PR | last 28 days | −1.6% / 20 sessions; −2.2% in-band | same | red, `catalystNews.ts` |

Not vetoes (reported as context only): 10-K (passes, not in-band), cash
runway (amber, one regime only), volume ≥ 25x (backtest only; amber in
spirit, red on the dossier today), going-concern 10-K (secondary, p 0.18).

Dropped and not to be revived without new forward data: insider buys (all
sizes), earnings beats, 8-K 2.02, 10-Q, the two-sided score, minute-bar
direction, overnight holds, breakout timing, trend-following on >$5 names.

## 3. The four parts

### 3.1 Core

- A broad, low-cost index holding, bought and held, with no timing rule.
  Which fund, and how much of the account, are **the user's decisions**;
  the system takes them as settings (`core_weight`, `core_symbol`).
- The agent's only job here is reporting: drift from the target weight,
  and the account's withdrawal math if the user sets a withdrawal rate
  (the `withdrawal_sim.py` smoothed rule).

### 3.2 Sleeve: empty until a rule graduates

- Capped at `sleeve_max_weight` (user setting). **It holds T-bills/cash
  until a rule graduates.**
- **Graduation:** the rule is written down with every setting fixed in a
  pre-registration doc plus a frozen runner (the `holdout_*.py` pattern),
  approved by merge, and then passes on data **dated after the merge**
  (item 48's fresh holdout, from 2026-10 onward). It must also pass net of
  each stock's own measured spread (`symbol_spread_estimates`,
  `ar_minute_20d`) and against the random in-band control, with median,
  compounded and by-year results reported next to the mean
  (`docs/return-inflation.md`).
- **Minimum evidence:** the doc states the sample size and the
  duration before any test runs. Rough guide: the 2022+ tests had
  1,800-7,000 events; a forward test with a few hundred events is
  underpowered, which means most candidates will need 6-12+ months of
  forward data before they can be judged.
- **Sizing once live:** equal weight, a per-name cap, and a liquidity cap
  (position ≤ a fixed share of the 20-session median dollar volume), all
  pre-registered with the rule.
- **Kill rule (pre-registered with the rule):** the live sleeve is
  compared with the same rule's forward-test distribution; a drawdown or
  shortfall outside a stated bound sends it back to cash automatically,
  and the agent reports the trip.
- **The current candidate queue:** earnings *big* beat (+1.2% secondary on
  2022+, must be tested fresh), Reddit attention (item 42, collecting since
  09-30). Neither is close to testable.

### 3.3 Vetoes

- **Hard veto on the sleeve:** a name carrying any §2 veto at the
  decision timestamp is not bought. No override.
- **Report-only on everything else** (the core, and any holding the user
  picks by hand): the agent lists which vetoes apply and the evidence
  behind each, and acts on none of them.
- One definition everywhere: the vetoes are evaluated by the existing
  `riskFlags.ts` / `catalystNews.ts` code, so the dossier, the feed and the
  agent can't disagree. Changing a threshold means changing that code,
  under the same validation rules.
- **Point in time:** a veto check for a past date uses only filings,
  headlines and share counts known at that timestamp (the deep-dive
  backfill mode already does this).

### 3.4 The agent: analyst and risk officer

What it does, per holding and per account:

1. **Risk card**: the active flags (red/amber/green) with their evidence
   line, the upcoming events (earnings, shareholder meetings, note
   conversions, offering windows), and descriptive base rates for similar
   stocks, labelled as descriptive when they are not a validated rule.
2. **Position math**: cost basis, value, P/L, the dollar effect of a 1¢
   / 1% move, and the share of the account.
3. **Event watch**: new 424B, 8-K 3.01 (listing deficiency), reverse
   split (8-K 5.03 / corporate action / proxy proposal), DEF 14A or PRE 14A
   proposals, new S-1/S-3. Each is reported once, with the filing link.
4. **Veto audit**: for the sleeve, a log of every name vetoed and why, so
   the vetoes' own forward performance can be measured later.
5. **Weekly drift report**: core vs target weight, sleeve state
   (cash / live / tripped), and any job on `/ops` that would make the
   above stale (e.g. sec-filings-sync failing means the event watch is
   blind).

What it never does:

- place, cancel or stage an order (the Robinhood and IB connections stay
  read-only; any Robinhood tool call needs the user's per-action go-ahead);
- say when to buy or sell, or rank holdings by attractiveness;
- invent a signal: anything untested is labelled amber/descriptive, and a
  new rule goes through §3.2, never straight into a recommendation.

## 4. What exists already, and what would be new

| Piece | Exists | New |
|---|---|---|
| Veto evaluation | `riskFlags.ts`, `catalystNews.ts`, dossiers | none |
| Filings / headlines / corporate actions | `sec_filings`, `symbol_news`, `corporate_actions` | proxy (DEF 14A / PRE 14A) proposal parsing for reverse splits and share authorizations |
| Spread costs | `symbol_spread_estimates` (minute-based) | fallback for the ~433 thin names (item 52) |
| Holdings | `manage-positions` (flip positions only) | a `holdings` table (user-entered: symbol, shares, cost) and settings |
| Risk card / drift report | none | a daily job writing to a table, shown on a page and one Discord card |
| Forward-test slot | the `holdout_*.py` pattern, registry DuckDB | a dated forward holdout (item 48) |

## 5. Decisions left for the user

1. `core_symbol`, `core_weight`, `sleeve_max_weight`, optional withdrawal
   rate: settings, entered by the user.
2. Whether holdings are entered by hand (simplest, no broker link) or read
   from the Robinhood connector (needs a per-action go-ahead each time, so
   it can't run unattended). Recommended: by hand.
3. Whether the event watch should parse proxies (§4). This is the one gap
   the 2026-10-03 FNGR check exposed: the 10-06 special meeting
   (share-issuance and authorized-share proposals) was only in a DEF 14A
   that no job reads.

## 6. Build order (after approval)

1. `holdings` + settings tables, entered by hand.
2. Daily risk-card job reusing the dossier flag code; one Discord card,
   one page.
3. Event watch, including proxy proposals.
4. Item 48: the forward-holdout pre-registration, so a sleeve candidate
   has a route to capital.
5. Weekly drift report.
