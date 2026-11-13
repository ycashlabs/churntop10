# Handover — Churn Top 10

Living takeover snapshot so a brand-new bot can operate this project. **Update this file in the same PR** whenever wrangler config, migrations, deploy scripts, routines-related docs, env/bindings, current deploy state, open PRs, or pending owner decisions change. CI (`npm run check:design`, run from `npm test`) fails if those ops files change and this file does not.

Nothing in this note is a secret value. Never paste `TOKEN_KEY`, OAuth tokens, or full account numbers here.

Read [DESIGN.md](DESIGN.md) in full first, then this file. Safety rules are in [../AGENTS.md](../AGENTS.md).

Last updated: 13 November 2026, 8:41 AM CST, America/Chicago.

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

- Merge of PR #9: `8aa3502d210597d03d499a91bd14e7253f3a196c`. `main` CI run 52 (push) succeeded at **8:26:45 AM CST**.
- Worker version **`286f9178-e8f6-407f-b7c7-ab5cf6901144`**, uploaded **8:27:02 AM CST**. Script SHA-256 `496fbad92fdf9a5f8ec78b7348f882638e1cd0513e941b330a80f0bdf821fca9`. Etag `fc98d05143b06d67b4e9d13088ae2eeb8a0476e1b5df30d8f3a555879cb0c055`. Embedded UI, no `assets`, `TOKEN_KEY` kept, gate `"0"`, `ENVIRONMENT=prod`. Deployment id `ad6d9dc0-01c3-43d5-8c6c-c06baf3c743f`.
- Rollback target: PR #8 Worker **`1259682e-103a-491f-a6dd-9ab2b69f589a`** (uploaded 7:50:44 AM CST, SHA-256 `c53d6d26371c89ee6f429fc3f24cfd2781a2d0d3cc2727128891de9730692576`). Do not roll past that unless the owner asks.
- Pre-`0005` Time Travel bookmark: `0000009e-00000421-00005122-8bffaec3864d5a10a2b2344a5fcc94b5` (taken immediately before applying `0005`).
- Pre-`0004` bookmark: `00000097-00000000-00005122-dc89ae249ceaced2a400bf9f08d1623d`. Older pre-`0003` bookmark (v1 schema): `0000008c-00000000-00005122-058b292ec81c213fef725a24ea5b3e74`.
- `d1_migrations`: `0001_init.sql`, `0002_v2.sql`, `0003_v3.sql`, `0004_live_sync.sql` (applied 7:50:00 AM CST / 13:50:00 UTC), **`0005_trade_signals_threshold.sql`** (applied **8:26:53 AM CST** / 14:26:53 UTC). PRAGMA on `trade_signals`: `trade_id, signal_id, value, passed, threshold`.
- Prod has a stored Robinhood sign-in (`rh_tokens` row present; values not read).
- **TSLL imported live position** (from Account Summary at **7:52:39 AM CST**): id `d12eba10-4965-4b41-9b27-8d00d07e843e`, `mode=live`, `source=imported`, qty **1**, avg cost **11.05**, no buy/sell rule, capital snapshot 999.95. Matching `broker_import` trade and `exit_type=imported` review. Audit `live_import`. This is the real holding (the 1 share filled earlier at about $11.048); do not place or cancel it.
- **NVDA simulator position** `283f227c-ee68-4cb6-ae5b-444f761ecaae` (buy rule First buy on strength v1 `45cd3ad4-7f7f-4ded-963b-6cb4d78634ba`, sell Take profit v1 `bc1ee88c-…`, `source=app`, quoteSource `robinhood`):
  - Starter buy trade `3989afa2-7976-4b28-b703-4c5e0352a9a6` at **7:55:30 AM CST**, 1 share @ **169.27**, session `extended`. `sim_entry` audit at 7:55:53 AM CST.
  - Add buy trade `5aa49ca9-f1c4-4622-aef6-8e1f8f4a0359` at **8:00:30 AM CST**, 4 shares @ **169.63**, session `extended`, rule Add on strength (audit 8:00:56 AM CST).
  - Both trades still have **0** `trade_signals` rows (they were written by the pre-PR #9 Worker). The 8:30:59 AM CST cron on the new Worker attached a broker stop at **167.86** (`broker_stop_attached`; `sim_cycle` `events` 1, session `regular`). No newer sim fill since the 8:27:02 AM CST upload.
  - Backfill dry-run (`apply=false`, 8:27 AM CST window) planned 6 rows and inserted none: for `3989afa2-…`, `price_above_20m_avg` value 0.5625 threshold 0 fired, `spy_up` 0.5025 / 0 / fired, `volume_above_recent` 1.3833 / 1 / fired; for `5aa49ca9-…`, `price_above_20m_avg` 0.7913 / 0 / fired, `spy_up` 0.6031 / 0 / fired, `volume_above_recent` 1.3427 / 1 / fired. **Applying the backfill waits for a second explicit OK.**
- Mode `view_only`, Sell All off, Trading capital 10000. Prod Top 10 includes SPY (not AVGO).
- Access still owner-only; unauthenticated requests 302 to the team login.

### Dev

- Worker `churntop10-dev` version **`08c1011c-3a90-4ab4-8087-e987ff4aeefa`**, uploaded **8:40:47 AM CST** (America/Chicago). Etag `9c911caba17bf280c254e7d737874fc5c50a4157dee98da59e0ad6138682de92`. Script SHA-256 `6dd41fea3abd35465523b2afe998cd7961b06a0376e06adbcb0459a0270b6595`. Embedded UI, no `assets`, `TOKEN_KEY` kept, gate `"0"`, `ENVIRONMENT=dev`, `ACCESS_ENFORCE=1`. Cron `*/5 * * * *`. Previous version (rollback): `4798f5d0-8006-4eb9-a84f-6610c33c4968`. This is the PR #10 Worker (signal name/reason, live fire guard, trades-table wording).
- D1 `churntop10-dev` now has `0001`–**`0006_trade_signals_name_reason.sql`**. `0005` recorded 8:12:02 AM CST / 14:12:02 UTC; **`0006` recorded 8:39:59 AM CST / 14:39:59 UTC**. Pre-`0006` Time Travel bookmark: `000000ae-00000000-00005122-254240f2ae5bdf4d41da1bcdc73d2c12`. Pre-`0005` bookmark: `000000a8-00000000-00005122-26fed85f6a2eb2ec034474f8838928a3`. PRAGMA shows `trade_signals` columns `trade_id, signal_id, value, passed, threshold, name, reason`.
- No Robinhood token. Holdings sync uses the recorded TSLL fixture (prod must never use that fixture).
- Conformance: [TEST-RESULTS.md](TEST-RESULTS.md). Local wrangler walk: 10 position trades carried signals and the Simulator table showed the DESIGN Fired / Not fired wording. Prod NVDA backfill is still pending a second OK. **Do not apply `0006` or this Worker on prod without explicit go-ahead.**
- Open PR: [#10](https://github.com/ycashlabs/churntop10/pull/10) (`cursor/signal-views-and-live-guards`).

### Open work / pending owner decisions

- **Prod backfill of NVDA `trade_signals` rows** (trades `3989afa2-7976-4b28-b703-4c5e0352a9a6` and `5aa49ca9-f1c4-4622-aef6-8e1f8f4a0359`): dry-run completed, nothing inserted. Needs a second, explicit OK before `apply=true`. Migration `0005` and the trade_signals Worker are already on prod (see Current state).
- **Prod migration `0006_trade_signals_name_reason.sql`** and the signal-views / live-guard Worker: built for dev only. Do not apply or upload to prod without explicit go-ahead.
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

## Prod steps for the NVDA `trade_signals` backfill (wait for a second OK)

Migration `0005` is already applied and recorded (8:26:53 AM CST). The trade_signals Worker is already on prod (`286f9178-…`, 8:27:02 AM CST). A dry-run with `apply = false` already planned the rows below and inserted nothing. Do **not** run the apply until the owner explicitly approves this backfill. No Robinhood orders, no settings changes, gate stays `"0"`.

1. Already done: Time Travel bookmark `0000009e-00000421-00005122-8bffaec3864d5a10a2b2344a5fcc94b5`.
2. Already done: `ALTER TABLE trade_signals ADD COLUMN threshold REAL;` recorded as `0005_trade_signals_threshold.sql`.
3. Already done: dry-run (`scripts/cf-templates/backfill-trade-signals.js`, `apply = false`, prod D1). Planned 6 rows, 0 inserted:
   - `3989afa2-7976-4b28-b703-4c5e0352a9a6`: `price_above_20m_avg` 0.5625 / 0 / fired, `spy_up` 0.5025 / 0 / fired, `volume_above_recent` 1.3833 / 1 / fired.
   - `5aa49ca9-f1c4-4622-aef6-8e1f8f4a0359` (the 8:00 AM CST add, also missing rows): `price_above_20m_avg` 0.7913 / 0 / fired, `spy_up` 0.6031 / 0 / fired, `volume_above_recent` 1.3427 / 1 / fired.
4. With a second, explicit OK, set `apply = true` and run once. The script must still refuse to apply unless that flag is set.
5. Verify `trade_signals` for both NVDA trades; leave Access, cron, and the gate unchanged.
