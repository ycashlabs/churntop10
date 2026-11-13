# Deploy

The product contract is [docs/spec-v2.md](docs/spec-v2.md) (including the v3 section). The storage interface and long-term failover plan are in [docs/storage.md](docs/storage.md).

This repository does not create Cloudflare resources and does not deploy. `npm run build` writes `dist/index.js`, an ES module Worker (`AccountTrader` is a named export, the default export is `fetch` + `scheduled`) with the built HTML, JS, and CSS embedded. The Worker serves that UI itself, so a deploy does not need a successful Workers assets-upload JWT. `dist/assets/` is still produced for local `wrangler dev` and as a fallback.

Account `f59b2545f5783d93b378006f3eb10bb4`, zone `ycashlabs.com`.

| | dev | prod |
| --- | --- | --- |
| Worker | `churntop10-dev` | `churntop10-prod` |
| Hostname | `top10-dev.ycashlabs.com` | `top10.ycashlabs.com` |
| D1 name | `churntop10-dev` | `churntop10-prod` |
| R2 bucket | `churntop10-audit-dev` | `churntop10-audit-prod` |

Dev D1 `churntop10-dev` is `7f0a12d3-f689-4a86-b30d-b349bdd77736`, in the top-level block and in `env.dev`. Prod D1 `churntop10-prod` is `b2e4f00d-c7a2-41a6-a75f-12a3043ca20e`, in `env.prod`. Prod is deployed; see `docs/prod.md`. Local `wrangler dev` keeps using a local sqlite file. It does not talk to the remote database unless you pass `--remote`.

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

Apply the numbered files in `migrations/` in order (`0001_init.sql`, `0002_v2.sql`, `0003_v3.sql`) once per database before the first request. A database that already has v2 only needs `0003_v3.sql` plus the app’s data backfill (see [docs/storage.md](docs/storage.md)). Fresh apply:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/f59b2545f5783d93b378006f3eb10bb4/d1/database/$DATABASE_ID/query" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "content-type: application/json" \
  -d @<(python3 -c 'import json; print(json.dumps({"sql": open("migrations/0001_init.sql").read()}))')
```

That query API does not write Wrangler's `d1_migrations` table. Dev was applied that way. Reconcile it before the first `npx wrangler d1 migrations apply DB --remote --env dev`, or Wrangler will run `0001_init.sql` again and fail because the tables already exist.

Wrangler 4.20 records a migration by filename. Create its bookkeeping table if it is missing, then insert the row it would have written:

```sql
CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT INTO d1_migrations (name) VALUES ('0001_init.sql');
```

Send that through the same D1 query API, against database `7f0a12d3-f689-4a86-b30d-b349bdd77736`. After the row exists, `wrangler d1 migrations apply DB --remote --env dev` reports that nothing is pending.

The other option is to make `migrations/0001_init.sql` idempotent first: change each `CREATE TABLE` to `CREATE TABLE IF NOT EXISTS`. A later remote apply then succeeds on the existing tables and inserts the `0001_init.sql` row itself. Do that before the apply. Do not do both a hand-inserted row and an edit that you also expect Wrangler to execute. One path is enough.

Dev is served by a Workers Custom Domain: `top10-dev.ycashlabs.com` points at Worker `churntop10-dev`. There is no zone route for that hostname. `env.dev` records it as `{ "pattern": "top10-dev.ycashlabs.com", "custom_domain": true }`. Do not also add a zone route for it.

Prod is served the same way: `top10.ycashlabs.com` is a Workers Custom Domain on Worker `churntop10-prod`. `env.prod` records it as `{ "pattern": "top10.ycashlabs.com", "custom_domain": true }`. Do not add a zone route for it. A zone route would only be needed for a different design:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/workers/routes" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "content-type: application/json" \
  -d '{"pattern":"top10.ycashlabs.com/*","script":"churntop10-prod"}'
```

## Bindings

The Worker reads these names. Dev values are shown. Prod swaps the names in the table above and sets `ENVIRONMENT` to `prod`, `HOSTNAME` to `top10.ycashlabs.com`, and `ACCESS_ENFORCE` to `1`.

