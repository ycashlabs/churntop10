# Deploy

This repository does not create Cloudflare resources and does not deploy. `npm run build` writes the two artifacts you upload:

- `dist/index.js` — ES module Worker (`AccountTrader` is a named export, the default export is `fetch` + `scheduled`)
- `dist/assets/` — static files for the assets binding

Account `f59b2545f5783d93b378006f3eb10bb4`, zone `ycashlabs.com`.

| | dev | prod |
| --- | --- | --- |
| Worker | `churntop10-dev` | `churntop10-prod` |
| Hostname | `top10-dev.ycashlabs.com` | `top10.ycashlabs.com` |
| D1 name | `churntop10-dev` | `churntop10-prod` |
| R2 bucket | `churntop10-audit-dev` | `churntop10-audit-prod` |

`wrangler.jsonc` already has those names. The `database_id` values `00000000-0000-0000-0000-000000000001` (dev) and `00000000-0000-0000-0000-000000000002` (prod) are stand-ins. Replace each one with the `uuid` returned when you create that database, in both the top-level block and the matching `env` block, before any remote command. Local `wrangler dev` does not use the remote id.

## Create the resources

Use an API token that can edit Workers, D1, and R2. Do not put the token in the repo.

```bash
# D1
curl -X POST "https://api.cloudflare.com/client/v4/accounts/f59b2545f5783d93b378006f3eb10bb4/d1/database" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "content-type: application/json" \
  -d '{"name":"churntop10-dev"}'
# repeat with "churntop10-prod"

# R2
curl -X POST "https://api.cloudflare.com/client/v4/accounts/f59b2545f5783d93b378006f3eb10bb4/r2/buckets" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "content-type: application/json" \
  -d '{"name":"churntop10-audit-dev"}'
# repeat with "churntop10-audit-prod"
```

Apply `migrations/0001_init.sql` once per database before the first request:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/f59b2545f5783d93b378006f3eb10bb4/d1/database/$DATABASE_ID/query" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "content-type: application/json" \
  -d @<(python3 -c 'import json; print(json.dumps({"sql": open("migrations/0001_init.sql").read()}))')
```

Look up the zone id for `ycashlabs.com`, then attach the route after the Worker exists:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/workers/routes" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "content-type: application/json" \
  -d '{"pattern":"top10-dev.ycashlabs.com/*","script":"churntop10-dev"}'
```

Prod pattern is `top10.ycashlabs.com/*` and script `churntop10-prod`.

## Bindings

The Worker reads these names. Dev values are shown. Prod swaps the names in the table above and sets `ENVIRONMENT` to `prod`, `HOSTNAME` to `top10.ycashlabs.com`, and `ACCESS_ENFORCE` to `1`.

| Binding | API `type` | Name | Value |
| --- | --- | --- | --- |
| Static assets | `assets` | `ASSETS` | completion JWT from the asset upload, plus config below |
| D1 | `d1` | `DB` | `id` = the database uuid you just created |
| R2 audit log | `r2_bucket` | `AUDIT` | `bucket_name` = `churntop10-audit-dev` |
| Durable Object | `durable_object_namespace` | `TRADER` | `class_name` = `AccountTrader` |
| Var | `plain_text` | `ENVIRONMENT` | `dev` |
| Var | `plain_text` | `ALLOW_LIVE_TRADING` | `0` |
| Var | `plain_text` | `ACCESS_ENFORCE` | `1` on a deployed Worker, `0` only for local `wrangler dev` |
| Var | `plain_text` | `ACCESS_TEAM_DOMAIN` | your Access team subdomain, without `.cloudflareaccess.com` |
| Var | `plain_text` | `ACCESS_AUD` | the Access application audience tag |
| Var | `plain_text` | `OWNER_EMAIL` | `tom2258@gmail.com` |
| Var | `plain_text` | `ZONE` | `ycashlabs.com` |
| Var | `plain_text` | `HOSTNAME` | `top10-dev.ycashlabs.com` |

Secret, not a var. Set it with the secrets API and never in the script upload:

| Secret | Purpose |
| --- | --- |
| `TOKEN_KEY` | base64 of 32 bytes. AES-GCM key for the Robinhood refresh token. `openssl rand -base64 32` |

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/f59b2545f5783d93b378006f3eb10bb4/workers/scripts/churntop10-dev/secrets" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "content-type: application/json" \
  -d '{"name":"TOKEN_KEY","text":"'"$TOKEN_KEY"'","type":"secret_text"}'
