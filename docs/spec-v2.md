# Churn Top 10 — Spec v2

**Agreed design, not yet built.** Agreed 13 November 2026. This is the product contract for a from-scratch rebuild. The running app still follows the current [README](../README.md) and the docs linked there until this design is implemented.

The goal is to keep the app simple and focused on making profits.

## Documentation for disaster recovery

Every feature must be documented so the app can be recreated if it has to be rebuilt. This file is the agreed product design. Operational recovery (bindings, Access, deploy, rollback, environments) stays in [DEPLOY.md](../DEPLOY.md), [ROLLBACK.md](../ROLLBACK.md), [docs/ACCESS.md](ACCESS.md), [docs/dev.md](dev.md), and [docs/prod.md](prod.md). Robinhood MCP contracts stay in [docs/contracts/robinhood/](contracts/robinhood/). Session and synthetic-stop detail agreed for the current 24/5 work is in [PR #5](https://github.com/ycashlabs/churntop10/pull/5) (`docs/sessions.md` on that branch). New features are written into this spec, or a doc this spec links, when they are agreed.

## Screens

Five screens:

- **Account Summary** — the real Robinhood account only. No simulator cash, positions, or orders appear here.
- **Top 10** — the list that limits new buys. See [Top 10](#top-10).
- **Rules** — the trading contract: named Buy rules and Sell rules the user edits and the bot proofreads. See [Rules](#rules).
- **Simulator** — a separate screen, fake money only. It can run any selected rules, including ones that are still Experimenting. It does not write into Account Summary.
- **Settings** — buy amount min and max, safety limits, and other owner controls. See [Buy amount](#buy-amount) and [Safety limits](#safety-limits).

## Sell All Positions

The control today called Kill Switch is renamed **Sell All Positions**. It sells every open position, after a confirm step, and it also stops new buys.

Live real-money trading stays off until the user explicitly approves, so this control must not send real Robinhood sells until that approval is given. Until then it applies to simulated positions only.

## Top 10

The list is editable at any time. It limits **new buys only**. A position in a symbol that is later removed from the list is still managed and can still be sold. Adding to a symbol already held (dollar-cost averaging) follows the [DCA](#dollar-cost-averaging) and [Buy amount](#buy-amount) rules; it is not blocked merely because the list changed after the position was opened, but a new symbol still has to be on the list to be bought for the first time.

## 24/5 sessions and the synthetic stop

New buys are allowed in every weekday session: pre-market, regular, after-hours, and overnight. The market is closed Friday 8:00 PM through Sunday 8:00 PM ET. Exchange holidays are not modeled.

This summarizes the design in PR #5, `docs/sessions.md` (session times are America/New_York):

| Session | Clock (ET) | Order types |
| --- | --- | --- |
| Regular | Weekdays 09:30–16:00 | Limit, market, broker `stop_market` / `stop_limit` |
| Extended | Weekdays 07:00–09:30 and 16:00–20:00 | Limit orders only |
| Overnight (24 Hour Market) | Sunday 20:00 through Friday 20:00, outside regular and extended | Whole-share limit orders only, and only for symbols on Robinhood’s eligible 24 Hour Market list (that list changes) |
| Closed | Friday 20:00 through Sunday 20:00 | No new orders and no exits |

Outside regular hours there is no resting broker stop. The app holds a **synthetic stop**. Each cycle (cron `*/5`, or a manual Run check) looks at the live quote; if the price is at or below the stop, it cancels the resting take-profit (if any) and submits a **marketable limit sell** priced from the bid with a small offset, then retries and reprices on later cycles if it is still unfilled. When regular hours open, a watching synthetic stop is converted to a real broker stop if no stop-exit is already working.

The stop is only checked when a cycle runs, normally every 5 minutes. A move between checks, a missed cron, a gap through the stop, or the weekend close can pass the stop before a sell is sent.

New buys are skipped when the bid-ask spread is too wide (wider than 1% of mid) or a live quote is stale (older than 5 minutes), or when bid or ask is missing. Overnight buys are whole shares only, and only if the symbol is on the eligible list. ATS price bands around a reference near 8:00 PM ET can reject far-away limits. `get_equity_tradability` output fields for eligibility were not in the captured MCP contract; do not assume every Top 10 name can be bought overnight. A later live path should review the order for that session before placing it.

The v2 safety model drops the PDT day-trade cap that PR #5 still listed as a buy guard. See [Safety limits](#safety-limits).

## Profit target and stop-loss

The profit target (0.1–3%) and the stop-loss percent are based on the **position’s cost basis**, not on account balance. After dollar-cost averaging, that basis is the average cost of the whole position.

## Buy amount

Settings has a **buy amount minimum** and a **buy amount maximum**. Those limits apply to every buy, including DCA adds. Sells have no dollar limit.

### Open questions

These are not decided:

- A **maximum total dollars per symbol** (proposed).
- **Fractional shares in regular hours only** (whole shares remain required overnight, and should stay the default wherever the broker requires them).

## Dollar-cost averaging

Adds to an existing position need a logical, **signal-based** reason. Allowed kinds of reason include money flow, momentum, market mood (including SPY/QQQ), and relative strength. A price drop alone is not a sufficient reason to add.

## Rules

The Rules screen is the contract.

Rules are named **Buy rules** and **Sell rules**, written as bullet text. The user edits the text; the bot proofreads it. Each rule has:

- a name
- a status, **Experimenting** or **Proven**
- plain-English text
- a list of signals

Only the user can mark a rule **Proven**. Live trading uses only Proven rules. If no Buy rule is Proven, live **new buys stay idle**; open trades are still managed under the sell rules (and safety limits) they already have. The Simulator, and dev, can run any selected rules, including Experimenting ones.

Editing a Proven rule moves it back to Experimenting for **new** trades. Open trades keep the **rule version** (buy and sell) they started with.

Every rule change, status change, and approval is logged to a database history table with a timestamp (audit). Each trade records the rule version and which signals fired, with their values.

## Signal lifecycle

1. **Discover** — a candidate signal is identified.
2. **Experiment** — it runs for days, weeks, or months in the Simulator, with a scorecard: win rate, average profit, worst loss, and trade count.
3. **Prove** — the user approves it; the approval is logged with those numbers.
4. **Retire** — it is taken out of use.

New **signal types** need code first. A rule may only reference signal types the app already implements.

## Safety limits

These sit **outside** the rules system. They are always on. Their numbers are editable in Settings:

- Daily loss stop.
- Order cap, which may be set high (for example 50–100 orders per day).
- Buy only with available buying power.
- Never borrow (no margin).

The PDT 3-day-trade cap is **removed**. [FINRA Notice 26-10](https://www.finra.org/rules-guidance/notices/26-10) is effective 4 June 2026, and Robinhood has removed PDT. The MCP account ••••4028 is limited margin, which allows trading unsettled funds; with under $2,000 there is no leverage.

## Live real-money trading

Live real-money trading stays off until the user explicitly approves. Until then, `ALLOW_LIVE_TRADING` remains `"0"`, no real Robinhood orders are placed, and the Simulator is the place that runs selected rules against fake money.