| Binding | API `type` | Name | Value |
| --- | --- | --- | --- |
| Static assets | `assets` | `ASSETS` | completion JWT from the asset upload, plus config below |
| D1 | `d1` | `DB` | dev `id` = `7f0a12d3-f689-4a86-b30d-b349bdd77736` |
| R2 audit log | `r2_bucket` | `AUDIT` | `bucket_name` = `churntop10-audit-dev` |
| Durable Object | `durable_object_namespace` | `TRADER` | `class_name` = `AccountTrader` |
| Var | `plain_text` | `ENVIRONMENT` | `dev` |
| Var | `plain_text` | `ALLOW_LIVE_TRADING` | `0` |
| Var | `plain_text` | `ACCESS_ENFORCE` | `1` on a deployed Worker, `0` only for local `wrangler dev` |
| Var | `plain_text` | `ACCESS_TEAM_DOMAIN` | dev `dawn-rice-07a4` (no `.cloudflareaccess.com` suffix) |
| Var | `plain_text` | `ACCESS_AUD` | dev `3826fb9770402e73a472a3e3519bcdbd4cdcbf79cc695141d3ffb9cdd8a2cdaa` |
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
    { "type": "d1", "name": "DB", "id": "7f0a12d3-f689-4a86-b30d-b349bdd77736" },
    { "type": "r2_bucket", "name": "AUDIT", "bucket_name": "churntop10-audit-dev" },
    { "type": "durable_object_namespace", "name": "TRADER", "class_name": "AccountTrader" },
    { "type": "plain_text", "name": "ENVIRONMENT", "text": "dev" },
    { "type": "plain_text", "name": "ALLOW_LIVE_TRADING", "text": "0" },
    { "type": "plain_text", "name": "ACCESS_ENFORCE", "text": "1" },
    { "type": "plain_text", "name": "ACCESS_TEAM_DOMAIN", "text": "dawn-rice-07a4" },
    { "type": "plain_text", "name": "ACCESS_AUD", "text": "3826fb9770402e73a472a3e3519bcdbd4cdcbf79cc695141d3ffb9cdd8a2cdaa" },
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

Dev is already deployed with `ACCESS_ENFORCE` `1`, team `dawn-rice-07a4`, and the audience above. `ALLOW_LIVE_TRADING` stays `"0"`. What is live is listed in `docs/dev.md`. Prod has its own Access application and audience, and `ACCESS_ENFORCE` is `1` there too. See `docs/ACCESS.md` and `docs/prod.md`.

## Local

```bash
cp .dev.vars.example .dev.vars
# put a real TOKEN_KEY in .dev.vars
npm run dev
```

`npm run dev` builds the client, applies `migrations/0001_init.sql` to the local D1 database, and starts `wrangler dev` on port 8787 using the top-level config. That config keeps `ACCESS_ENFORCE` at `0` and leaves the Access team and audience empty, so a passkey works on `http://localhost:8787`. The top-level `database_id` matches dev so the name is real. The local command still uses local sqlite. It still uses the simulator and the recorded quote book. `env.dev` is the deployed Worker, not this local process.

## Prod v3 upload (reproducible)

Prod is on the v3 build from `main` `f53af3e`. The upload used the same method as the verified dev v3 deploy: `npm run build`, then a Workers script `PUT` with the UI embedded in `dist/index.js` and **no** `assets` binding. `keep_bindings` includes `secret_text` so `TOKEN_KEY` is not dropped. `ALLOW_LIVE_TRADING` stays `"0"`. Durable Object tag `v1` is not sent again.

Before that upload, a Time Travel bookmark was taken for prod D1, then `migrations/0002_v2.sql` and `migrations/0003_v3.sql` were applied with the D1 query API (one statement at a time, same split as dev) and recorded in `d1_migrations`. The application backfill is not a SQL file; `prepareStorage` runs `migrateV2Data` and `seedDraftRules` on the next cron tick or the first authenticated request. Current ids, the bookmark, and the exact bindings are in [docs/prod.md](docs/prod.md). Rollback is in [ROLLBACK.md](ROLLBACK.md).

