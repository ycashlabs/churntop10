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

## Current prod versions (v3, 13 November 2026)

Live Worker version: `26e737de-8705-43b4-9833-d60e57a90f8e` (merge `f53af3e`, script SHA-256 `03951ba4647c45225bc59edaf378a0dfb278bce52231c57a6628c24f447ac3cb`).

Previous Worker version (v1 app on `main` `c6aaf80`, the version to point 100% at for a code rollback): `33f9e0ce-c4c3-4ee8-bf5e-93839d7f9097`. A code rollback does not undo D1 migrations `0002_v2.sql` and `0003_v3.sql`. The old Worker can keep running against the extra tables and columns; the new Worker cannot run against a restored v1 schema.

Pre-migration Time Travel bookmark for D1 `churntop10-prod` (`b2e4f00d-c7a2-41a6-a75f-12a3043ca20e`): `0000008c-00000000-00005122-058b292ec81c213fef725a24ea5b3e74`. Restore only if you also intend to undo the v3 schema and any rows written after 6:59 AM CST on 13 November 2026 (America/Chicago):

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/f59b2545f5783d93b378006f3eb10bb4/d1/database/b2e4f00d-c7a2-41a6-a75f-12a3043ca20e/time_travel/restore?bookmark=0000008c-00000000-00005122-058b292ec81c213fef725a24ea5b3e74" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```
