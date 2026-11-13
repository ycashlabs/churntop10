# Rollback

A Worker rollback restores the previous code version. It does not restore D1 rows, R2 audit objects, or Durable Object storage. Orders the simulator already filled stay filled. Robinhood orders, if a future deploy ever sent any, stay at Robinhood. This build does not call `cancel_equity_order`.

## Before you roll back

1. Open Settings and press the kill switch. That forces View Only, blocks new buys, and cancels working simulated entries. It does not call Robinhood.
2. Confirm `ALLOW_LIVE_TRADING` is `0` on the script you are about to serve.

## Code

With Wrangler, after you have deployed at least two versions:

```bash
npx wrangler rollback --name churntop10-dev
npx wrangler rollback --name churntop10-prod
```

With the API, list deployments, then point 100% of traffic at the previous version id:

```bash
curl "https://api.cloudflare.com/client/v4/accounts/f59b2545f5783d93b378006f3eb10bb4/workers/scripts/churntop10-prod/deployments" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"

curl -X POST "https://api.cloudflare.com/client/v4/accounts/f59b2545f5783d93b378006f3eb10bb4/workers/scripts/churntop10-prod/deployments" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "content-type: application/json" \
  -d '{"strategy":"percentage","versions":[{"percentage":100,"version_id":"<previous version id>"}]}'
```

Do not roll back across the `v1` Durable Object migration. A version from before `AccountTrader` existed will not bind `TRADER`. Ship a forward fix instead.

## Data

To stop the simulator without deleting the audit log, the kill switch is enough. Deleting the D1 database or the R2 bucket is a separate choice and throws away the local book and the audit index. There is no automated restore for those.

## Config mistakes

A bad `ACCESS_AUD` or `TOKEN_KEY` is a new version, not a code bug. Put the previous secret back with the secrets API, or put the previous plain-text vars back with another script upload. Rolling the code back does not restore a secret you overwrote.
