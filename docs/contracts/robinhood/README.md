# Robinhood Trading MCP

Endpoint: `https://agent.robinhood.com/mcp/trading`

Protocol: MCP `2025-06-18`. Initialize, then `tools/call`. Tool results use a `{data, guide}` envelope. `guide` is presentation advice. The app reads `data` only.

Amounts are strings such as `"300.0000"` or `"0"`. `buying_power` and `crypto_buying_power` are objects.

OAuth discovery follows the path-inserted well-known URLs (RFC 8414 / RFC 9728), then refresh with the `refresh_token` grant. The only scope the server advertises is `internal`. Do not send `offline_access`. Refresh tokens are rotated. A refresh is due in the last tenth of the access-token lifetime, and never more than 60 seconds early.

P&L tools want `rhs_account_number` in `account_number`. This app sends the agentic account's `account_number` when it equals `rhs_account_number`, which is the shape of the agentic account we record.

| UI field | Screen | Tool | MCP field | Required |
| --- | --- | --- | --- | --- |
| Portfolio value | Account Summary | get_portfolio | total_value | required |
| Cash | Account Summary | get_portfolio | cash | required |
| Buying power | Account Summary | get_portfolio | buying_power.buying_power | required |
| Unleveraged buying power | Account Summary | get_portfolio | buying_power.unleveraged_buying_power | required |
| Pending deposits | Account Summary | get_portfolio | pending_deposits | required |
| Crypto buying power | Account Summary | get_portfolio | crypto_buying_power.buying_power | optional |
| Equity value | Account Summary | get_portfolio | equity_value | required |
| Options value | Account Summary | get_portfolio | options_value | required |
| Crypto value | Account Summary | get_portfolio | crypto_value | required |
| Unsettled funds | Account Summary | get_accounts | accounts[].unsettled_funds | required |
| Account type | Account Summary | get_accounts | accounts[].brokerage_account_type | required |
| Brokerage trading type | Account Summary | get_accounts | accounts[].type | required |
| Nickname | Account Summary | get_accounts | accounts[].nickname | optional |
| Option level | Account Summary | get_accounts | accounts[].option_level | optional |
| Agent-tradable | Account Summary | get_accounts | accounts[].agentic_allowed | required |
| Account number | Account Summary | get_accounts | accounts[].account_number | required |
| Today P&L | Account Summary | get_realized_pnl | total_returns | required |
| Today P&L % | Account Summary | get_realized_pnl | total_rate_of_return | required |
| Position symbol | Account Summary | get_equity_positions | positions[].symbol | required |
| Position quantity | Account Summary | get_equity_positions | positions[].quantity | required |
| Position average cost | Account Summary | get_equity_positions | positions[].average_buy_price | optional |
| Last price | Account Summary, Top 10 | get_equity_quotes | results[].quote (see price rule) | required |
| Bid / ask | Top 10 | get_equity_quotes | results[].quote.bid_price / ask_price | required when non-zero |
| Open orders | Account Summary | get_equity_orders | orders | required |
| Order symbol | Account Summary | get_equity_orders | orders[].symbol | required |
| Order side | Account Summary | get_equity_orders | orders[].side | required |
| Order state | Account Summary | get_equity_orders | orders[].state | required |

Empty `positions`, `orders`, and `data_points` are valid. A missing nickname or option level is "Not reported". `total_returns` of `"0"` is $0.00. A null `realized_gain` inside a P&L bucket is "n/a", not zero.

Current price: use whichever of `quote.last_trade_price` and `quote.last_non_reg_trade_price` has the later timestamp. Drop bid and ask when they are zero. If `has_traded` is false or `state` is not `active`, do not treat the price as tradable.

Account numbers are masked to the last 4 in the UI and in logs. Full values stay in memory only long enough to call a tool.
