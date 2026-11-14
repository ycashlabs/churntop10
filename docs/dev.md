# Dev, as deployed

Deployed from `cursor/churntop10-app-b73d`. Prod is separate; see `docs/prod.md`. Nothing in this note is a secret value.

- Worker `churntop10-dev` at https://desk-dev.churncapital.com (canonical Workers Custom Domain on zone `churncapital.com`). https://top10-dev.ycashlabs.com stays attached during the move. View Only. `ACCESS_ENFORCE` is `1`. `ALLOW_LIVE_TRADING` is `0`. Cron is `*/5 * * * *`. `HOSTNAME` is `desk-dev.churncapital.com`. `ALLOWED_HOSTS` is `top10-dev.ycashlabs.com`. `ZONE` stays `ycashlabs.com`.
- D1 `churntop10-dev`, id `7f0a12d3-f689-4a86-b30d-b349bdd77736`. `migrations/0001_init.sql` was applied with the D1 query API, so `d1_migrations` does not yet list it. See `DEPLOY.md` before the first remote `wrangler d1 migrations apply`.
- R2 bucket `churntop10-audit-dev`.
- Access application `Churn Top 10 dev` on team `dawn-rice-07a4`. Audience `3826fb9770402e73a472a3e3519bcdbd4cdcbf79cc695141d3ffb9cdd8a2cdaa`. Allow policy is the owner only: `tom2258@gmail.com`.
- Secret `TOKEN_KEY` is set on the Worker. The value is not in the repo.

## Current dev (desk-dev hostname, 14 November 2026, America/Chicago)

Canonical URL https://desk-dev.churncapital.com. The previous URL https://top10-dev.ycashlabs.com remains a Workers Custom Domain on the same Worker. Access application `Churn Top 10 dev` (`d0a5f257-6f03-4bfc-b8a4-d104a7180e06`) protects both names, owner-only, same audience as before. Passkeys are tied to the request hostname, so register a new passkey on desk-dev and re-add the authenticator app there. See [HANDOVER.md](HANDOVER.md) for the Worker version after this upload. **Not on prod.** Prod stays at https://top10.ycashlabs.com until an explicit go-ahead.

The sections below are earlier snapshots and still mention the old hostname.

## Connecting Robinhood

Robinhood's shared public client accepts only loopback redirects, and dynamic registration does not add a web callback to its allow-list (see `docs/contracts/robinhood/oauth/README.md`). So the app sends `redirect_uri=http://127.0.0.1:47621/callback`:

1. Settings → Connect Robinhood (passkey), then Open Robinhood sign-in and approve.
2. The browser lands on `http://127.0.0.1:47621/callback?code=…&state=…&iss=…`, which does not load. That is expected.
3. Paste that whole address into Settings and select Finish connecting. The Worker checks `state` (single use, 10 minutes) and `iss`, then exchanges the code with the saved PKCE verifier.


## Current dev (live holdings sync, 13 November 2026)

Dev Worker `churntop10-dev` at https://top10-dev.ycashlabs.com. UI is embedded in the Worker script (no `assets` binding). `ALLOW_LIVE_TRADING` is `0`. `ACCESS_ENFORCE` is `1`. `TOKEN_KEY` is kept across uploads with `keep_bindings: ["secret_text"]`. Cron is `*/5 * * * *`.

D1 `churntop10-dev` (`7f0a12d3-f689-4a86-b30d-b349bdd77736`) now has `d1_migrations` rows for `0001_init.sql` through `0004_live_sync.sql`. `0004` adds portable `source` columns on `positions` and `trades`. Dev has no Robinhood token, so holdings sync uses the recorded `get_equity_positions_tsll.json` fixture. Prod must never use that fixture (`ENVIRONMENT=prod` returns no holdings when disconnected).

## Current dev (signal views and live fire guard, 13 November 2026, America/Chicago)

Worker `churntop10-dev` at https://top10-dev.ycashlabs.com. Version **`08c1011c-3a90-4ab4-8087-e987ff4aeefa`**, uploaded **8:40:47 AM CST**. Script SHA-256 `6dd41fea3abd35465523b2afe998cd7961b06a0376e06adbcb0459a0270b6595`. Etag `9c911caba17bf280c254e7d737874fc5c50a4157dee98da59e0ad6138682de92`. UI is embedded (no `assets` binding). `ALLOW_LIVE_TRADING` is `0`. `ACCESS_ENFORCE` is `1`. `TOKEN_KEY` kept with `keep_bindings: ["secret_text"]`. Cron is `*/5 * * * *`. Rollback: `4798f5d0-8006-4eb9-a84f-6610c33c4968`. This is the PR #10 Worker. **Not on prod.**

D1 `churntop10-dev` (`7f0a12d3-f689-4a86-b30d-b349bdd77736`) now has `d1_migrations` through **`0006_trade_signals_name_reason.sql`** (applied 8:39:59 AM CST). Pre-`0006` bookmark: `000000ae-00000000-00005122-254240f2ae5bdf4d41da1bcdc73d2c12`. Pre-`0005` bookmark: `000000a8-00000000-00005122-26fed85f6a2eb2ec034474f8838928a3`. PRAGMA: `trade_id, signal_id, value, passed, threshold, name, reason`. Dev has no Robinhood token, so holdings sync still uses the recorded TSLL fixture. Prod must never use that fixture. **Do not apply `0006` on prod without go-ahead.**

See [HANDOVER.md](HANDOVER.md) and [TEST-RESULTS.md](TEST-RESULTS.md).

The section below is the earlier trade_signals (PR #9) dev snapshot.

## Previous dev (trade_signals, 13 November 2026, America/Chicago)

Worker `churntop10-dev` at https://top10-dev.ycashlabs.com. Version **`4798f5d0-8006-4eb9-a84f-6610c33c4968`**, uploaded **8:13:26 AM CST**. Script SHA-256 `496fbad92fdf9a5f8ec78b7348f882638e1cd0513e941b330a80f0bdf821fca9`. Etag `fc98d05143b06d67b4e9d13088ae2eeb8a0476e1b5df30d8f3a555879cb0c055`. UI is embedded (no `assets` binding). `ALLOW_LIVE_TRADING` is `0`. `ACCESS_ENFORCE` is `1`. `TOKEN_KEY` kept with `keep_bindings: ["secret_text"]`. Cron is `*/5 * * * *`. Previous version: `20320715-4871-4cf7-8934-5ddf192867f6`.

D1 `churntop10-dev` (`7f0a12d3-f689-4a86-b30d-b349bdd77736`) had `d1_migrations` through `0005_trade_signals_threshold.sql` (applied 8:12:02 AM CST). Pre-`0005` bookmark: `000000a8-00000000-00005122-26fed85f6a2eb2ec034474f8838928a3`. Dev has no Robinhood token, so holdings sync still uses the recorded TSLL fixture. Prod must never use that fixture.
