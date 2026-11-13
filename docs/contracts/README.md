# Data contracts

Churn Top 10 talks to Robinhood only through the Trading MCP. The contract is written before the client.

For each field the app reads:

- external name and type
- required or optional
- which screen shows it

Rules:

- An optional field that is absent renders as "Not reported".
- A required field that is missing or the wrong type is a contract violation. The screen shows "Unavailable" for that field.
- Outgoing tool arguments are checked against the saved JSON Schema with `additionalProperties: false` before any call.
- Live order tools (`review_equity_order`, `place_equity_order`, `cancel_equity_order`) stay behind `ALLOW_LIVE_TRADING`. The default is off. Tests never send them to Robinhood.

Schemas are the live MCP input schemas captured on 2026-11-13. The quote fixture is the live `get_equity_quotes` payload from 2026-11-13T00:29:20Z, reduced to the fields this app reads. Account, portfolio, and P&L fixtures keep the live field names and types. Account numbers and balances in those fixtures are synthetic stand-ins so this public repo does not store a real account id or balance.
