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

- Merge of PR #11: `e5a6667a7cf3ff6128cc43fce47c94f9f03873e9` at **11:30:41 AM CST**. `main` CI run 43473508295 (push) succeeded at **11:31:29 AM CST**. Earlier PR #10 merge `1376f96d1e8cbea5c37aa3fbec18078af2fef83c` and PR #9 merge `8aa3502d210597d03d499a91bd14e7253f3a196c` remain on `main`.
- Worker version **`851a1db9-e7bd-4c52-972f-fc03a6a826d8`**, uploaded **11:31:51 AM CST**. Script SHA-256 `9eb57e17b521a3ab7c82520098bdd9b94519e35fd982347520024e2df72b84b1`. Etag `a189da76bc957b31fe1fd4225a6e277b320ff74612cdcaca17829c921840fe1a`. Embedded UI, no `assets`, `TOKEN_KEY` kept, gate `"0"`, `ENVIRONMENT=prod`. Deployment id `af8d86c9-cca7-49fe-9805-d0051d655739`. This is the PR #11 Worker (session-load error under `Loading…`, D1 write reductions in DESIGN §8.5), same bundle as current dev.
- Rollback target: PR #10 Worker **`a776d60f-86da-460e-8512-b1abaa079e3b`** (uploaded 8:45:31 AM CST, SHA-256 `6dd41fea3abd35465523b2afe998cd7961b06a0376e06adbcb0459a0270b6595`, deployment `d7a81714-6141-4dc5-b6db-ad16a1144f59`). Do not roll past that unless the owner asks. Older PR #9 Worker `286f9178-e8f6-407f-b7c7-ab5cf6901144` is behind that.
- Pre-`0006` Time Travel bookmark: `000000a2-00000000-00005122-15227bc7e1bb4436c9211a513f305447` (taken immediately before applying `0006`).
- Pre-`0005` bookmark: `0000009e-00000421-00005122-8bffaec3864d5a10a2b2344a5fcc94b5`. Pre-`0004` bookmark: `00000097-00000000-00005122-dc89ae249ceaced2a400bf9f08d1623d`. Older pre-`0003` bookmark (v1 schema): `0000008c-00000000-00005122-058b292ec81c213fef725a24ea5b3e74`.
- `d1_migrations`: `0001_init.sql`, `0002_v2.sql`, `0003_v3.sql`, `0004_live_sync.sql` (applied 7:50:00 AM CST / 13:50:00 UTC), `0005_trade_signals_threshold.sql` (applied 8:26:53 AM CST / 14:26:53 UTC), **`0006_trade_signals_name_reason.sql`** (applied **8:45:27 AM CST** / 14:45:27 UTC). PRAGMA on `trade_signals`: `trade_id, signal_id, value, passed, threshold, name, reason`.
- Prod has a stored Robinhood sign-in (`rh_tokens` row present; values not read).
- **TSLL imported live position** (from Account Summary at **7:52:39 AM CST**): id `d12eba10-4965-4b41-9b27-8d00d07e843e`, `mode=live`, `source=imported`, qty **1**, avg cost **11.05**, no buy/sell rule, capital snapshot 999.95. Matching `broker_import` trade and `exit_type=imported` review. Audit `live_import`. This is the real holding (the 1 share filled earlier at about $11.048); do not place or cancel it.
- **NVDA simulator position** `283f227c-ee68-4cb6-ae5b-444f761ecaae` (buy rule First buy on strength v1 `45cd3ad4-7f7f-4ded-963b-6cb4d78634ba`, sell Take profit v1 `bc1ee88c-…`, `source=app`, quoteSource `robinhood`):
  - Starter buy trade `3989afa2-7976-4b28-b703-4c5e0352a9a6` at **7:55:30 AM CST**, 1 share @ **169.27**, session `extended`. `sim_entry` audit at 7:55:53 AM CST.
  - Add buy trade `5aa49ca9-f1c4-4622-aef6-8e1f8f4a0359` at **8:00:30 AM CST**, 4 shares @ **169.63**, session `extended`, rule Add on strength (audit 8:00:56 AM CST).
  - The 8:30:59 AM CST cron (PR #9 Worker) attached a broker stop at **167.86** (`broker_stop_attached`; `sim_cycle` `events` 1, session `regular`). After the PR #10 upload, `sim_cycle` ran at **8:46:01 AM CST** and **8:51:05 AM CST** (session `regular`, `quoteSource` `robinhood`, `events` 0). No newer sim fill since the 8:45:31 AM CST upload.
  - Owner approved the NVDA backfill at 8:43 AM CST. A dry-run with name and reason planned the same 6 rows as the earlier PR #9 dry-run (values, thresholds, and fired flags unchanged) and inserted none. `apply=true` once in the 8:45 AM CST window inserted 6 rows (`changes: 1` each). Each trade now has **3** `trade_signals` rows including name and reason. A rerun planned 0 (`alreadyHadSignals`). Stored rows:
    - `3989afa2-…`: `price_above_20m_avg` “Price above 20-minute average” 0.5625 / 0 / fired / “Last 169.19 is above the 20-minute average 168.6275.”; `spy_up` “SPY is up” 0.5025 / 0 / fired / “SPY is up 0.5025%.”; `volume_above_recent` “Volume above recent normal” 1.3833 / 1 / fired / “Volume 12000 is above recent normal 8675.”
    - `5aa49ca9-…`: `price_above_20m_avg` “Price above 20-minute average” 0.7913 / 0 / fired / “Last 169.58 is above the 20-minute average 168.7888.”; `spy_up` “SPY is up” 0.6031 / 0 / fired / “SPY is up 0.6031%.”; `volume_above_recent` “Volume above recent normal” 1.3427 / 1 / fired / “Volume 12000 is above recent normal 8937.5.”
- Mode `view_only`, Sell All off, Trading capital 10000. Prod Top 10 includes SPY (not AVGO).
- Access still owner-only; unauthenticated requests 302 to the team login (checked after this upload at **11:32:01 AM CST** and **11:47:47 AM CST**).
- **Prod cron is restored** to `*/5 * * * *` as of **11:32:01 AM CST**, immediately after the PR #11 upload (version stayed `851a1db9-…`). It had been paused at **10:49:47 AM CST** (schedules `[]`) to stop the PR #10 Worker from burning D1 writes. After restore, the first tick was **11:40:48 AM CST** (no 11:35 tick; cron changes can take up to 15 minutes to propagate) and the second was **11:45:47 AM CST**. Both `sim_cycle` audits were session `regular`, `quoteSource` `robinhood`, `events` 0, outcome `ok`, version `851a1db9-…`. No `D1_ERROR` and no `Too many API requests`. First tick pruned `proposals` from 264 to **12** (cleanup: **316 rowsWritten / 23 writeQueries**); second left proposals at 12 (**24 rowsWritten / 12 writeQueries**). Before the pause, a PR #10 tick was about **2,560–2,630 rowsWritten / 775–797 writeQueries** (paired minutes around 10:46–10:56 AM CST).
- After healthy `sim_cycle` ticks through 9:11:06 AM CST, prod cron failed with the D1 write-cap error at 9:15:31 and 9:20:31 AM CST (last Worker `D1_ERROR` in logs at **10:00:32 AM CST**). `GET /api/session` 500’d at 9:19:54 and 9:21:11 AM CST because that path wrote `rate_limits` on the PR #10 Worker. After the Workers Paid upgrade, cron writes resumed at **10:06:07 AM CST** through **10:56:12 AM CST**, then were paused until this promotion. This Worker no longer writes `rate_limits` on `GET /api/session`. Do not place Robinhood orders and do not flip the live gate.

### Dev

- Worker `churntop10-dev` version **`9898e11b-990a-404f-b9d3-c957c7a2dd46`** (version number 16), uploaded **10:35:30 AM CST** from PR #11 (`fd6e9517ee8b1c5660a407a1b88288e333a595f4`; implementation `584f475b82889382b90e80f4dbf60256bb6ff604`). Etag `a189da76bc957b31fe1fd4225a6e277b320ff74612cdcaca17829c921840fe1a`. Script SHA-256 `9eb57e17b521a3ab7c82520098bdd9b94519e35fd982347520024e2df72b84b1`. Deployment id `5ef60d17-99ed-436f-9c92-20328e543d9e`. Embedded UI, no `assets`, `TOKEN_KEY` kept, gate `"0"`, `ENVIRONMENT=dev`, `ACCESS_ENFORCE=1`. Cron `*/5 * * * *`. Rollback target: PR #10 Worker **`08c1011c-3a90-4ab4-8087-e987ff4aeefa`** (uploaded 8:40:47 AM CST). Unauthenticated GET `/` is still HTTP 302 to the team Access login (checked 10:34:11 and 10:47:14 AM CST).
- D1 `churntop10-dev` now has `0001`–**`0006_trade_signals_name_reason.sql`**. `0005` recorded 8:12:02 AM CST / 14:12:02 UTC; **`0006` recorded 8:39:59 AM CST / 14:39:59 UTC**. Pre-`0006` Time Travel bookmark: `000000ae-00000000-00005122-254240f2ae5bdf4d41da1bcdc73d2c12`. Pre-`0005` bookmark: `000000a8-00000000-00005122-26fed85f6a2eb2ec034474f8838928a3`. PRAGMA shows `trade_signals` columns `trade_id, signal_id, value, passed, threshold, name, reason`.
- No Robinhood token. Holdings sync uses the recorded TSLL fixture (prod must never use that fixture).
- Conformance: [TEST-RESULTS.md](TEST-RESULTS.md). Local wrangler walk: 10 position trades carried signals and the Simulator table showed the DESIGN Fired / Not fired wording. Re-run after the prod promotion and NVDA backfill: **54 PASS**, **0 FAIL**, **9 NOT BUILT**.
- PR #11 is **merged and on prod and dev**. It shows the session-load error under `Loading…` (DESIGN §6.1) and implements the D1 write reductions in DESIGN §8.5. No open feature PRs. Locally measured steady-state `saveSim` write statements: **668 before, 10 after**. After the Workers Paid upgrade, a write probe at **10:33 AM CST** deleted leftover `rate_limits` key `__pr11_write_probe__` (`changes: 1`) and a follow-up insert/delete both succeeded. Verified over two cron ticks on this Worker: `sim_cycle` at **10:40:08 AM CST** and **10:45:07 AM CST** (session `regular`, `quoteSource` `recorded`, `events` 0, outcome `ok`, wall time ~2.8 s, version `9898e11b-…`). No `Too many API requests` and no `D1_ERROR` on this version. The 10:35:43 AM CST `Too many API requests` error was the in-flight PR #10 Worker (`08c1011c-…`) tick that started just as the upload landed. First new tick pruned `proposals` from 215 to the last **12** and appended 10 `quote_bars` (680 total); second tick appended 10 more bars (690) and left proposals at 12. GraphQL `d1AnalyticsAdaptiveGroups` (datetimeMinute) on `churntop10-dev`: **before** (PR #10 Worker, last pre-upload ticks 10:05–10:35 AM CST) about **3,006–3,056 rowsWritten / 934 writeQueries** per tick; **after**, first tick (cleanup) **265 rowsWritten / 22 writeQueries**, second (steady) **22 rowsWritten / 11 writeQueries**. No owner `GET /api/session` reached the Worker after 10:00 AM CST (Access still fronts unauthenticated traffic), so a session 200 is not in the logs yet; this Worker no longer writes `rate_limits` on that path. Same script SHA-256 as this prod Worker.

### D1 write cap and Workers Paid (13 November 2026)

- The Cloudflare account hit the Workers Free D1 daily row-write limit (100,000 rows written per UTC day, account-wide, reset 00:00 UTC / 6:00 PM CST). SELECT still works; writes fail with `D1_ERROR: Your account has exceeded D1's free tier daily row write limit`.
- GraphQL `d1AnalyticsAdaptiveGroups` for UTC 13 Nov 2026 through about 9:15 AM CST: `churntop10-dev` 102,836 rowsWritten / 31,018 writeQueries; `churntop10-prod` 31,810 / 9,773; `ycashstats-pools-dev` 62 / 62; `ycashstats-pools-prod` 62 / 62; account total 134,770. Dev alone exceeded the cap. ycashstats is not today’s cause (~4 writes/hour each today; do not change it).
- Root cause on churntop10: `saveSim` DELETE+re-INSERT of `quote_bars`, `proposals`, `sim_orders`, and `sim_selected_rules` every 5 minutes, plus always-on position upserts, price marks, settings, and a `rate_limits` write on `GET /api/session`. After bars started accumulating (dev from about 5:35 AM CST), hourly writes spiked (dev 10k–32k/hour). Indexes add roughly 3.3 written rows per write query. Dev cron also failed with `Too many API requests by single Worker invocation` at 9:00 / 9:05 / 9:10 AM CST (~37 s) once a tick issued too many D1 statements (on the order of 600 bars + 271 proposals + 27 orders). Prod cron and `GET /api/session` then 500’d on the write cap (session 9:19:54 and 9:21:11 AM CST). The UI looked stuck on `Loading…` until PR #11 surfaced the error.
- The owner upgraded the account to **Workers Paid** (stated 10:33 AM CST). The subscriptions API is not visible to this connection (needs Billing Read). Evidence that is visible: 48 entitlements were created or refreshed at **10:01:15 AM CST**, including paid-tier D1 limits (`d1.max_storage_per_db_mb` 10,000 / 10 GB, `d1.max_databases` 1,000,000, `d1.max_account_storage_mb` 1,000,000), and Workers account settings `default_usage_model` is `standard`. D1 writes on `churntop10-dev` work again. Do not change billing or the plan further unless the owner explicitly asks. Do not place Robinhood orders and do not flip the live gate.

### Open work / pending owner decisions

- No further prod promotion is pending for PR #11. The live gate stays `"0"` until explicit approval.
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

## Prod NVDA `trade_signals` backfill (applied 13 November 2026)

The owner approved the apply and the PR #10 promotion at 8:43 AM CST. No Robinhood orders, no settings changes, gate stayed `"0"`. The repo backfill scripts now include `name` and `reason` on INSERT; the template still defaults to `apply = false`.

1. Done: pre-`0006` Time Travel bookmark `000000a2-00000000-00005122-15227bc7e1bb4436c9211a513f305447` (pre-`0005` bookmark remains `0000009e-00000421-00005122-8bffaec3864d5a10a2b2344a5fcc94b5`).
2. Done: `0006_trade_signals_name_reason.sql` applied and recorded at 8:45:27 AM CST / 14:45:27 UTC. PRAGMA: `trade_id, signal_id, value, passed, threshold, name, reason`.
3. Done: dry-run with name and reason (`apply = false`). Planned the same 6 rows as the earlier PR #9 dry-run (values, thresholds, and fired flags unchanged) and inserted none. See Current state for the stored name/reason text.
4. Done: `apply = true` once in the 8:45 AM CST window; 6 inserts (`changes: 1` each). Each trade has 3 rows including name and reason. A rerun planned 0 (`alreadyHadSignals` listed both trade ids). Access, cron, and the gate were left unchanged.
