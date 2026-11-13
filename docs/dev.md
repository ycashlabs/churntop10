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
