# Handover — Churn Top 10

Living takeover snapshot so a brand-new bot can operate this project. **Update this file in the same PR** whenever wrangler config, migrations, deploy scripts, routines-related docs, env/bindings, current deploy state, open PRs, or pending owner decisions change. CI (`npm run check:design`, run from `npm test`) fails if those ops files change and this file does not.

Nothing in this note is a secret value. Never paste `TOKEN_KEY`, OAuth tokens, or full account numbers here.

Read [DESIGN.md](DESIGN.md) in full first, then this file. Safety rules are in [../AGENTS.md](../AGENTS.md).

Last updated: 13 November 2026, 8:15 AM CST, America/Chicago.

## Owner and approval

- Owner: T.Nguyen / Thomas Nguyen / Churn Capital. Email `tom2258@gmail.com`.
- Repo: https://github.com/ycashlabs/churntop10
- **No real Robinhood orders** (place, cancel, modify) without explicit confirmation of that specific order.
- **`ALLOW_LIVE_TRADING` stays `"0"`** unless the owner clearly says to turn it on.
- **Dev and prod are separate.** Dev should not hold a live Robinhood token.
- **Do not deploy to prod, change prod settings, or apply prod migrations** without explicit go-ahead for that step.
- Mask account numbers to the last four characters everywhere.

## Environments and resource ids

Cloudflare account `f59b2545f5783d93b378006f3eb10bb4`. Zone `ycashlabs.com`. Access team `dawn-rice-07a4`. Cron on both Workers: `*/5 * * * *`. Durable Object `AccountTrader`, idFromName `"owner"`, namespace id (prod) `5c0d19fe80334705a5e6c730b07ecb91`.

| | Dev | Prod |
| --- | --- | --- |
| Worker | `churntop10-dev` | `churntop10-prod` |
| URL | https://top10-dev.ycashlabs.com | https://top10.ycashlabs.com |
| Domain type | Workers Custom Domain (not a zone route) | same |
| D1 name / id | `churntop10-dev` / `7f0a12d3-f689-4a86-b30d-b349bdd77736` | `churntop10-prod` / `b2e4f00d-c7a2-41a6-a75f-12a3043ca20e` |
| R2 | `churntop10-audit-dev` | `churntop10-audit-prod` |
| Access app | `Churn Top 10 dev` (`d0a5f257-6f03-4bfc-b8a4-d104a7180e06`) | `Churn Top 10 prod` (`8f553625-0283-41e0-8a63-c43789e8c3a5`) |
| Access audience | `3826fb9770402e73a472a3e3519bcdbd4cdcbf79cc695141d3ffb9cdd8a2cdaa` | `b05d3bc57044f2fd02b7e9666d7e61a18e236784bdcbda9ea8322b9d6fe14517` |
| Policy | Emails, `tom2258@gmail.com` only. No bypass, no service token, no everyone. | same |
| `ENVIRONMENT` | `dev` | `prod` |
| `ALLOW_LIVE_TRADING` | `0` | `0` |
| `ACCESS_ENFORCE` | `1` (deployed); `0` only in top-level local `wrangler.jsonc` | `1` |
| `TOKEN_KEY` | its own Worker secret | its own Worker secret; never reuse dev’s |
| `HOSTNAME` | `top10-dev.ycashlabs.com` | `top10.ycashlabs.com` |

Local: `npm run dev` on http://localhost:8787, `ACCESS_ENFORCE=0`, `ALLOW_LIVE_TRADING=0`. Never upload the top-level local config.

## Secrets (locations and names only)

| Secret | Where it lives | How to rotate |
| --- | --- | --- |
| `TOKEN_KEY` | Cloudflare Worker `secret_text` on `churntop10-dev` and `churntop10-prod` (separate values). Local: `.dev.vars` (gitignored). Example only in `.dev.vars.example`. | 1. Owner go-ahead for that environment. 2. Disconnect Robinhood first (or stored tokens become unreadable). 3. `openssl rand -base64 32`. 4. PUT the Worker secrets API for that script name. Putting a secret counts as a deploy of the current script. 5. Reconnect Robinhood so new tokens are encrypted with the new key. 6. Subsequent Worker uploads must pass `keep_bindings: ["secret_text"]`. Never copy a key between env. |
| Robinhood access / refresh tokens | Encrypted in D1 `rh_tokens` (`access_ct` / `access_iv` / `refresh_ct` / `refresh_iv`). | Disconnect in Settings (passkey), then Connect again. Do not read or log the ciphertext or plaintext. |
| Dynamic client metadata | D1 `rh_client` (shared public client id, not a private secret). | Recreated on the next connect if needed. |
| Passkeys | D1 `credentials`. | Recovery email flow (15-minute link) then register a new passkey. |
| Session cookies | Hashed in D1 `sessions` (`__Host-session`, 12 hours). | Sign out; they expire. |
| Cloudflare / GitHub credentials used by agents | Not in the repo. Cloudflare MCP or `wrangler` login; `gh` OAuth. | Reconnect the connector. Pushing `.github/workflows/*` needs a GitHub token with the **`workflow` scope**. |

