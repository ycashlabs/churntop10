# Robinhood agent trading, PDT, and sessions

Read on 13 Nov 2026. This is a record of the public rules the guards follow. It is not legal advice.

## Can this app trade the agent account?

Robinhood's own pages say an external agent connected through the Trading MCP can place orders, and only in the Agentic account.

- [Onboarding an external agent](https://robinhood.com/us/en/support/articles/onboarding-an-external-agent/) says the agent can read every account, position, and order, and "Your agent can only place trades in your Robinhood Agentic account." You remain responsible for the trades. If you tell the agent not to ask, it can place trades without a confirmation.
- [Trading with your agent](https://robinhood.com/us/en/support/articles/trading-with-your-agent/) says external agents can place long equity, options, and crypto orders (market, dollar-based market, limit, stop market, stop limit). Trade approvals default off for MCP accounts, so an agent can place eligible trades without a tap in the app. Some trades still require approval. Multi-leg options are excluded.
- [Robinhood Customer Agreement section 29.8](https://cdn.robinhood.com/assets/robinhood/legal/Robinhood-Customer-Agreement.pdf) (RHF-RHS) defines an AI agent and an Agentic Account. Instructions from an authenticated agent session are binding. You can revoke access, and Robinhood does not have to unwind orders already received. The same section says an in-app agent may view other accounts but may place orders only in an Agentic Account.
- [Robinhood Agentic Account Agreement](https://cdn.robinhood.com/assets/robinhood/legal/agent_apps_agreement.pdf) and the [Robinhood Agents Agreement](https://cdn.robinhood.com/assets/robinhood/legal/robinhood_agents_agreement.pdf) describe Trade Approvals and scheduled loops. The customer agreement says the agent does not have discretionary authority: the orders are yours.

The live `get_accounts` payload includes `agentic_allowed`. This app will only target the account where that flag is true, and only if you later set `ALLOW_LIVE_TRADING` to `1`. The copy in this repo leaves that var at `0`. The shipping path fills the simulator. `cancel_equity_order` is not called from anywhere, including the kill switch.

OAuth is the Trading MCP resource `https://agent.robinhood.com/mcp/trading`. Discovery uses the path-inserted well-known URLs, PKCE S256, a public client, and scope `internal`. Do not ask for `offline_access`. Refresh tokens come from the `refresh_token` grant and rotate. The same flow is implemented in ycashlabs/churncapital.

## Pattern day trader

Two sources disagree on purpose, and the dates explain it.

- [FINRA Regulatory Notice 26-10](https://www.finra.org/rules-guidance/notices/26-10) (20 Apr 2026) adopts intraday margin standards that replace the day-trading margin rules, including the pattern-day-trader count and the $25,000 minimum. Effective 4 Jun 2026, with a phase-in through 20 Oct 2027. [Notice 26-11](https://www.finra.org/rules-guidance/notices/26-11) deletes the old PDT interpretations.
- [Robinhood's pattern day trading article](https://robinhood.com/us/en/support/articles/pattern-day-trading/) still describes the old rule: 4 or more day trades in 5 trading days, more than 6% of trades in that window, margin accounts, $25,000 equity. That page had not been rewritten to the FINRA notice when this was checked.

The app keeps a local cap of 3 round trips in the last 5 business days. It is this app's limit, not a claim that Robinhood will flag the account. A stop-loss or target sell is allowed even when the cap is used up. New buys are not. Exchange holidays are not on the calendar yet.

## Sessions

- Regular hours are 9:30–16:00 ET. Extended hours on Robinhood's limit-order page are 7:00–9:30 and 16:00–20:00 ET. [24 Hour Market](https://robinhood.com/us/en/support/articles/24hour-market/) runs Sunday 8:00 PM ET through Friday 8:00 PM ET. The gap from Friday 8:00 PM to Sunday 8:00 PM is closed. Only whole-share limit orders trade in the 24 Hour Market.
- The Trading MCP schema says `extended_hours` and `all_day_hours` execute limit orders only. `market`, `stop_market`, and `stop_limit` are `regular_hours` only. A stop tagged `regular_hours` after the close queues for the next regular open. It does not protect an overnight position.

This app opens new buys in every weekday session (pre-market, regular, after-hours, and overnight). The rules for order types, the synthetic stop, quote quality, and overnight eligibility are in [sessions.md](sessions.md). In short: outside regular hours, entries and exits are limit orders only, and the stop is watched by the app every 5 minutes rather than resting at the broker. When regular hours open, a watching synthetic stop is converted to a broker `stop_market`. `ALLOW_LIVE_TRADING` stays `"0"`, so this path runs in the simulator.

New buys must be symbols on the Top 10. A buy that adds to a symbol you already hold, and every sell, is not limited by that list.
