# Prod, as deployed

Living snapshot of ids and pending decisions: [HANDOVER.md](HANDOVER.md). Nothing in this note is a secret value. Prod shares no data or credentials with dev.

## Current prod (PR #9, 13 November 2026, America/Chicago)

- Merge of PR #9: `8aa3502d210597d03d499a91bd14e7253f3a196c` (CI on `main` run 52 success at 8:26:45 AM CST). Worker `churntop10-prod` at https://top10.ycashlabs.com (Workers Custom Domain). Version **`286f9178-e8f6-407f-b7c7-ab5cf6901144`**, uploaded **8:27:02 AM CST**. Script SHA-256 `496fbad92fdf9a5f8ec78b7348f882638e1cd0513e941b330a80f0bdf821fca9` (same bundle as the then-current dev Worker). Cloudflare etag `fc98d05143b06d67b4e9d13088ae2eeb8a0476e1b5df30d8f3a555879cb0c055`. Embedded UI, no `assets`, `TOKEN_KEY` kept, `ALLOW_LIVE_TRADING` is `"0"`, `ENVIRONMENT` is `prod`, `ACCESS_ENFORCE` is `1`. Cron is still `*/5 * * * *` (unchanged).
- D1 `churntop10-prod` (`b2e4f00d-c7a2-41a6-a75f-12a3043ca20e`) has `0001_init.sql` through **`0005_trade_signals_threshold.sql`**. `0005` was applied and recorded at **8:26:53 AM CST** / 14:26:53 UTC. Pre-`0005` Time Travel bookmark (taken immediately before the ALTER): `0000009e-00000421-00005122-8bffaec3864d5a10a2b2344a5fcc94b5`. Pre-`0004` bookmark remains `00000097-00000000-00005122-dc89ae249ceaced2a400bf9f08d1623d`. PRAGMA on `trade_signals` is `trade_id, signal_id, value, passed, threshold`.
- Rollback target for this upload remains the PR #8 Worker **`1259682e-103a-491f-a6dd-9ab2b69f589a`** (uploaded 7:50:44 AM CST, SHA-256 `c53d6d26371c89ee6f429fc3f24cfd2781a2d0d3cc2727128891de9730692576`).
- Unauthenticated GET `/` and `/api/health` still return HTTP 302 to `https://dawn-rice-07a4.cloudflareaccess.com/cdn-cgi/access/login/top10.ycashlabs.com` (audience kid `b05d3bc5…`).
- The 8:30 AM CST cron ran on the new Worker at **8:30:59 AM CST** (`sim_cycle`, session `regular`, `quoteSource` `robinhood`, `events` 1). That event was `broker_stop_attached` for the open NVDA sim position at stop **167.86** (regular open; the synthetic off-hours stop converted to a broker-stop record). No new sim fills after the 8:27:02 AM CST upload, so prod has not yet observed a post-upload fill writing `trade_signals`. Local wrangler already confirmed the same bundle does.
- Existing NVDA sim trades still have **0** `trade_signals` rows: starter `3989afa2-7976-4b28-b703-4c5e0352a9a6` (1 @ 169.27 at 7:55:30 AM CST) and a later add `5aa49ca9-f1c4-4622-aef6-8e1f8f4a0359` (4 @ 169.63 at 8:00:30 AM CST). A backfill dry-run (`apply=false`) planned 3 rows for `3989afa2-…` and 3 more for `5aa49ca9-…`; **nothing was inserted**. Applying the backfill waits for a second explicit OK. Imported live TSLL is unchanged. See HANDOVER for ids and the planned row values.
- Access application `Churn Top 10 prod` (`8f553625-0283-41e0-8a63-c43789e8c3a5`), team `dawn-rice-07a4`, audience `b05d3bc57044f2fd02b7e9666d7e61a18e236784bdcbda9ea8322b9d6fe14517`. Owner only: `tom2258@gmail.com`. No bypass, no service token.

The section below is the earlier PR #8 / v3 verification. Prefer the current section and HANDOVER when they disagree.