```

Putting a secret counts as a deploy of the current script. Set it after the first script upload.

Durable Object migration, sent once with the first upload. Tag `v1`, class `AccountTrader`, SQLite backend. Do not repeat `new_sqlite_classes` on later uploads.

```json
"migrations": { "new_tag": "v1", "new_sqlite_classes": ["AccountTrader"] }
```

The first upload that introduces the class must include the migration. A later upload keeps the binding and omits a new migration tag. See the Durable Object note in the Workers infrastructure docs: a brand-new script sometimes has to be uploaded once before the namespace binding can be referenced. If the first PUT is rejected for that reason, upload once with the migration and without the `TRADER` binding, then PUT again with the binding and without a second migration.

Cron, every 5 minutes, UTC. The handler decides whether the US equity session is open.

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/f59b2545f5783d93b378006f3eb10bb4/workers/scripts/churntop10-dev/schedules" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "content-type: application/json" \
  -d '[{"cron":"*/5 * * * *"}]'
```

Observability in this Wrangler version is logs at sampling rate 1 (`observability.logs`). The pinned Wrangler 4.20 schema has no `traces` field. Turn traces on from the dashboard, or from a script upload, once the account's API accepts `observability.traces.enabled`.

## Upload without Wrangler

`node scripts/print-asset-manifest.mjs` prints the manifest. The hash is the first 32 hex characters of SHA-256 over `base64(file bytes) + file extension`, which is the construction in Cloudflare's direct-upload example. Paths start with `/`.

1. `POST /accounts/f59b2545f5783d93b378006f3eb10bb4/workers/scripts/churntop10-dev/assets-upload-session` with `{ "manifest": { ... } }`.
2. For each bucket in the response, `POST /accounts/f59b2545f5783d93b378006f3eb10bb4/workers/assets/upload?base64=true` with `Authorization: Bearer <upload jwt>` and a JSON object of hash to base64 file contents. A 201 returns the completion JWT. If `buckets` is empty, the first JWT is already the completion token.
3. `PUT /accounts/f59b2545f5783d93b378006f3eb10bb4/workers/scripts/churntop10-dev` as `multipart/form-data`:

```json
{
  "main_module": "index.js",
  "compatibility_date": "2026-11-13",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "jwt": "<completion jwt>",
    "config": { "not_found_handling": "single-page-application", "run_worker_first": true }
  },
  "bindings": [
    { "type": "assets", "name": "ASSETS" },
    { "type": "d1", "name": "DB", "id": "<churntop10-dev uuid>" },
    { "type": "r2_bucket", "name": "AUDIT", "bucket_name": "churntop10-audit-dev" },
    { "type": "durable_object_namespace", "name": "TRADER", "class_name": "AccountTrader" },
    { "type": "plain_text", "name": "ENVIRONMENT", "text": "dev" },
    { "type": "plain_text", "name": "ALLOW_LIVE_TRADING", "text": "0" },
    { "type": "plain_text", "name": "ACCESS_ENFORCE", "text": "1" },
    { "type": "plain_text", "name": "ACCESS_TEAM_DOMAIN", "text": "<team>" },
    { "type": "plain_text", "name": "ACCESS_AUD", "text": "<aud>" },
    { "type": "plain_text", "name": "OWNER_EMAIL", "text": "tom2258@gmail.com" },
    { "type": "plain_text", "name": "ZONE", "text": "ycashlabs.com" },
    { "type": "plain_text", "name": "HOSTNAME", "text": "top10-dev.ycashlabs.com" }
  ],
  "migrations": { "new_tag": "v1", "new_sqlite_classes": ["AccountTrader"] },
  "observability": { "enabled": true, "head_sampling_rate": 1 }
}
```

The module part is `index.js` from `dist/index.js` with type `application/javascript+module`.

`ALLOW_LIVE_TRADING` stays `"0"`. The app starts in View Only. Turning the gate on is a later, separate decision and still does not send `cancel_equity_order`.

Deployed dev and prod both set `ACCESS_ENFORCE` to `1`. Fill in the Access team and audience first, or every request returns 503. See `docs/ACCESS.md`.

## Local

```bash
cp .dev.vars.example .dev.vars
# put a real TOKEN_KEY in .dev.vars
npm run dev
```

`npm run dev` builds the client, applies `migrations/0001_init.sql` to the local D1 database, and starts `wrangler dev` on port 8787 using the top-level config. That config keeps `ACCESS_ENFORCE` at `0` so a passkey works on `http://localhost:8787` without Access in front. It still uses the simulator and the recorded quote book.
