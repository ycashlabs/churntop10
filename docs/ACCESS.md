# Cloudflare Access

The deployed app is one owner: `tom2258@gmail.com`. Access is the front door. The Worker checks the Access JWT again.

## Application

Dev is already in front of Access. The application is `Churn Top 10 dev` on team `dawn-rice-07a4`, hostname `top10-dev.ycashlabs.com`, audience `3826fb9770402e73a472a3e3519bcdbd4cdcbf79cc695141d3ffb9cdd8a2cdaa`. The policy allows `tom2258@gmail.com` only. See `docs/dev.md`.

Prod (`top10.ycashlabs.com`) is not created. When it is, give it its own Access application and its own audience. Do not reuse the dev audience.

Session duration can be short. The app has its own passkey session on top.

Policy shape: Include, Emails, `tom2258@gmail.com`. No bypass, no service token, no everyone.

Identity is whatever you already use to prove that mailbox. An email one-time pin is enough if you do not want a second IdP.

## What the Worker checks

On a deployed Worker, `ACCESS_ENFORCE` is `1`. Each request must carry `Cf-Access-Jwt-Assertion`. The Worker fetches `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, requires RS256, and checks:

- `iss` is `https://<ACCESS_TEAM_DOMAIN>.cloudflareaccess.com`
- `aud` contains `ACCESS_AUD` (the application's audience tag, from the application settings)
- `exp` is in the future
- `email` is `tom2258@gmail.com`

If `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is empty while enforcement is on, the Worker returns 503 instead of skipping the check.

Local `wrangler dev` uses the top-level config, where `ACCESS_ENFORCE` is `0`, so you can register a passkey on localhost. Do not deploy that top-level value. `env.dev` and `env.prod` both set enforcement to `1`.

## After Access

Access does not replace the passkey. The passkey is the app session. Switching to Live, editing the Top 10, changing caps, and connecting Robinhood ask for the passkey again, and that step-up lasts 5 minutes. The kill switch does not ask, because it only makes the app stop.