Deployed from `main` at merge commit `f53af3ec0ab03a9965ae3c547923037e37a60c95` (PR #7, head `8db2a5f3586def16320920fa1304e2324acdf3fb`). Nothing in this note is a secret value. Prod shares no data or credentials with dev.

- Worker `churntop10-prod` at https://top10.ycashlabs.com. Workers Custom Domain, not a zone route. View Only. `ACCESS_ENFORCE` is `1`. `ALLOW_LIVE_TRADING` is `0`. Cron is `*/5 * * * *`.
- This v3 upload: Worker version `26e737de-8705-43b4-9833-d60e57a90f8e`, script SHA-256 `03951ba4647c45225bc59edaf378a0dfb278bce52231c57a6628c24f447ac3cb` (same bundle as the verified dev v3 build), Cloudflare etag `995a53bfa44f88b204447c6212f632780762f374afe7d260236daa95b6530b4c`, `modified_on` 2026-11-13T12:59:37.758402Z (6:59:37 AM CST, America/Chicago). The HTML, JS, and CSS are embedded in the Worker. There is no `ASSETS` binding.
- D1 `churntop10-prod`, id `b2e4f00d-c7a2-41a6-a75f-12a3043ca20e`. `0001_init.sql`, `0002_v2.sql`, and `0003_v3.sql` are recorded in `d1_migrations`. The v2-to-v3 data backfill (`migrateV2Data`) and draft-rule seed run inside the Worker on `prepareStorage` (the next cron tick or the first authenticated request). Prod had no v2 rules or simulator positions to copy. Draft rules are seeded as Experimenting only.
- Pre-migration Time Travel bookmark (v1 schema, only `0001_init.sql` applied): `0000008c-00000000-00005122-058b292ec81c213fef725a24ea5b3e74`. Official SQL export was not used; it takes the database offline while it runs.
- R2 bucket `churntop10-audit-prod`.
- Access application `Churn Top 10 prod` (id `8f553625-0283-41e0-8a63-c43789e8c3a5`) on team `dawn-rice-07a4`. Audience `b05d3bc57044f2fd02b7e9666d7e61a18e236784bdcbda9ea8322b9d6fe14517`. Allow policy is the owner only: `tom2258@gmail.com`. No bypass, no service token.
- Secret `TOKEN_KEY` is set on the Worker and was preserved with `keep_bindings: ["secret_text"]`. It is its own key, not dev's. The value is not in the repo.


## Verification (13 November 2026, America/Chicago)

- An unauthenticated request to https://top10.ycashlabs.com (and `/api/health`) returns HTTP 302 to the team Access login `https://dawn-rice-07a4.cloudflareaccess.com/cdn-cgi/access/login/top10.ycashlabs.com`, audience `kid` matching the prod `ACCESS_AUD`.
- The live script SHA-256 matches the local `dist/index.js` build from `f53af3e` (`03951ba4647c45225bc59edaf378a0dfb278bce52231c57a6628c24f447ac3cb`) and includes the v3 UI strings (Trading capital, Sell All Positions, Review, Experimenting).
- Bindings after upload: `ALLOW_LIVE_TRADING` is `0`, `ACCESS_ENFORCE` is `1`, `ENVIRONMENT` is `prod`, `TOKEN_KEY` is still present, no `ASSETS` binding. Cron is still `*/5 * * * *`. The custom domain still points at `churntop10-prod`. Access stays owner-only (`tom2258@gmail.com`); no bypass policy was added.
- The 7:05 AM CST cron ran the new Worker: `prepareStorage` backfilled `trading_capital` from the existing `cash` value (10000) and seeded 10 signals plus 6 Experimenting draft rules (0 Proven). `mode` remains `view_only`.
- Cron `tickSimulator` only writes a `sim_cycle` audit when there is already an open simulator position. Prod has none, so that tick correctly returned after the seed. The simulator quote path is the same `quoteBook()` used by the account cycle: if Robinhood returns live quotes, `quoteSource` is `robinhood`. Prod still has a stored Robinhood sign-in (`rh_tokens` row count 1, no token values read). The last account-cycle audits before the upload (through 6:55:28 AM CST) all recorded `quoteSource` `robinhood` in session `extended`.

## How this upload was done

`npm run build` writes `dist/index.js` with the UI embedded. The script is uploaded with the Workers API (`PUT /accounts/f59b2545f5783d93b378006f3eb10bb4/workers/scripts/churntop10-prod`) as `multipart/form-data`: metadata JSON plus the `index.js` module. Do not attach an `assets` binding or a new Durable Object migration (`AccountTrader` already exists). Keep these bindings:

| Binding | API `type` | Value |
| --- | --- | --- |
| `DB` | `d1` | id `b2e4f00d-c7a2-41a6-a75f-12a3043ca20e` |
| `AUDIT` | `r2_bucket` | `churntop10-audit-prod` |
| `TRADER` | `durable_object_namespace` | class `AccountTrader` |
| `ENVIRONMENT` | `plain_text` | `prod` |
| `ALLOW_LIVE_TRADING` | `plain_text` | `0` |
| `ACCESS_ENFORCE` | `plain_text` | `1` |
| `ACCESS_TEAM_DOMAIN` | `plain_text` | `dawn-rice-07a4` |
| `ACCESS_AUD` | `plain_text` | `b05d3bc57044f2fd02b7e9666d7e61a18e236784bdcbda9ea8322b9d6fe14517` |
| `OWNER_EMAIL` | `plain_text` | `tom2258@gmail.com` |
| `ZONE` | `plain_text` | `ycashlabs.com` |
| `HOSTNAME` | `plain_text` | `top10.ycashlabs.com` |
| `TOKEN_KEY` | `secret_text` | already set; pass `keep_bindings: ["secret_text"]` so it is not dropped |

`ALLOW_LIVE_TRADING` stays `"0"`. Turning the gate on is a later, separate decision.

Prod changes only with the owner's explicit go-ahead. Connecting Robinhood works as on dev; see `docs/dev.md`. The previous Worker version, before this v3 upload, is `33f9e0ce-c4c3-4ee8-bf5e-93839d7f9097` (from `main` at `c6aaf80`). See [ROLLBACK.md](../ROLLBACK.md).
