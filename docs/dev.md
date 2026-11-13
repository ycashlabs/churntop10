# Dev, as deployed

Deployed from `cursor/churntop10-app-b73d`. Prod is separate; see `docs/prod.md`. Nothing in this note is a secret value.

- Worker `churntop10-dev` at https://top10-dev.ycashlabs.com. Workers Custom Domain, not a zone route. View Only. `ACCESS_ENFORCE` is `1`. `ALLOW_LIVE_TRADING` is `0`. Cron is `*/5 * * * *`.
- D1 `churntop10-dev`, id `7f0a12d3-f689-4a86-b30d-b349bdd77736`. `migrations/0001_init.sql` was applied with the D1 query API, so `d1_migrations` does not yet list it. See `DEPLOY.md` before the first remote `wrangler d1 migrations apply`.
- R2 bucket `churntop10-audit-dev`.
- Access application `Churn Top 10 dev` on team `dawn-rice-07a4`. Audience `3826fb9770402e73a472a3e3519bcdbd4cdcbf79cc695141d3ffb9cdd8a2cdaa`. Allow policy is the owner only: `tom2258@gmail.com`.
- Secret `TOKEN_KEY` is set on the Worker. The value is not in the repo.

## Connecting Robinhood

Robinhood's shared public client accepts only loopback redirects, and dynamic registration does not add a web callback to its allow-list (see `docs/contracts/robinhood/oauth/README.md`). So the app sends `redirect_uri=http://127.0.0.1:47621/callback`:

1. Settings → Connect Robinhood (passkey), then Open Robinhood sign-in and approve.
2. The browser lands on `http://127.0.0.1:47621/callback?code=…&state=…&iss=…`, which does not load. That is expected.
3. Paste that whole address into Settings and select Finish connecting. The Worker checks `state` (single use, 10 minutes) and `iss`, then exchanges the code with the saved PKCE verifier.


## Current dev (live holdings sync, 13 November 2026)

Dev Worker `churntop10-dev` at https://top10-dev.ycashlabs.com. UI is embedded in the Worker script (no `assets` binding). `ALLOW_LIVE_TRADING` is `0`. `ACCESS_ENFORCE` is `1`. `TOKEN_KEY` is kept across uploads with `keep_bindings: ["secret_text"]`. Cron is `*/5 * * * *`.

D1 `churntop10-dev` (`7f0a12d3-f689-4a86-b30d-b349bdd77736`) now has `d1_migrations` rows for `0001_init.sql` through `0004_live_sync.sql`. `0004` adds portable `source` columns on `positions` and `trades`. Dev has no Robinhood token, so holdings sync uses the recorded `get_equity_positions_tsll.json` fixture. Prod must never use that fixture (`ENVIRONMENT=prod` returns no holdings when disconnected).

## Current dev (trade_signals, 13 November 2026, America/Chicago)

Worker `churntop10-dev` at https://top10-dev.ycashlabs.com. Version **`4798f5d0-8006-4eb9-a84f-6610c33c4968`**, uploaded **8:13:26 AM CST**. Script SHA-256 `496fbad92fdf9a5f8ec78b7348f882638e1cd0513e941b330a80f0bdf821fca9`. Etag `fc98d05143b06d67b4e9d13088ae2eeb8a0476e1b5df30d8f3a555879cb0c055`. UI is embedded (no `assets` binding). `ALLOW_LIVE_TRADING` is `0`. `ACCESS_ENFORCE` is `1`. `TOKEN_KEY` kept with `keep_bindings: ["secret_text"]`. Cron is `*/5 * * * *`. Previous version: `20320715-4871-4cf7-8934-5ddf192867f6`.

D1 `churntop10-dev` (`7f0a12d3-f689-4a86-b30d-b349bdd77736`) now has `d1_migrations` through `0005_trade_signals_threshold.sql` (applied 8:12:02 AM CST). Pre-`0005` bookmark: `000000a8-00000000-00005122-26fed85f6a2eb2ec034474f8838928a3`. Dev has no Robinhood token, so holdings sync still uses the recorded TSLL fixture. Prod must never use that fixture.

See [HANDOVER.md](HANDOVER.md) and [TEST-RESULTS.md](TEST-RESULTS.md).
