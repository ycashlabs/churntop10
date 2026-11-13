# Prod, as deployed

Deployed from `main` at merge commit `7167f8c3bb7d6a90885f0e32916e86aa24a6eb55` (PR #1). Nothing in this note is a secret value. Prod shares no data or credentials with dev.

- Worker `churntop10-prod` at https://top10.ycashlabs.com. Workers Custom Domain, not a zone route. View Only. `ACCESS_ENFORCE` is `1`. `ALLOW_LIVE_TRADING` is `0`. Cron is `*/5 * * * *`.
- D1 `churntop10-prod`, id `b2e4f00d-c7a2-41a6-a75f-12a3043ca20e`. `0001_init.sql` is recorded in `d1_migrations`, so `wrangler d1 migrations apply DB --remote --env prod` only runs new files.
- R2 bucket `churntop10-audit-prod`.
- Access application `Churn Top 10 prod` on team `dawn-rice-07a4`. Audience `b05d3bc57044f2fd02b7e9666d7e61a18e236784bdcbda9ea8322b9d6fe14517`. Allow policy is the owner only: `tom2258@gmail.com`. No bypass, no service token.
- Secret `TOKEN_KEY` is set on the Worker. It is its own key, not dev's. The value is not in the repo.

Prod changes only with the owner's explicit go-ahead. Turning on live trading is a separate decision. Connecting Robinhood works as on dev; see `docs/dev.md`.
