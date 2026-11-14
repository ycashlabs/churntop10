# Cloudflare Access

The deployed app is one owner: `tom2258@gmail.com`. Access is the front door. The Worker checks the Access JWT again.

## Application

Dev is already in front of Access. The application is `Churn Top 10 dev` (`d0a5f257-6f03-4bfc-b8a4-d104a7180e06`) on team `dawn-rice-07a4`, hostnames `desk-dev.churncapital.com` (canonical) and `top10-dev.ycashlabs.com` (still attached during the move), audience `3826fb9770402e73a472a3e3519bcdbd4cdcbf79cc695141d3ffb9cdd8a2cdaa`. The policy allows `tom2258@gmail.com` only. See `docs/dev.md`.

Prod is in front of its own application: `Churn Top 10 prod` on team `dawn-rice-07a4`, hostnames `desk.churncapital.com` (canonical) and `top10.ycashlabs.com` (fallback), audience `b05d3bc57044f2fd02b7e9666d7e61a18e236784bdcbda9ea8322b9d6fe14517`, same owner-only policy and 1h session as dev. Never reuse one environment's audience in the other.

Session duration can be short. The app has its own passkey session on top.

Policy shape: Include, Emails, `tom2258@gmail.com`. No bypass, no service token, no everyone.

Team identity providers: **One-time PIN** (`9f7436ed-2228-4fa3-863e-da8c93127752`, type `onetimepin`) and the built-in **Cloudflare** account IdP (`8a3b677e-fc9d-4d0d-a8b0-99d9fcd3fa48`, type `cloudflare`). On 13 November 2026 at 1:22 PM CST (America/Chicago), both applications had `allowed_idps` set to those two ids (One-time PIN first) so the Access login page offers email OTP as well as Cloudflare. `auto_redirect_to_identity` is `false` so the picker is not skipped. Policies were not changed. Google is not configured. This is only the Access front door.

The in-app passkey (and the authenticator-app TOTP backup) sit *after* Access and are described in [DESIGN.md](DESIGN.md).

## What the Worker checks

On a deployed Worker, `ACCESS_ENFORCE` is `1`. Each request must carry `Cf-Access-Jwt-Assertion`. The Worker fetches `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, requires RS256, and checks:

- `iss` is `https://<ACCESS_TEAM_DOMAIN>.cloudflareaccess.com`
- `aud` contains `ACCESS_AUD` (the application's audience tag, from the application settings)
- `exp` is in the future
- `email` is `tom2258@gmail.com`

If `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is empty while enforcement is on, the Worker returns 503 instead of skipping the check.

Local `wrangler dev` uses the top-level config, where `ACCESS_ENFORCE` is `0`, so you can register a passkey on localhost. Do not deploy that top-level value. `env.dev` and `env.prod` both set enforcement to `1`.

## After Access

Access does not replace the app session. After Access, sign in with a passkey, or with an authenticator-app code once TOTP is enrolled. Switching to Live, editing the Top 10, changing caps, and connecting Robinhood ask for the passkey again, or an authenticator code if one is set up, and that step-up lasts 5 minutes. Sell All Positions does not ask, because it only makes the app stop. A recovery session still cannot use the app.