## Reconnect Robinhood OAuth

Redirect is loopback `http://127.0.0.1:47621/callback` only. Do this on **prod**, not dev.

1. Settings → Connect / Reconnect Robinhood (passkey step-up).
2. Open Robinhood, log in, tap Approve.
3. The browser lands on a loopback error page (`This site can't be reached` / `127.0.0.1 refused to connect`). That is expected.
4. Paste the full address bar into Settings. State is single-use, 10 minutes.
5. Disconnect asks confirm: it forgets the saved sign-in and does **not** touch Robinhood orders.

## Current state (13 November 2026, America/Chicago)

### Prod

- Merge of PR #8: `252b479ad6261b6ba50d01412fe750bcd9283177` (branch head `ac81d8fb4e460c331d60ae37e1cf562212815a3f`).
- Worker version **`1259682e-103a-491f-a6dd-9ab2b69f589a`**, uploaded **7:50:44 AM CST**. Script SHA-256 `c53d6d26371c89ee6f429fc3f24cfd2781a2d0d3cc2727128891de9730692576`. Etag `ecac6929b155f0b9bb7fa6d5a25d9e442705ce049bda9b2a8457a88594559efe`. Embedded UI, no `assets`, `TOKEN_KEY` kept, gate `"0"`, `ENVIRONMENT=prod`.
- Previous Worker (rollback): `26e737de-8705-43b4-9833-d60e57a90f8e` (v3 from `f53af3e`).
- Pre-`0004` Time Travel bookmark: `00000097-00000000-00005122-dc89ae249ceaced2a400bf9f08d1623d` (taken immediately before applying `0004`).
- Older pre-`0003` bookmark (v1 schema): `0000008c-00000000-00005122-058b292ec81c213fef725a24ea5b3e74`.
- `d1_migrations`: `0001_init.sql`, `0002_v2.sql`, `0003_v3.sql`, `0004_live_sync.sql` (applied 7:50:00 AM CST / 13:50:00 UTC). **`0005` is not on prod yet.**
- Prod has a stored Robinhood sign-in (`rh_tokens` row present; values not read).
- **TSLL imported live position** (from Account Summary at **7:52:39 AM CST**): id `d12eba10-4965-4b41-9b27-8d00d07e843e`, `mode=live`, `source=imported`, qty **1**, avg cost **11.05**, no buy/sell rule, capital snapshot 999.95. Matching `broker_import` trade and `exit_type=imported` review. Audit `live_import`. This is the real holding (the 1 share filled earlier at about $11.048); do not place or cancel it.
- **NVDA simulator starter** (cron `cycleSimulator` at **7:55:53 AM CST**): position `283f227c-ee68-4cb6-ae5b-444f761ecaae`, qty 1 @ **169.27**, `source=app`, session `extended`, quoteSource `robinhood`. Buy rule First buy on strength v1 (`45cd3ad4-7f7f-4ded-963b-6cb4d78634ba`). Synthetic stop watching at 167.58; take-profit working at 170.96. Trade id `3989afa2-7976-4b28-b703-4c5e0352a9a6`. **No `trade_signals` rows yet** (signals live on the `sim_entry` audit and proposal). Backfill is prepared; prod apply waits for go-ahead.
- Mode `view_only`, Sell All off, Trading capital 10000, sim cash 9830.73. Prod Top 10 includes SPY (not AVGO).
- Access still owner-only; unauthenticated requests 302 to the team login.

### Dev

