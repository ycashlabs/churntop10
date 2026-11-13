# Sessions, 24/5 buys, and the synthetic stop

This is the rule the app follows. Session times are America/New_York. Exchange holidays are not modeled. `ALLOW_LIVE_TRADING` stays `"0"`: the live submit path is not armed, and this behavior is proven in the simulator.

## Sessions

| Name in the app | Clock (ET) | MCP `market_hours` | Allowed order types |
| --- | --- | --- | --- |
| Regular | Weekdays 09:30–16:00 | `regular_hours` | Limit, market, `stop_market`, `stop_limit` |
| Extended | Weekdays 07:00–09:30 and 16:00–20:00 | `extended_hours` | Limit only |
| Overnight | Sunday 20:00 through Friday 20:00, outside regular and extended | `all_day_hours` | Whole-share limit only |
| Closed | Friday 20:00 through Sunday 20:00 | — | No new orders, no exits |

Sources: the live Trading MCP input schemas (captured 13 Nov 2026), [Robinhood 24 Hour Market](https://robinhood.com/us/en/support/articles/24hour-market/), and [extended-hours trading](https://robinhood.com/us/en/support/articles/extendedhours-trading/). The MCP schema allows `market`, `stop_market`, and `stop_limit` only with `regular_hours`. A `stop_market` tagged `regular_hours` after the close queues for the next regular open; it does not protect an overnight position. 24 Hour Market GFD limits expire at 20:00 ET (or the next 20:00 ET if placed after 20:00). GTC limits can rest up to 90 calendar days.

## New buys

New buys are allowed in regular, extended, and overnight sessions, still subject to PDT, the order cap, the daily loss stop, the profit target, and the stop-loss percent. They stay blocked when the session is closed, the kill switch is on, View Only is on (the plan is still recorded), or the other existing guards fail.

Every entry is a limit order for whole shares, priced at the ask.

| Session | Entry | Take-profit | Stop |
| --- | --- | --- | --- |
| Regular | Limit, `gfd`, `regular_hours` | Limit, `gtc`, `regular_hours` | Resting broker `stop_market`, `gtc`, `regular_hours` |
| Extended | Limit, `gfd`, `extended_hours` | Limit, `gtc`, `extended_hours` | Synthetic only (see below). No broker stop. |
| Overnight | Limit, `gfd`, `all_day_hours` | Limit, `gtc`, `all_day_hours` | Synthetic only. No broker stop. |

## Quote quality

Skip a new buy when any of these is true:

- The quote is not tradable, or bid or ask is missing or zero. (A last trade alone is not enough to enter.)
- Live Robinhood quotes only: the later of `venue_last_trade_time` and `venue_last_non_reg_trade_time` is older than 5 minutes. The recorded book used when Robinhood is not connected is treated as the current print, so this stale check does not apply to it.
- The spread `(ask - bid) / mid` is greater than 1%.

## Overnight eligibility

Robinhood’s 24 Hour Market is a named list of stocks and ETFs. It changes. A symbol that is not on the list cannot use `all_day_hours`; overnight volume is thinner and spreads are wider. ATS venues also apply price bands around a reference set near 20:00 ET and can reject limits outside those bands.

`get_equity_tradability` is in the MCP, but this repo has only its input schema. The output fields that would mark 24 Hour Market eligibility were not in the captured contract, so this app does not invent them. In the simulator, a tradable quote is treated as overnight-eligible unless a test sets `overnightEligible` to false. When live trading is later armed, an overnight (or extended) order must pass `review_equity_order` with the session’s `market_hours` before `place_equity_order`; a review rejection skips that symbol. Until that contract is captured, do not assume every Top 10 name can be bought overnight.

## The synthetic stop

Outside regular hours the app does not send a broker stop. It stores the stop price locally (simulator order role `stop`, type `synthetic`, status `watching`).

Each cron cycle (`*/5 * * * *`, and any manual Run check) does this for each open position:

1. If the session is closed, wait. No buys, no exits.
2. If the session has become regular and the stop is still synthetic (and no stop-exit is already working), convert it to a resting broker `stop_market` with `gtc` and `regular_hours`. The take-profit already resting can stay, or is replaced with a `regular_hours` `gtc` limit if it was an off-hours order. In the simulator this is a local type change; with the live gate off, nothing is sent to Robinhood.
3. If a broker `stop_market` is working and the last price is at or below the stop, the simulator fills the sell at the bid (regular-hours broker-stop behavior).
4. If a synthetic stop is watching and the last price is at or below the stop, and a usable bid exists, the app cancels the resting take-profit (if any) and submits a **marketable limit sell**: limit = bid minus the greater of $0.02 and 0.05% of last, rounded to the cent, `gfd`, with the current session’s `market_hours`. In the simulator that order is role `stop_exit`, type `limit`, status `working`.
5. If a `stop_exit` is already working: fill it when it is still marketable (limit ≤ bid). If the bid has moved down so the old limit is no longer marketable, reprice to a new bid-based limit and retry. If there is no usable bid, leave it and try next cycle.
6. A take-profit limit still fills when last is at or above its price and the session is open.

The stop is only checked when a cycle runs, normally every 5 minutes. A print that trades through the stop between cycles, a missed cron, or the weekend close can leave the position unprotected until the next cycle. A gap through the stop still sells, at the marketable limit from the current bid, which can be worse than the stop. This is not a resting broker stop.

### Partial fills, session changes, and the weekend

- A symbol that is exited on a cycle is not bought again on that same cycle. The next cycle can consider a new entry.
- A partial fill reduces the position. The leftover stay is still watched. The take-profit, if it was cancelled, is replaced later only for the remaining quantity; the simulator currently fills entries and marketable stop-exits in full when they are marketable, and tests can force a remainder.
- If a `stop_exit` is working when regular hours open, do not also attach a broker stop (that would risk a double sell). Keep repricing the limit until it fills.
- Friday 20:00–Sunday 20:00 ET: no new buys and no exits. A watching synthetic stop stays on the book and is evaluated at Sunday 20:00.

## Live gate

`submitGatedTool` still refuses every broker call while `ALLOW_LIVE_TRADING` is not `"1"`, and it still refuses `cancel_equity_order` and modify tools even if that var is later set to `"1"`. Kill switch does not cancel real Robinhood orders. When live trading is eventually armed, off-hours work will need an explicit follow-up: persist broker order ids, allow cancel of our own take-profit (and only that) to fire a synthetic stop, and review-then-place session-correct limits. This change does not do that.

## What the UI says

Latest check and Settings state that buys run 24/5 (Sunday 20:00–Friday 20:00 ET), that off-hours orders are limits only, and that the app watches the stop every 5 minutes. They include a short note that a move between checks can pass the stop before a sell is sent. The old “new buys run only in regular hours” copy is gone.