- Worker `churntop10-dev` version **`4798f5d0-8006-4eb9-a84f-6610c33c4968`**, uploaded **8:13:26 AM CST** (America/Chicago). Etag `fc98d05143b06d67b4e9d13088ae2eeb8a0476e1b5df30d8f3a555879cb0c055`. Script SHA-256 `496fbad92fdf9a5f8ec78b7348f882638e1cd0513e941b330a80f0bdf821fca9`. Embedded UI, no `assets`, `TOKEN_KEY` kept, gate `"0"`, `ENVIRONMENT=dev`, `ACCESS_ENFORCE=1`. Cron `*/5 * * * *`. Previous version (rollback): `20320715-4871-4cf7-8934-5ddf192867f6`.
- D1 `churntop10-dev` now has `0001`–**`0005_trade_signals_threshold.sql`** (recorded 8:12:02 AM CST / 14:12:02 UTC). Pre-`0005` Time Travel bookmark: `000000a8-00000000-00005122-26fed85f6a2eb2ec034474f8838928a3`. PRAGMA shows `trade_signals.threshold`.
- No Robinhood token. Holdings sync uses the recorded TSLL fixture (prod must never use that fixture).
- Conformance: [TEST-RESULTS.md](TEST-RESULTS.md). Local wrangler sim starter persisted three `trade_signals` rows with thresholds. Prod NVDA backfill is still pending go-ahead.

### Open work / pending owner decisions

- **Prod migration `0005_trade_signals_threshold.sql`** and **backfill of the NVDA `trade_signals` rows**: prepared (`scripts/backfill-trade-signals.mjs`, `scripts/cf-templates/backfill-trade-signals.js`). Needs explicit go-ahead. Steps are below. Do not do this without it.
- **GitHub `workflow` scope**: required to add the dedicated `design` CI job in `.github/workflows/ci.yml`. Until then, `npm test` runs the check (see [ci-design-job.pending.yml](ci-design-job.pending.yml)).
- Planned, not built: AI-created rules; rule points 0–100; weekly Saturday 9:00 AM CST review (owner routine, not a Worker cron); churncapital.com; live 24/5 engine; assign-sell-rule UI; Postgres / failover.

## Routines

- Cloudflare cron `*/5 * * * *` → `tickSimulator` (holdings sync + simulator cycle, including when no sim position is open).
- **Weekly review**: Saturday 9:00 AM CST — agreed owner routine, **not built** as a job.

## First-day checklist

1. Read [AGENTS.md](../AGENTS.md), then [DESIGN.md](DESIGN.md) in full, then this file and [TEST-PLAN.md](TEST-PLAN.md).
2. Confirm hard safety rules. Do not place orders, flip the gate, or touch prod without go-ahead.
3. Compare this “Current state” date with `git log` on `main`, Worker versions, and `d1_migrations`.
4. Local: `npm install`, `.dev.vars`, `npm test`, `npm run dev`.
5. If asked to operate prod, re-read pending decisions first.

## Prod steps for `trade_signals` (wait for go-ahead)

Do **not** run these until the owner explicitly approves this migration and backfill. No Robinhood orders, no settings changes, gate stays `"0"`.

1. Time Travel bookmark on prod D1 `b2e4f00d-c7a2-41a6-a75f-12a3043ca20e` (`GET .../time_travel/bookmark`). Record the id here.
2. Apply `migrations/0005_trade_signals_threshold.sql` (one statement): `ALTER TABLE trade_signals ADD COLUMN threshold REAL;`
3. Record it: `INSERT INTO d1_migrations (name, applied_at) SELECT '0005_trade_signals_threshold.sql', CURRENT_TIMESTAMP WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = '0005_trade_signals_threshold.sql');`
4. Dry-run the backfill (`scripts/cf-templates/backfill-trade-signals.js` with `apply = false` and the prod D1 id). Confirm the plan includes trade `3989afa2-7976-4b28-b703-4c5e0352a9a6` with `price_above_20m_avg` (value 0.5625, threshold 0), `spy_up` (0.5025, 0), `volume_above_recent` (1.3833, 1), all fired.
5. With a second, explicit OK, set `apply = true` and run once.
6. Upload the trade_signals Worker to `churntop10-prod` only if that deploy is also approved (embedded UI, `keep_bindings: ["secret_text"]`, `ALLOW_LIVE_TRADING="0"`, `ENVIRONMENT=prod`, no `assets`, no DO remigration). `ensureTradeSignalsSchema()` can add the column at runtime, but still prefer the recorded migration.
7. Verify `trade_signals` for the NVDA trade; leave Access, cron, and the gate unchanged.
