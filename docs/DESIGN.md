# Churn Top 10 — Design (authoritative rebuild document)

This file is the **single authoritative design** for rebuilding Churn Top 10 from scratch. Someone with only this document, the Robinhood Trading MCP, and a Cloudflare account should be able to produce an identical app: schema, Worker, UI, wording, rules, business logic, settings, security, and operations.

If this file and the code disagree, treat that as a defect and fix one or both in the same change. Do not invent behavior that this document does not describe, and do not leave a behavior change undocumented here.

**Every future change must update this file in the same pull request** whenever it affects behavior, schema, UI copy, APIs, settings, wrangler config, or operational rules. Existing CI runs `npm test`, which starts with `npm run check:design` (`scripts/check-design.mjs`) and **fails** if files under `src/`, `migrations/`, or the wrangler config change and `docs/DESIGN.md` does not, or if wrangler config, migrations, deploy scripts, routines-related docs, or env/bindings change and `docs/HANDOVER.md` does not. The CI `test` job checks out with `fetch-depth: 0` so `git merge-base` can see `origin/main` on push events (the default shallow checkout could not). A separate dedicated `design` job remains sketched in [ci-design-job.pending.yml](ci-design-job.pending.yml). Agents and bots must read this file in full before any work, then [HANDOVER.md](HANDOVER.md) for current environments and state; see [AGENTS.md](../AGENTS.md).

## Related documents

This file is the rebuild contract. The files below are supporting detail. If they drift, reconcile them here.

| File | Role |
| --- | --- |
| [spec-v2.md](spec-v2.md) | Product contract for v2 and v3 (iterative). The v2 “five screens” intro is historical; the built app has six screens, documented here. |
| [storage.md](storage.md) | Storage interface, D1-now / Postgres-later, emergency failover (not built). |
| [sessions.md](sessions.md) | 24/5 sessions and the synthetic stop, in more trading-desk detail. |
| [ACCESS.md](ACCESS.md) | Cloudflare Access applications, JWT checks, no bypass / no service tokens. |
| [dev.md](dev.md) | Current dev deployment facts (ids, bindings). |
| [prod.md](prod.md) | Current prod deployment facts (ids, bindings, bookmarks). Some verification notes predate simulator auto-start; this file is current. |
| [robinhood-terms.md](robinhood-terms.md) | Robinhood terms notes. |
| [../DEPLOY.md](../DEPLOY.md) | Deploy, migrate, resource creation. |
| [../ROLLBACK.md](../ROLLBACK.md) | Worker rollback; D1 rows are not rolled back with a version rollback. |
| [contracts/robinhood/](contracts/robinhood/) | MCP input schemas, recorded fixtures, OAuth notes. |
| [TEST-PLAN.md](TEST-PLAN.md) | Conformance checklist: one checkable item per design statement, with PASS / FAIL / NOT BUILT.
| [HANDOVER.md](HANDOVER.md) | Living takeover snapshot for a new bot: environments, resource ids, secret locations (never values), current state, pending decisions, routines, first-day checklist. Keep current with every ops/state change. |
| [../README.md](../README.md) | Short pointer into this design and local commands. |

Account IDs and Access audiences below are already in those operational docs. Secret values (`TOKEN_KEY`, OAuth tokens) are never stored in git.

---

## 1. Purpose

Churn Top 10 is a **single-owner Utility Investing / Churning** app. The goal is to keep the product **simple and focused on making profits**.

Trading is **rules-based, not free-form AI**. Named Buy and Sell rules, each with plain-English text and a list of signals, are the contract. The app **trades itself on cron** (`*/5 * * * *`). A human assistant or bot may **build, document, and operate** the software; it must not invent ad-hoc trades outside the rules, and it must not place real broker orders unless the owner explicitly confirms that specific order.

There is one owner: `tom2258@gmail.com`. There is no multi-user product.

Live real-money trading stays off until the owner explicitly approves it. Until then, `ALLOW_LIVE_TRADING` is `"0"`, the broker submit path throws before any place/cancel/modify call, and the **Simulator** is where selected rules run against fake money. Account Summary shows only the real Robinhood account (and imported live holdings once sync runs).

---

## 2. Architecture and topology

### 2.1 Components

- **Cloudflare Worker** (`churntop10-dev` / `churntop10-prod`). HTTP + cron. Hono router in `src/worker/index.ts`. The UI (HTML, CSS, JS) is **embedded in the Worker bundle** (`npm run build` → `dist/index.js`). **Deployed Workers have no `assets` / `ASSETS` binding.** Local `wrangler dev` may use the `assets` binding from the top-level `wrangler.jsonc` for convenience; that binding must not be uploaded to the deployed Worker.
- **No `eval` / `new Function` in the runtime bundle.** `npm run check:bundle` (`scripts/check-bundle.mjs`) must stay green.
- **Cron** `*/5 * * * *` calls Durable Object `AccountTrader` method `tickSimulator` (via `idFromName("owner")`).
- **D1** — application database (SQLite-compatible). One database per environment.
- **R2** — durable audit objects (`audit/YYYY-MM-DD/<id>.json`). D1 `audit_index` is the index. If R2 write fails, the D1 row still stands.
- **Durable Object** `AccountTrader` — trading state machine, simulator cycle, holdings sync, settings, quotes. SQLite class migration tag `v1` already exists; do not re-run `new_sqlite_classes` on a later deploy.
- **Cloudflare Access** in front of each deployed hostname (owner-only allow policy). The Worker **re-checks** the Access JWT when `ACCESS_ENFORCE` is `"1"`.
- **Passkey (WebAuthn)** app session on top of Access. Cookie `__Host-session`, 12 hours. An **authenticator-app TOTP** (RFC 6238, 6 digits, 30s, SHA-1, ±1 step) is an alternative for sign-in and for the 5-minute step-up, once enrolled. A recovery session still cannot use the app.
- **Robinhood Trading MCP** over OAuth. Access and refresh tokens are encrypted with Worker secret `TOKEN_KEY` and stored in D1 `rh_tokens`. Redirect URI is the loopback `http://127.0.0.1:47621/callback` (Robinhood’s public client does not allow a web callback).
- **`ENVIRONMENT`** plain-text binding: `"dev"` or `"prod"`. **`ALLOW_LIVE_TRADING`** plain-text binding: must be `"0"` unless the owner has explicitly armed live trading.

### 2.2 Dev and prod separation

Dev and prod are **separate everything**: Worker, D1, R2, Access application, Access audience, `TOKEN_KEY`, and `AUTH_KEY`. They share no data and no credentials.

| | Dev | Prod |
| --- | --- | --- |
| Worker | `churntop10-dev` | `churntop10-prod` |
| URL | https://desk-dev.churncapital.com (canonical Workers Custom Domain). https://top10-dev.ycashlabs.com stays attached during the move. | https://top10.ycashlabs.com (same pattern). Planned later cutover, after an explicit go-ahead: https://desk.churncapital.com, keeping the old name attached until then. |
| D1 | `churntop10-dev`, id `7f0a12d3-f689-4a86-b30d-b349bdd77736` | `churntop10-prod`, id `b2e4f00d-c7a2-41a6-a75f-12a3043ca20e` |
| R2 | `churntop10-audit-dev` | `churntop10-audit-prod` |
| Access app | `Churn Top 10 dev`, audience `3826fb9770402e73a472a3e3519bcdbd4cdcbf79cc695141d3ffb9cdd8a2cdaa` | `Churn Top 10 prod`, audience `b05d3bc57044f2fd02b7e9666d7e61a18e236784bdcbda9ea8322b9d6fe14517` |
| Team | `dawn-rice-07a4` | same team, **different audience** |
| Policy | Emails, `tom2258@gmail.com` only. No bypass, no service token, no everyone. | Same shape, same mailbox |
| `ENVIRONMENT` | `dev` | `prod` |
| `ALLOW_LIVE_TRADING` | `0` | `0` |
| `ACCESS_ENFORCE` | `1` on the deployed env; `0` only in top-level local `wrangler.jsonc` | `1` |
| `TOKEN_KEY` | its own secret | its own secret; never reuse dev’s |
| `AUTH_KEY` | its own secret (encrypts the TOTP secret at rest) | its own secret; never reuse dev’s; set **7:49:54 PM CST** 13 Nov 2026 |

Cloudflare account id used in the existing project: `f59b2545f5783d93b378006f3eb10bb4`. Zones `churncapital.com` (`f09ccbd7eefc0bba88ac60412282313b`) and `ycashlabs.com` (`66b09838eac0a3ca85925d0eccbb8da9`).

**Hostnames are config, not hardcoded** (`src/lib/hosts.ts`). `HOSTNAME` is the canonical public host. `ALLOWED_HOSTS` is an optional comma-separated list of aliases still served by the same Worker (the previous `ycashlabs.com` name during a move). `allowHost` accepts `HOSTNAME`, those aliases, and, on non-prod only, `localhost` / `127.0.0.1`. The WebAuthn RP ID and origin are taken from the *request* hostname (`rpFromUrl`), so a passkey registered on one host will not work on the other. Recovery email links use `https://$HOSTNAME` (localhost keeps the request origin). `ZONE` stays `ycashlabs.com` so recovery mail still comes from `noreply@ycashlabs.com` (Email Sending is onboarded there). Changing a host's RP ID means the owner must register a new passkey on the new name and re-add the authenticator app (enrollment still needs a passkey step-up).

**`churncapital.com` apex mail is the owner's iCloud+ custom domain.** DNS already has MX `mx01.mail.icloud.com` and `mx02.mail.icloud.com` (priority 10), TXT `apple-domain=11ccpqOL0trL8Grc`, TXT `v=spf1 include:icloud.com ~all`, and CNAME `sig1._domainkey.churncapital.com` → `sig1.dkim.churncapital.com.at.icloudmailadmin.com`. **Do not modify or remove these records.** App hosts on this zone are `desk` / `desk-dev` only (Workers Custom Domains). Recovery email still sends from `noreply@ycashlabs.com`.

The authenticator-app `otpauth` URI is also config-driven (`TOTP_ISSUER` plus `HOSTNAME`). The issuer is the `TOTP_ISSUER` var (`churntop10 Dev` on dev, `churntop10` on prod). The label is `<issuer>:<owner email> (<HOSTNAME>)`. On deployed dev that is issuer `churntop10 Dev` and label `churntop10 Dev:tom2258@gmail.com (desk-dev.churncapital.com)`. On prod (when that config is deployed) that is issuer `churntop10` and label `churntop10:tom2258@gmail.com (top10.ycashlabs.com)`. Local `wrangler dev` uses issuer `churntop10 Local`. These strings must appear verbatim in the URI so the authenticator app can tell the environments apart. Re-enrollment is required for an existing authenticator entry to pick up a new name.

**Design intent: dev never holds a live Robinhood token.** Prod is the only environment that may store a real trading OAuth token. The Worker code still contains the same connect path in both environments; do not use it on dev. When Robinhood is not connected, **prod** returns no holdings (never invents them from a fixture). **Dev and tests** may use the recorded fixture `docs/contracts/robinhood/fixtures/get_equity_positions_tsll.json` so the UI can be walked without a token. See [mismatches](#19-doc-vs-code-mismatches).

Local `wrangler dev` (top-level config, not `--env dev`) sets `ACCESS_ENFORCE` to `"0"` and `ALLOW_LIVE_TRADING` to `"0"` so a passkey can be registered on http://localhost:8787. Never upload the top-level `ACCESS_ENFORCE=0` value.

### 2.3 Live trading gate

`src/lib/broker.ts` `submitGatedTool` is the only path that may call Robinhood place or review:

- `ALLOW_LIVE_TRADING` must be the string `"1"`, or it throws `LiveTradingDisabled` before `send`.
- Only `review_equity_order` and `place_equity_order` are forwarded.
- `cancel_equity_order` and any tool whose name starts with `cancel_` or includes `modify` are **always refused**, even if the gate is later set to `"1"`.
- Outgoing args are validated against the checked-in JSON Schema (`assertOutgoing`).

Sell All Positions, rollback, and kill/resume must not call cancel or place.

---

## 3. Screens, layout, and structure

The document title (HTML `<title>` and the `h1`) is **Churn Top 10**. The shell is a cream page with a header, nav, status stamp, clock, session name, and Sign out. Authenticated routes:

| Path | Screen |
| --- | --- |
| `/` | Account Summary |
| `/top10` | Top 10 |
| `/rules` | Rules |
| `/simulator` | Simulator |
| `/review` | Review |
| `/settings` | Settings |

Nav order, left to right: Account Summary, Top 10, Rules, Simulator, Review, Settings. The current route gets class `active`.

**Header (every authenticated screen):** title, nav, stamp (`New buys stopped` if Sell All is on, else `Live` if mode is live, else `View only`), clock (`YYYY-MM-DD HH:MM ET`), raw session name (`regular` / `extended` / `overnight` / `closed`), button **Sign out**.

**Global banners** (above the page body, can stack):

- If mode is not live: View Only banner (exact copy in [§6](#6-ui-copy-catalog)).
- If mode is live and `liveGate` is false: broker gate off banner.
- If `killed`: Sell All Positions is on banner.
- Request errors as `<p className="error">`.

**Sign-in** (`/` when unauthenticated or in recovery) is a separate shell (`signin`): title, short explanation, optional recovery banner, Create passkey or Sign in, optional authenticator-code form when TOTP is enrolled, recovery email form.

**Shared position panel** (`PositionsPanel`) is used on Account Summary (**Live positions**) and Simulator (**Simulated positions**). Each open position is an article: symbol heading, qty @ avg · last · P&L, capital snapshot and target/stop and rule labels, a trades table (Side, Qty, Price, Status, Reason) with stored signals listed under the reason as specified in [§6](#6-screens-and-exact-ui-copy), and if open: **Edit capital** and **Edit target / stop**.

There are no tooltips in the current UI (`title=` attributes are not used on controls). Status “badges” are the header `stamp` and each rule’s `stamp` class (`experimenting` / `proven` / `retired`) showing the raw status string.

---

## 4. Settings catalog

Settings live in `app_settings` (singleton `id = 1`). The Settings screen edits a subset. Defaults below are what `AccountTrader.seed()` inserts on a fresh database. Percents are already in percent units (1 means 1%, not 0.01).

| Setting | UI label | Default | Allowed range | Validation message (server) | Effect |
| --- | --- | --- | --- | --- | --- |
| `profitTargetPct` | Profit target, percent above average cost (any positive percent, up to 100) | `1` | Finite, `> 0`, `≤ 100` | `Profit target must be a positive percent no greater than 100.` | Default take-profit for **new** positions (snapshotted onto the position). Existing open positions keep their own value until edited. |
| `stopLossPct` | Stop-loss, percent below average cost (any positive percent, up to 100) | `1` | Same | `Stop-loss must be a positive percent no greater than 100.` | Default stop for **new** positions, snapshotted the same way. |
| `dailyLossPct` | Daily loss stop, percent of Trading capital (any positive percent, up to 100) | `1` | Same | `Daily loss stop must be a positive percent no greater than 100.` | If `max(0, dayStartEquity − current equity)` is at or above `effectiveTradingCapital × dailyLossPct / 100`, **new buys pause**. Protective sells still run. |
| `orderCap` | Order cap, orders per day (1–1000; may be set high, for example 100) | `100` | Integer `1`–`1000` | `Order cap must be between 1 and 1000 orders per day.` | Caps **new buys** per calendar day (ET). Protective sells are not capped. |
| `tradingCapital` | Trading capital, dollars | `10000` | Finite, `> 0`, `≤ 1_000_000_000` | `Trading capital must be a positive dollar amount.` | Fixed dollar amount saved in Settings. Each **new** position snapshots the **effective** capital at open: `min(saved, real balance)` when saved is above the balance (and a warning is shown). Changing Settings does not rewrite open positions. |
| `mode` | Switch to Live / Switch to View Only | `view_only` | `view_only` or `live` | `Unknown mode.` | View Only: live path checks an order and does not send it (`view_only` verdict). Live: still cannot send unless `ALLOW_LIVE_TRADING` is `"1"`. |
| `killed` | Sell All Positions / Allow new buys again | `0` (false) | boolean | Sell-all without confirm: `Confirm selling every simulated position and stopping new buys.` | When on, new buys are stopped. Sell All also liquidates **simulated** positions only. It does not place or cancel real Robinhood orders. |

**Not shown as Settings fields, but present in `app_settings`:**

| Column | Default on seed | Status |
| --- | --- | --- |
| `max_order_pct` | `10` | Legacy column from v1. **Not used** as a buy guard. Sizing uses the 10% position cap in code (`POSITION_CAP_PCT`). |
| `pdt_limit` | `3` | Legacy column. **Not used.** The PDT day-trade cap was removed (FINRA Notice 26-10; Robinhood removed PDT). `day_trades` table still exists but is unused by the guard. |
| `day_start_equity` / `day_start_date` | `10000` / today’s ET date | Rolled at the ET day boundary for the daily loss stop. |
| `cash` | `10000` | Simulator / fallback cash when no Robinhood equity is available. |
| `account_number` | `SIM0000999` | Placeholder; never shown in the UI (and must stay masked if it ever is). |

**HTML inputs** on Settings use `min={0}` for the three percents and Trading capital, and `min={1} max={1000}` for the order cap. The **server rejects 0** for percents and for Trading capital (`value > 0`). A user can type 0 in the box; Save caps then fails with the messages above. That input-min mismatch is called out in [§19](#19-doc-vs-code-mismatches).

**Quick-fill buttons** for Trading capital: 10%, 20%, …, 100% of the **current balance**, each labeled `{pct}% ({dollars to two places})`. The saved value is always the dollar figure, not the percent.

**Per-position overrides** (not Settings, but related):

- **Edit capital** — changes only that position’s `trading_capital_snapshot`. Requires confirm (`confirm: true`). Message if invalid: `Trading capital must be a positive dollar amount.` Also: `Confirm the capital change for this position.` / `That open position was not found.` Logged in `position_capital_history`. Never sells shares; if the new cap is below holdings, the app just stops adding.
- **Edit target / stop** — per-position `profit_target_pct` / `stop_loss_pct`, same `validExitPct` messages, logged in `position_exit_settings_history`. **Requires passkey step-up.** Edit capital does **not**.

---

## 5. Trading logic

### 5.1 Sessions (America/New_York). Holidays are not modeled.

| Session | Clock (ET) | MCP `market_hours` | Orders |
| --- | --- | --- | --- |
| Regular | Weekdays 09:30–16:00 | `regular_hours` | Limit, market, broker `stop_market` / `stop_limit`. Fractional shares allowed. |
| Extended | Weekdays 07:00–09:30 and 16:00–20:00 | `extended_hours` | Limit only. Whole shares only. |
| Overnight | Sunday 20:00 through Friday 20:00, outside regular and extended | `all_day_hours` | Whole-share limit only; symbol should be on Robinhood’s 24 Hour Market list. |
| Closed | Friday 20:00 through Sunday 20:00 | — | No new orders and no exits. |

Implemented in `src/lib/clock.ts` `marketSession`.

### 5.2 New buys and quote quality

New buys are allowed in regular, extended, and overnight **in the simulator**, subject to the guards in `validateNewBuy` (`src/lib/validator.ts`). A new buy is skipped when:

- Sell All Positions is on.
- The account is not agent-tradable (live path).
- Symbol is not 1–5 letters.
- Settings are out of range.
- No usable quote (tradable, with bid and ask).
- The symbol is not in the Top 10 **and** is not already held (adds to a held name are allowed; first buys must be on the list). Positions already open stay managed if later removed from the list.
- An order for that symbol is already working.
- Session is `closed`.
- Overnight and the symbol is marked not eligible (`overnightEligible === false`). In the simulator, a tradable quote is treated as eligible unless a test sets this false. `get_equity_tradability` output fields for the 24 Hour list were not in the captured contract; do not assume every Top 10 name can be bought overnight.
- Live Robinhood quote is stale (older than 5 minutes, from the later of venue last trade / last non-reg trade). The **recorded book** used when disconnected is never treated as stale.
- Bid or ask missing, or spread `(ask − bid) / mid` **> 1%** (`MAX_SPREAD = 0.01`).
- Daily loss stop is hit.
- Daily order cap is reached.
- Open exposure is already at or above effective Trading capital, or the new buy would take it above.
- Live audience and no Proven buy rule.
- One whole share costs more than the 10% cap (overnight / extended).
- The sized quantity does not fit under the cap or buying power. **The app never borrows and never uses margin.**
- Live audience and mode is `view_only` — the order is checked and **not sent** (verdict `view_only`). This does **not** block the simulator.

### 5.3 Sizing (percentages only; no dollar min/max buy fields)

Constants in `src/lib/sizing.ts`:

- Per-symbol cap = **10%** of the **position’s Trading capital snapshot** (for an open position) or of effective Trading capital (for a first buy). `POSITION_CAP_PCT = 10`.
- Starter buy = **20% of that max position** = **2% of the snapshot**. `STARTER_PCT_OF_MAX = 20`.
- Later **adds** are sized by signal strength in `[0, 1]`: `room_under_cap_and_buying_power × strength`. Strength 0 means no add. There is **no fixed add count and no fixed add size**. Stronger signals add more; weak signals add little or nothing. Every add is logged with the signals, values, and a size reason.
- Regular hours: fractional shares (rounded by `roundShares`). Extended and overnight: **whole shares only** (`Math.floor`).
- **Sells have no dollar limit** and are not blocked by the Top 10, the order cap, or the daily loss stop.

### 5.4 Profit target and stop-loss

Both are a percent of the **position’s average cost**, not of account balance. After scaling in, average cost is the whole position. Take profit may fire before the position is full. Any positive percent up to 100 is allowed. Defaults come from Settings at open; each position can be edited later.

### 5.5 Synthetic stop (off-hours)

Outside regular hours there is **no resting broker stop**. The app stores a synthetic stop (simulator order role `stop`, type `synthetic`, status `watching`). On each cycle (cron or Run check):

1. If session is closed, wait. No buys, no exits.
2. If the session has become regular and the stop is still synthetic (and no stop-exit is already working), convert it to a resting broker `stop_market` with `gtc` and `regular_hours` (in the simulator this is a local type change; with the live gate off, nothing is sent).
3. If a broker `stop_market` is working and last is at or below the stop, the simulator fills at the bid.
4. If a synthetic stop is watching and last is at or below the stop, cancel the resting take-profit (if any) and submit a **marketable limit sell**: limit = bid minus the greater of **$0.02** and **0.05% of last**, rounded to the cent, `gfd`, current session `market_hours`.
5. If a `stop_exit` is already working: fill when still marketable (limit ≤ bid); otherwise reprice. If no usable bid, wait for the next cycle.
6. A take-profit limit fills when last is at or above its price and the session is open.

The stop is only checked when a cycle runs (normally every 5 minutes). A move between checks, a missed cron, a gap, or the weekend close can pass the stop before a sell is sent. This is not a resting broker stop.

**This exit engine is implemented in the simulator.** The gated live path does **not** yet run synthetic-stop / take-profit management against broker orders. See [§19](#19-doc-vs-code-mismatches).

### 5.6 Safety limits (always on, outside the rules system)

- Daily loss stop: percent of Trading capital (any positive % ≤ 100).
- Daily order cap (1–1000).
- Buy only with available buying power; never borrow; no margin.
- 10% per-symbol cap on the position snapshot / effective capital.
- Open exposure + new buy cannot exceed current effective Trading capital.
- **No PDT cap** (FINRA Notice 26-10; Robinhood removed PDT).

### 5.7 Trading capital snapshot

Settings holds a **fixed dollar amount**. Quick fills are 10% increments of current balance plus custom entry. Each new position snapshots **effective** capital at open (`min(saved, real equity)` when saved is higher; if saved is invalid, fall back to balance). That snapshot is what the position uses for the 10% cap, the 20% starter, and later adds. Changing Settings applies only to positions opened afterwards. **Edit capital** on an open position is confirmed, logged, and never sells shares. If capital in Settings is above real equity, the UI warns and new trades use the lower figure. Lowering Settings pauses new buys until exposure is under the new figure.

### 5.8 Live placement path (only if the gate is armed)

`AccountTrader.cycle()` (account path, not the simulator) calls `proposeLiveEntries` only when `ALLOW_LIVE_TRADING === "1"`. **As implemented, that function returns immediately unless the session is `regular`**, auditing `live_skipped` / `off_hours_live_not_armed`. It reviews then places an entry and a broker stop, and writes `positions` / `trades` (see [§8](#8-holdings-sync-live-order-records-and-simulator-auto-start)). Off-hours live placement and live exit management are not built.


---

## 6. UI copy catalog

All strings below are **verbatim** from `src/client/App.tsx` and `SESSION_HELP` in `src/lib/clock.ts`, plus document title from `src/client/index.html`. Dynamic interpolations are described in braces.

### 6.1 Document and chrome

- HTML title / `h1`: `Churn Top 10`
- Loading (no session yet): `Loading…`. If the session request fails, keep `Loading…` and also show the error in the same error style as the account-loading screen. The message is the API `error` field when the response body has one, otherwise `Request failed.` (from `api()`), or `Could not load.` if the failure has no message.
- Loading (authenticated, summary not in yet): `Loading the account…`
- Generic load failure: `Could not load.`
- Generic action failure: `Request failed.`
- Nav: `Account Summary` · `Top 10` · `Rules` · `Simulator` · `Review` · `Settings`
- Stamp: `New buys stopped` | `Live` | `View only`
- Button: `Sign out`
- Banner, View Only: `View Only. Live real-money trading stays off until you explicitly approve it. The Simulator has its own screen and fake money.`
- Banner, live mode but gate off: `Live is selected, but the broker gate is off. No real Robinhood orders are sent. Use the Simulator screen to run selected rules with fake money.`
- Banner, Sell All on: `Sell All Positions is on. New buys are stopped. Real Robinhood orders are not cancelled or sold from here.`
- Shared session help (`SESSION_HELP`), used on Account Summary → Session and on Settings: `Buys run 24/5, Sunday 8:00 PM through Friday 8:00 PM ET. Outside regular hours, entries and exits are limit orders only. The app watches the stop-loss every 5 minutes and sends a limit sell if the price is at or below the stop. That is not a resting broker stop, so a move between checks can go through the stop before a sell is sent.`

### 6.2 Sign-in

- `One owner. Sign in with your passkey, or with an authenticator code if you have set one up. Email is only for recovery.`
- Banner: `Recovery confirmed. Register a new passkey to replace the old one.`
- Error (query `recovery=invalid`): `That recovery link is invalid or already used.`
- Button: `Create passkey` (when no credential, or recovery)
- Button: `Sign in` (when already registered)
- Failures: `Could not register.` · `Could not sign in.`
- When TOTP is enrolled (and not in recovery): `Or sign in with an authenticator code.`
- Label: `Authenticator code` or `Backup code`
- Button: `Sign in with code`
- Toggle: `Use a backup code` / `Use an authenticator code`
- Label: `Recovery email` (input default value in code is `tom2258@gmail.com`, autocomplete `username`)
- Button: `Email a recovery link`
- Success note: `If that email is the owner, a recovery link was issued.`
- Failure: `Could not start recovery.` (or the Worker error `Recovery email could not be sent.` when the owner address matched but mail was not sent)

**Confirm dialog** (step-up on 403 `stepUp: true`)

- `Confirm with your passkey.`
- Button: `Use passkey` · `Cancel`
- Failure: `Passkey confirmation failed.`
- When TOTP is enrolled and the request does not require a passkey-only step-up: `Or enter an authenticator code.`
- Label: `Authenticator code` or `Backup code`
- Button: `Confirm with code`
- Toggle: `Use a backup code` / `Use an authenticator code`

### 6.3 Account Summary

**Section “Robinhood account”**

- Heading: `Robinhood account`
- Error: `{robinhoodError or "Robinhood could not be read."} Reconnect from Settings.` (Settings is a link to `/settings`)
- Not connected: `Not connected. Connect from Settings. This screen shows only the real Robinhood account. Fake-money trading lives on the Simulator screen.`
- Definition list labels, when connected: `Account`, `Name`, `Type`, `Trading`, `Agent account` (values `Yes` / `No`), `Portfolio`, `Cash`, `Buying power`, `Pending deposits`, `Unsettled`, `Today realized`

**Section “Session”**

- Heading: `Session`
- Body: `SESSION_HELP` (above)
- Labels: `Clock`, `Session`, `Quotes`
- Quotes values: `Live Robinhood` | `Recorded book (Robinhood not connected)`

**Live positions** (shared panel)

- Heading: `Live positions`
- Empty: `No open live positions. Robinhood holdings are imported here automatically. Live real-money trading stays off until you approve it.`
- Per position header line: `{quantity} @ {avgCost} · last {last} · P&L {pnl}`
- Meta: `Trading capital snapshot {tradingCapital}. Target {profitTargetPct}% / stop {stopLossPct}% of average cost. {buyRule} · {sellRule}` (rule names omitted if missing; imported positions use buy rule `imported/manual`)
- Trades table headers: `Side`, `Qty`, `Price`, `Status`, `Reason`
- Empty trades: `No trades recorded yet.`
- The Reason cell starts with the size reason, then a space and the exit reason when one is present. When the trade has stored signals, each signal is listed on its own following line in this exact form, via `formatTradeSignalLine`: `{name}: Fired. Value {value}, threshold {threshold}. {reason}` or `{name}: Not fired. Value {value}, threshold {threshold}. {reason}`. If `value` is null, omit the `Value …` clause, so the line is `{name}: Fired. {reason}` or `{name}: Not fired. {reason}`. If `value` is present and `threshold` is null, the clause is `Value {value}.`. Settings-only exits with no stored signals show only the size and exit reasons.
- Buttons: `Edit capital` · `Edit target / stop`

**Edit capital dialog**

- `Change this position’s Trading capital snapshot only. This never sells shares. If the new cap is below current holdings, the app just stops adding.`
- Buttons: `Confirm capital change` · `Cancel`
- Failure: `Could not edit.`

**Edit target / stop dialog**

- Labels: `Profit target %` · `Stop-loss %`
- Buttons: `Save target and stop` · `Cancel`
- Failure: `Could not edit.`

### 6.4 Top 10

- Heading: `Top 10`
- Help: `This list is editable anytime and limits new first buys only. Positions in a name you later remove are still managed and can still be sold. Adds to a held name follow the scaling-in rules.`
- Table headers: `Symbol`, `Bid`, `Ask`, `Last`
- Label: `Symbols, one per line`
- Button: `Save list`
- Server validation: `Enter 1 to 10 unique letter symbols.`
- Fallback: `Could not save the Top 10.`

### 6.5 Settings

- Heading: `Settings`
- Help: `SESSION_HELP`
- Labels: see [§4](#4-settings-catalog) (exact label text is in that table).
- Sizing note: `There are no buy amount fields. Sizing is the 20% starter (2% of the position’s Trading capital snapshot), signal-sized adds, and a 10% per-symbol cap on that snapshot. Sells have no dollar limit. The app never borrows.`
- Buttons: `Save caps` · `Switch to Live` · `Switch to View Only` · `Sell All Positions` · `Allow new buys again` (only if killed)
- Trading capital help: `This saved dollar figure is snapshotted onto each new position. Changing it does not alter open positions. Quick fills use the current balance ({balanceUsd or "n/a"}).`
- Warning: `Trading capital is above the current balance. New trades will use {effectiveUsd}.`
- Warning: `Open exposure ({exposureUsd}) is at or above Trading capital. New buys are paused until exposure is back under.`
- Quick-fill button: `{pct}% ({dollars with two decimals})`
- Heading: `Robinhood`
- Status: `Connected to {maskedAccount or "your account"}.` · `Not connected.` · error uses `robinhoodError` or `Robinhood could not be read.`
- Buttons: `Reconnect Robinhood` · `Disconnect Robinhood`
- Disconnect confirm (`window.confirm`): `Disconnect Robinhood? The app forgets its saved sign-in. Robinhood orders are not touched.`
- Heading: `Authenticator app`
- When not enrolled: `Use an authenticator app to sign in when a passkey is not available, for example on a remote desktop.`
- Button: `Set up authenticator app`
- During setup: `Scan this QR code with your authenticator app, or enter the setup key.`
- Label: `Setup key` (read-only) · `Code from the app`
- Buttons: `Confirm` · `Cancel`
- After confirm: `Save these backup codes. Each can be used once. They will not be shown again.`
- Button: `I saved these codes`
- When enrolled: `An authenticator app is set up. You can sign in or confirm with a code from the app, or with a backup code.`
- Buttons: `Turn off authenticator app` · `Set up again`
- Failures: `Could not start authenticator setup.` · `Could not confirm the authenticator.` · `Could not turn off the authenticator.`
- Footer: `Saving caps, editing the Top 10 or a rule, marking a rule Proven, and switching to Live or connecting Robinhood each ask for the passkey again, or an authenticator code if you have set one up. Sell All Positions asks for a confirm step, not a passkey. It sells simulated positions only and does not place or cancel real Robinhood orders.`

**Sell All confirm**

- Trigger button: `Sell All Positions` (class `danger`)
- Body: `This sells every simulated position, stops new buys, and does not send or cancel real Robinhood orders. Confirm?`
- Buttons: `Confirm sell all` · `Cancel`
- Failure: `Could not sell.`
- API if confirm missing: `Confirm selling every simulated position and stopping new buys.`

**Connect / Reconnect Robinhood (3 steps)**

- Heading: `Reconnect Robinhood in 3 steps` or `Connect Robinhood in 3 steps`
- Step 1: `Open Robinhood.` `You confirm with your passkey, then Robinhood opens in a new tab.`
- Buttons / links: `Open Robinhood sign-in` · `Start over` (if a connect URL or pending already exists) · `Robinhood tab didn't open? Click here.`
- Step 2: `Log in and tap Approve.` Then: Robinhood then shows an error page such as (in `<em>`) `This site can't be reached` or `127.0.0.1 refused to connect`. **That is expected**: the sign-in worked and the code is in that page's address.
- Step 3: `Copy that page's address and paste it below.` `Click the address bar, select all, copy, and paste here. It connects as soon as you paste.`
- Pending: `Waiting for your paste` optionally ` until {locale time}.`
- Label: `Address of the error page`
- Placeholder: `http://127.0.0.1:47621/callback?code=…`
- Buttons: `Finish connecting` · `Cancel`
- Paste errors (from `parseCallbackInput`):
  - `Paste the full address from the page Robinhood sent you to.`
  - `That address could not be read. Copy the whole address bar and try again.`
  - `That is not the Robinhood return address. It should start with http://127.0.0.1:47621/callback.`
  - `Robinhood said: {error}` or `{error} ({description})`
  - `That address has no sign-in code. Approve on Robinhood first, then copy the address.`

### 6.6 Rules

- Loading: `Loading rules…` · `Could not load rules.` · `Request failed.`
- Heading: `Rules contract`
- Help: `You edit the text; the app proofreads by saving a history entry for every change, status change, and approval. Only you can mark a rule Proven. Live trading uses only Proven rules. The Simulator can run any selected rules, including Experimenting ones. Editing a Proven rule creates a new Experimenting version; open trades keep the versions they started with.`
- Per rule: name plus `v{version}`; stamp is the raw status (`experimenting`, `proven`, `retired`).
- Meta: `Buy rule` or `Sell rule` · signal ids joined by `", "` or `Uses Settings percentages`
- Scorecard: `No trades yet.` or `Win rate {n% or —}. Avg profit {$x.xx or —}. Worst loss {$x.xx or —}. {n} trades.`
- Buttons: `Edit / rename` · `Mark Proven` · `Move to Experimenting` · `Retire` · `History`
- Heading: `Edit rule` or `Create a rule`
- Labels: `Name` · `Side` (options `Buy`, `Sell`, only when creating) · `Plain-English text`
- Buttons: `Save changes` · `Create rule` · `Cancel`
- History heading: `History` · empty: `No history yet.`
- History line: `{locale datetime} {action}{ optional " {fromStatus} → {toStatus}"} · v{version}`

### 6.7 Simulator

- Loading: `Loading the simulator…` · `Could not load the simulator.` · `Could not run the simulator.`
- Heading: `Simulator`
- Help: `Fake money only. This screen is separate from Account Summary. Run the rules you select. Off-hours stops are still watched on each cycle, normally every 5 minutes when a position is open.`
  - Note: after auto-start, cron also cycles when **no** position is open. This sentence is slightly stale; see [§19](#19-doc-vs-code-mismatches).
- Labels: `Equity`, `Cash`, `Daily loss` (value `{dailyLoss} / {dailyLossCap}`), `Orders today` (`{ordersToday} / {orderCap}`), `Quotes` (`Live` or `Recorded`), `Trading capital` (`{effectiveUsd}` plus ` (capped at the current balance)` when warned)
- Banner: `Open exposure is at or above Trading capital. New buys wait until exposure is back under.`
- Heading: `Rules to run` — checkbox per rule: `{name} ({status})`
- Button: `Run check`
- Positions heading: `Simulated positions`
- Empty: `No simulated positions.`
- Heading: `Orders` — headers `Symbol`, `Side`, `Role`, `Status`, `Price` — empty: `No orders yet.`
- Heading: `Latest check`
  - Event line: `{action} {detail}`
  - Proposal line: `{symbol} {verdict}. {message}`
  - Empty: `No check yet. Select rules and run one.`

### 6.8 Review

- Loading: `Loading reviews…` · `Could not load reviews.`
- Heading: `Review`
- Help: `Closed positions, imported live holdings, automatic bot notes, and scorecards. Filters apply to the list below.`
- Filter labels: `Symbol` · `Session` (options `Any`, `Regular`, `Extended`, `Overnight`) · `Mode` (`Any`, `Simulator`, `Live`) · `Rule id` · `From` · `To` (date inputs)
- Button: `Apply filters`
- Heading: `Best and worst signals`
- `Best: {name (sample), …}` or `Best: Not enough closed trades yet.`
- `Worst: …` same empty text
- Heading: `Rule scorecards`
- Headers: `Rule`, `Mode`, `Trades`, `Win rate`, `Avg P&L %`, `Worst loss`
- Empty: `No score snapshots yet. They are computed daily after trades close.`
- Missing numeric cells: `—`
- Review card title: `{symbol} · {exitType} · {pnl} ({pnlPct})`
- Meta: `{mode} · {session} · held {holdMinutes} min · {addsCount} add(s){ optional " (helped)" or " (did not help)"} · {buyRule} · {sellRule}`
- Label: `Your note`
- Button: `Save note` · failure `Could not save the note.`
- Empty list: `No closed positions match these filters.`

Imported open holdings appear with `exitType` `imported`, buy rule `imported/manual`, and bot note: `Imported from the Robinhood account. No buy rule. No automatic sell rule or stop unless you assign a sell rule.`

### 6.9 Shared API / Worker error strings (surface in the error paragraph)

`Unknown host.` · `Refresh the page and try again.` (CSRF) · `A passkey is already registered. Use recovery to replace it.` · `Missing passkey response.` · `Registration expired. Start again.` · `Passkey was not accepted.` · `A passkey is already registered.` · `Sign-in expired. Start again.` · `Unknown passkey.` · `Sign in first.` · `Sign in with your passkey.` · `Unknown mode.` · `Could not save settings.` · `Could not save the Top 10.` · `Could not edit capital.` · `Could not edit the target or stop.` · `Could not create the rule.` · `Could not edit the rule.` · `Could not change the rule status.` · `TOKEN_KEY is not configured.` · `Robinhood sign-in could not start.` · `Not found.` · `Something went wrong.` · `Confirm with your passkey.` · `That code is not valid.` · `That code was already used.` · `Too many attempts. Try again later.` · `Authenticator app is not set up.` · `AUTH_KEY is not configured.` · `Recovery email could not be sent.` · `Setup expired. Start again.` · `Cloudflare Access is not configured.` · `Sign in through Cloudflare Access.` · `Cloudflare Access rejected this request.` · `Too many requests. Wait a minute and try again.` · `Passkey confirmation failed.`

Passkey step-up (client): on HTTP 403 with `stepUp: true`, the client prompts WebAuthn again; if that fails the user sees `Passkey confirmation failed.`

---

## 7. Rules contract

- Rules are **Buy** or **Sell**. Each has a name, plain-English `body`, and a list of signal ids.
- Statuses: `experimenting`, `proven`, `retired`. Displayed in the UI as those raw strings.
- **Only the user** can mark Proven or Retired (or move Proven back to Experimenting). The app never auto-approves.
- Live trading uses **only Proven** rules. If no Buy rule is Proven, live new buys stay idle; open trades keep the sell rules they already have.
- The Simulator, and dev, may run **any selected rules**, including Experimenting.
- Editing a **Proven** rule creates a **new Experimenting version**. Open trades **keep the rule version ids they started with**.
- Every create, edit, and status change is written to `rule_history` and the audit log.
- Creating a rule from the UI currently sends `signals: []`. The six draft seeds are created on first storage prepare with their signal lists (see below).
- Family id (`trading_rules.id`) is stable; `rule_versions.id` is what positions store as `buy_rule_version_id` / `sell_rule_version_id`.

### 7.1 Draft starter rules (verbatim bodies, all start Experimenting)

These are `DRAFT_RULES` in `src/lib/rules.ts`, seeded once when `trading_rules` is empty.

1. **First buy on strength** (`buy-first-strength`, buy). Signals: `price_above_20m_avg`, `volume_above_recent`, `spy_up`. Body: `Start a position when price is above the 20-minute average, volume is above recent normal, and SPY is up. Size is the 20% starter (2% of account balance).`
2. **Add on strength** (`buy-add-strength`, buy). Same signals. Body: `Add to an existing position when strength signals confirm. There is no fixed add count or size: stronger signals add more, weak signals add little or nothing, always inside the 10% cap.`
3. **Add on a healthy dip** (`buy-add-dip`, buy). Signals: `below_avg_cost`, `above_20m_low`, `no_sell_volume_spike`, `spy_not_falling_hard`. Body: `Add when price is below average cost but still above the 20-minute low, there is no volume spike on the selling, and SPY is not falling hard.`
4. **Take profit** (`sell-take-profit`, sell). Signals: none (uses Settings / position percentages). Body: `Sell when price is the profit-target percent in Settings above average cost. That percent has no fixed 0.1–3 bound; you set any positive value up to 100. May fire before the position is full.`
5. **Stop-loss** (`sell-stop-loss`, sell). Signals: none. Body: `Sell when price is the stop-loss percent below average cost. Off-hours, the app watches the stop every 5 minutes and sends a limit sell. That is not a resting broker stop.`
6. **Exit on weakness** (`sell-exit-weakness`, sell). Signals: `below_20m_avg`, `rising_volume`, `spy_falling`. Body: `Sell when price is below the 20-minute average on rising volume while SPY is falling.`

### 7.2 Signal catalog (exact definitions as implemented)

All built-in signals are seeded `active`. `description` in the `signals` table is currently set to the **name** (not a longer blurb). Windows use bars in the last **20 minutes** unless noted. Implementations: `src/lib/signals.ts`.

| id | Name | Fires when | Value | Notes |
| --- | --- | --- | --- | --- |
| `price_above_20m_avg` | Price above 20-minute average | `last > averagePrice(bars in 20m)` | `last − avg` (4 d.p.) | No fire if not enough history. |
| `volume_above_recent` | Volume above recent normal | `volume > averageVolume(20m)` | `volume / avg` | |
| `spy_up` | SPY is up | SPY day change `> 0` | change in **percent** | Day change prefers `(spyLast − spyPreviousClose) / spyPreviousClose × 100`; else first-to-last bar in a 24h SPY window. |
| `spy_falling` | SPY is falling | change `< 0` | change % | |
| `spy_not_falling_hard` | SPY is not falling hard | change `> -0.5` (percent) | change % | “Hard” is a drop of 0.5% or more. |
| `below_avg_cost` | Price below average cost | `last < averageCost` | `last − averageCost` | Requires a position average cost. |
| `above_20m_low` | Price above the 20-minute low | `last > lowPrice(20m)` | `last − low` | |
| `no_sell_volume_spike` | No volume spike on the selling | `volume ≤ 1.5 × averageVolume(20m)` | `volume / avg` | |
| `below_20m_avg` | Price below 20-minute average | `last < avg` | `last − avg` | |
| `rising_volume` | Rising volume | average volume of the second half of the 20m window `>` first half | `lastHalf / firstHalf` | Needs at least 2 bars. |

**Signal strength** used for add sizing: `firedCount / requiredCount`, clamped to `[0, 1]`. If none fired, `0`. (A source comment mentions “a small boost from their values”; the **code does not add that boost**.)

The catalog is pluggable (`registerSignal`). Unknown ids compute as not fired with reason `This signal type is not implemented yet.`

### 7.3 Built-in scorecards (not the planned 0–100 points)

Per rule family, from closed-trade P&L: trade count, win rate (wins / count, 3 d.p.), average profit, worst loss. Daily snapshots in `rule_score_snapshots` / `signal_score_snapshots` are computed at most once per 24 hours, and **skipped when there are no closed positions**. Imported open reviews use `exitType = imported` and are excluded from date-filtered scoring because `closed_at` is null.

The planned 40/25/20/15 point model is **not built**. See [§9](#9-planned-approved-not-built).

---

## 8. Holdings sync, live order records, and simulator auto-start

### 8.1 Holdings sync

Each **cron tick**, and when **Account Summary** or **Review** loads:

1. Read `get_equity_positions` (read-only) when a token exists; otherwise, if `ENVIRONMENT !== "prod"`, use the recorded TSLL fixture; if prod and disconnected, use an empty list.
2. Optionally read `get_equity_orders` when connected, and apply pending fills by `broker_order_id`.
3. Reconcile into D1 `positions` with `mode = 'live'` (`src/lib/holdings.ts`). Idempotent: the same holdings write nothing the second time.

Rules:

- A holding with no open live app row becomes an **imported** position: `source = imported`, qty and avg cost from Robinhood, Trading capital snapshot = effective capital at import, **no buy rule version** (UI: `imported/manual`), audit `live_import`, `position_capital_history` from 0 to the snapshot, a `trades` row with `source = broker_import`, and a `position_reviews` row with `exit_type = imported` so Review can show it while still open.
- Quantity changes made outside the app become `broker_qty_change` trades; a full disappear/sell-out closes the position (`broker_close`) and writes a close review. Re-buying the same symbol later opens a **new** position id.
- If the app already has an open live position for that symbol (imported or `source = app`), sync updates it; it does not create a second row.
- **Imported positions get no automatic sell-rule or stop actions** unless a sell rule is later assigned. There is **currently no UI to assign a sell rule** to a position. With `ALLOW_LIVE_TRADING=0`, nothing acts anyway.

### 8.2 Live order records

When the gated path successfully places an app-initiated live order, the app writes `positions` / `trades` with rule version ids (Proven buy/sell if present), signals when provided, capital snapshot, `broker_order_id`, and `source = app`. Retrying the same broker order id does not insert a second trade (`getTradeByBrokerOrderId`). Later fills are reconciled by that order id from `get_equity_orders` (`applyOrderFill`). A stop placed with the entry is recorded as a submitted sell trade with `exitReason = stop`.

### 8.3 Simulator auto-start

`tickSimulator` **no longer returns early** when there are no open sim positions. Cron always runs `cycleSimulator` (still respects Sell All, closed session, and quote quality). Score snapshots are skipped when nothing is closed. Manual **Run check** calls the same `cycleSimulator`.

### 8.4 `trade_signals` on every fill (built)

Every **buy, add, and exit** trade the app writes must also write `trade_signals` rows linked to that trade: `signal_id`, `value`, `threshold`, and `fired` (`passed` 0/1). Signals come from the rule that produced the fill (`computeSignals`). Settings-only exits (take-profit / stop-loss / Sell All) may have zero rows because those rules have no signal ids. Weakness exits store the three exit signals.

`threshold` is the decision cutoff in the **same units as `value`**:

| Signal | `value` | `threshold` | Fires when |
| --- | --- | --- | --- |
| `price_above_20m_avg` | last − 20m average | 0 | value > 0 |
| `volume_above_recent` | volume / 20m average volume | 1 | value > 1 |
| `spy_up` | SPY day change % | 0 | value > 0 |
| `spy_falling` | SPY day change % | 0 | value < 0 |
| `spy_not_falling_hard` | SPY day change % | −0.5 | value > −0.5 |
| `below_avg_cost` | last − average cost | 0 | value < 0 |
| `above_20m_low` | last − 20m low | 0 | value > 0 |
| `no_sell_volume_spike` | volume / 20m average volume | 1.5 | value ≤ 1.5 |
| `below_20m_avg` | last − 20m average | 0 | value < 0 |
| `rising_volume` | second-half avg volume / first-half | 1 | value > 1 |

Simulator `fillSimEntry` copies the computed signals onto `pendingLegs`, and `saveSim` / `insertTrade` persists them. The gated live path computes Proven first-buy signals **before** placing and skips the order unless they all fire (`allRequiredSignalsFired`, same rule as the simulator: an empty list is allowed; otherwise every required signal must have fired), auditing `live_skipped` with message `First-buy signals did not confirm.` `insertTrade` stores `id`, `name`, `value`, `threshold`, `fired`, and `reason`. `listTrades` reloads those fields (`passed` maps to `fired`). If `name` was not stored (rows written before migration `0006`), it is filled from the signal catalog (`getSignal(id).name`, else the id) and `reason` stays empty. `positionViews` forwards the same fields to the client as `trade.signals`, and the shared trades table renders them with `formatTradeSignalLine` as specified in [§6](#6-screens-and-exact-ui-copy).

Before this change, the prod NVDA simulator fills at 7:55 AM CST and 8:00 AM CST on 13 November 2026 had signals only on the `sim_entry` / `sim_add` audits and the proposal payloads. A backfill planner (`src/lib/trade-signals.ts`, `scripts/backfill-trade-signals.mjs`, `scripts/cf-templates/backfill-trade-signals.js`) reconstructs rows from those payloads. **Prod migration `0005` was applied at 8:26:53 AM CST** (pre-`0005` bookmark `0000009e-00000421-00005122-8bffaec3864d5a10a2b2344a5fcc94b5`). **Prod migration `0006` was applied at 8:45:27 AM CST** (pre-`0006` bookmark `000000a2-00000000-00005122-15227bc7e1bb4436c9211a513f305447`; Worker `a776d60f-86da-460e-8512-b1abaa079e3b` uploaded 8:45:31 AM CST; rollback `286f9178-e8f6-407f-b7c7-ab5cf6901144`). The owner approved the NVDA backfill at 8:43 AM CST. A dry-run with name and reason planned the same 6 rows for trades `3989afa2-7976-4b28-b703-4c5e0352a9a6` and `5aa49ca9-f1c4-4622-aef6-8e1f8f4a0359`; `apply=true` inserted 6 in the 8:45 AM CST window (3 rows each, including name and reason); a rerun planned 0.

---

### 8.5 Simulator persistence and D1 write reduction (built)

`saveSim` used to `DELETE` then re-`INSERT` every `quote_bars`, `proposals`, `sim_orders`, and `sim_selected_rules` row on every 5-minute tick, and always upserted every open position, inserted a `price_marks` row, and `UPDATE`d `app_settings`. On a mid-day book that became hundreds of D1 write statements per tick (and, on a long-running dev book, approached the per-invocation subrequest limit). The account-wide Workers Free D1 cap is 100,000 rows written per UTC day.

The persist planners in `src/lib/sim-persist.ts` now do this:

1. **`quote_bars`** — insert only new `(symbol, ts)` rows; prune with `DELETE FROM quote_bars WHERE ts < ?` using a 24-hour cutoff, and only when stale rows exist. The in-memory book still keeps a 24-hour window (or the 21 synthesized starter bars when a symbol has fewer than 10).
2. **`proposals`** — persist only the last **12** by `createdAt` (the same cap the Simulator “Latest check” list already showed). Existing kept rows are left in place; extras are deleted; only missing ids are inserted. `saveSim` also slices the in-memory list to this cap before saving.
3. **`sim_orders` / `sim_selected_rules`** — skip the write entirely when the stored set already matches; otherwise delete missing rows, update changed orders, and insert new ones.
4. Remaining writes run through `db.batch()` (MiniDb `batch` / `runWrites`) instead of one statement per round trip.
5. **`positions`** — `upsertPosition` no-ops when the stored row already matches (including `source`, defaulting to `"app"`).
6. **`price_marks`** — `insertPriceMark` no-ops when the latest mark for that position already has the same price.
7. **`app_settings`** — `saveSettings` no-ops when every persisted field is unchanged (same `saveSim` path; keeps a steady-state tick from rewriting the settings row).

`GET /api/session` is rate-limited in Worker memory (60 requests per minute per IP) and **does not write** `rate_limits`. Other routes still persist `rate_limits` in D1. A session request must stay a read so a D1 write-cap failure cannot 500 the first paint (which keeps `Loading…` and shows the error; see [§6.1](#61-document-and-chrome)).

Measured locally on a steady-state mid-window tick (10 symbols already stored with 60 bars each, one new bar per symbol, last 12 proposals already stored, 27 unchanged orders, 6 unchanged selected rules, 9 unchanged positions, 9 unchanged same-price marks, unchanged settings): **668 write statements before, 10 after** (`test/sim-persist.test.ts`). A real cron tick still inserts the `sim_cycle` `audit_index` row when the cycle finishes; holdings sync and daily scores write nothing when nothing changed.


## 9. Planned (approved, not built)

Mark these clearly in any rebuild: they are **agreed product direction**, not present in the code.

- **AI-created Experimenting rules**, marked AI-created, with stored reasoning.
- **AI suggestions** to approve winners and retire losers (any rule). The **user always decides**. No auto-Proven / auto-Retired.
- **Rule points 0–100**, recomputed daily: Profit 40%, Win rate 25%, Risk 20%, Confidence 15%. Suggest approve when score `> 70` for 2 weeks with `≥ 30` trades; suggest retire when `< 30`. Weights and thresholds live in Settings and are reviewed with the owner before they are locked in.
- **Weekly review**: Saturday 9:00 AM CST, of trades, metrics, settings, and tweaks. This is an agreed owner routine, not a cron job in the Worker.
- **churncapital.com** as a low-visibility subdomain later (domain move to Cloudflare is a separate ops step).
- **D1 now; later self-hosted Postgres with redundancy.** Application access stays behind the `Storage` interface (`src/lib/storage.ts`).
- **Emergency backend failover** (standby app + DB, Cloudflare redirect, trading paused, reconcile vs Robinhood, logged drill on dev): documented in [storage.md](storage.md), **not built**.
- Full **24/5 live** placement and live synthetic-stop / take-profit management against the broker (simulator already has 24/5).
- UI to **assign a sell rule** to an imported live position.
- Using `get_equity_tradability` for overnight eligibility once the output contract is captured.

---

## 10. Full schema (from migrations `0001`–`0006`)

Apply the numbered SQL files in order. Types are portable (`TEXT`, `INTEGER`, `REAL`); no SQLite-only types in these files. The v3 trading record is designed to move to Postgres later. Exact DDL is in `migrations/`. A fresh database is `0001` + `0002` + `0003` + `0004` + `0005` + `0006`. A v2 database needs `0003` + `0004` + `0005` plus the data backfill `migrateV2Data` in `src/worker/storage/migrate.ts` (copies legacy `rules` / `sim_positions` / `sim_trades` into `trading_rules` / `positions` / `trades` when those are empty, seeds signals, and backfills `trading_capital` from `cash` when capital is 0). Record each file in Wrangler’s `d1_migrations(id, name, applied_at)`.

`mode` on `positions` is `live` or `sim`. `source` on `positions` is `app` (default) or `imported`. `source` on `trades` is `app` (default), `broker_import`, `broker_qty_change`, or `broker_close`. Re-buying a sold-out symbol opens a **new** position row.

### 10.1 `0001_init.sql`

- **owner** — `id TEXT PK`, `email TEXT NOT NULL`, `created_at INTEGER NOT NULL`
- **credentials** — `id TEXT PK`, `owner_id TEXT NOT NULL`, `public_key TEXT NOT NULL`, `counter INTEGER NOT NULL`, `transports TEXT NOT NULL DEFAULT ''`, `created_at INTEGER NOT NULL`
- **challenges** — `id TEXT PK`, `kind TEXT NOT NULL`, `challenge TEXT NOT NULL`, `expires_at INTEGER NOT NULL`
- **sessions** — `token_hash TEXT PK`, `owner_id TEXT NOT NULL`, `expires_at INTEGER NOT NULL`, `stepup_until INTEGER NOT NULL DEFAULT 0`, `recovery INTEGER NOT NULL DEFAULT 0`; later `auth_method TEXT NOT NULL DEFAULT 'passkey'`, `stepup_method TEXT NOT NULL DEFAULT ''` (`0007`). `auth_method` is `passkey`, `totp`, or `recovery`.
- **magic_links** — `token_hash TEXT PK`, `email TEXT NOT NULL`, `expires_at INTEGER NOT NULL`, `used_at INTEGER`
- **totp** (`0007`) — `id INTEGER PK CHECK (id = 1)`, `secret_ct TEXT NOT NULL`, `secret_iv TEXT NOT NULL`, `last_step INTEGER NOT NULL DEFAULT 0`, `enabled INTEGER NOT NULL DEFAULT 0`, `failed_attempts INTEGER NOT NULL DEFAULT 0`, `locked_until INTEGER NOT NULL DEFAULT 0`, `enrolled_at INTEGER NOT NULL`. The TOTP secret is AES-GCM encrypted with Worker secret `AUTH_KEY`. `last_step` prevents code replay. Five invalid codes lock the row for 15 minutes.
- **totp_backup_codes** (`0007`) — `code_hash TEXT PK`, `used_at INTEGER`. Eight one-time backup codes, stored as SHA-256 of the normalized code, issued only at confirm.
- **app_settings** — `id INTEGER PK CHECK (id = 1)`, `profit_target_pct REAL NOT NULL`, `stop_loss_pct REAL NOT NULL`, `max_order_pct REAL NOT NULL`, `daily_loss_pct REAL NOT NULL`, `pdt_limit INTEGER NOT NULL`, `mode TEXT NOT NULL`, `killed INTEGER NOT NULL`, `day_start_equity REAL NOT NULL`, `day_start_date TEXT NOT NULL`, `cash REAL NOT NULL`, `account_number TEXT NOT NULL`
  Later: `order_cap INTEGER NOT NULL DEFAULT 100` (`0002`), `trading_capital REAL NOT NULL DEFAULT 0` (`0003`)
- **top10** — `rank INTEGER PK`, `symbol TEXT NOT NULL`
- **proposals** — `id TEXT PK`, `ref_id TEXT NOT NULL UNIQUE`, `symbol TEXT NOT NULL`, `verdict TEXT NOT NULL`, `message TEXT NOT NULL`, `payload TEXT NOT NULL`, `created_at INTEGER NOT NULL`
- **sim_orders** — `id TEXT PK`, `ref_id TEXT NOT NULL`, `symbol TEXT NOT NULL`, `side TEXT NOT NULL`, `type TEXT NOT NULL`, `quantity REAL NOT NULL`, `limit_price REAL`, `stop_price REAL`, `status TEXT NOT NULL`, `role TEXT NOT NULL`, `opened_on TEXT NOT NULL`, `created_at INTEGER NOT NULL`
- **sim_positions** — `symbol TEXT PK`, `quantity REAL NOT NULL`, `avg_cost REAL NOT NULL`, `opened_on TEXT NOT NULL`; later `buy_rule_id`, `buy_rule_version`, `sell_rule_id`, `sell_rule_version` (`0002`). Legacy; v3 open sim state is also in `positions` (`mode = sim`).
- **day_trades** — `id TEXT PK`, `symbol TEXT NOT NULL`, `day TEXT NOT NULL` (unused by the current guard)
- **oauth_state** — `state TEXT PK`, `verifier TEXT NOT NULL`, `redirect_uri TEXT NOT NULL`, `expires_at INTEGER NOT NULL`
- **rh_client** — `id INTEGER PK CHECK (id = 1)`, `client_id TEXT NOT NULL`, `token_endpoint TEXT NOT NULL`, `registration_endpoint TEXT NOT NULL`, `issuer TEXT NOT NULL`, `resource TEXT NOT NULL`
- **rh_tokens** — `id INTEGER PK CHECK (id = 1)`, `access_ct TEXT NOT NULL`, `access_iv TEXT NOT NULL`, `refresh_ct TEXT`, `refresh_iv TEXT`, `expires_at TEXT`, `lifetime_secs INTEGER`
- **rate_limits** — `key TEXT PK`, `hits INTEGER NOT NULL`, `window_start INTEGER NOT NULL`. Most rate-limited routes persist here. `GET /api/session` uses an in-memory bucket instead, so a D1 write cap cannot 500 the first paint.
- **audit_index** — `id TEXT PK`, `at INTEGER NOT NULL`, `action TEXT NOT NULL`, `detail TEXT NOT NULL`

### 10.2 `0002_v2.sql` (in addition to the alters above)

- **rules** — `id TEXT PK`, `family_id TEXT NOT NULL`, `name TEXT NOT NULL`, `side TEXT NOT NULL`, `body TEXT NOT NULL`, `signals TEXT NOT NULL`, `status TEXT NOT NULL`, `version INTEGER NOT NULL`, `created_at INTEGER NOT NULL`, `updated_at INTEGER NOT NULL` (legacy; v3 uses `trading_rules` + `rule_versions`)
- **rule_history** — `id TEXT PK`, `rule_id TEXT NOT NULL`, `family_id TEXT NOT NULL`, `action TEXT NOT NULL`, `from_status TEXT`, `to_status TEXT`, `version INTEGER NOT NULL`, `detail TEXT NOT NULL`, `at INTEGER NOT NULL`
- **sim_trades** — legacy closed-trade table (see the SQL file for columns)
- **sim_selected_rules** — `rule_id TEXT PK`
- **quote_bars** — `symbol TEXT NOT NULL`, `ts INTEGER NOT NULL`, `price REAL NOT NULL`, `volume REAL NOT NULL`, `PRIMARY KEY (symbol, ts)`

### 10.3 `0003_v3.sql`

- **signals** — `id TEXT PK`, `name TEXT NOT NULL`, `description TEXT NOT NULL`, `status TEXT NOT NULL`, `added_at INTEGER NOT NULL`; index `signals_status_idx (status)`
- **trading_rules** — `id TEXT PK` (family id), `side TEXT NOT NULL`, `name TEXT NOT NULL`, `status TEXT NOT NULL`, `created_at INTEGER NOT NULL`, `updated_at INTEGER NOT NULL`
- **rule_versions** — `id TEXT PK`, `rule_id TEXT NOT NULL` FK → `trading_rules(id)`, `version INTEGER NOT NULL`, `name TEXT NOT NULL`, `body TEXT NOT NULL`, `status TEXT NOT NULL`, `created_at INTEGER NOT NULL`, `updated_at INTEGER NOT NULL`; index `rule_versions_rule_idx (rule_id, version)`
- **rule_signals** — `rule_version_id TEXT NOT NULL` FK → `rule_versions(id)`, `signal_id TEXT NOT NULL` FK → `signals(id)`, `params TEXT NOT NULL`, `PRIMARY KEY (rule_version_id, signal_id)`
- **positions** — `id TEXT PK`, `mode TEXT NOT NULL`, `symbol TEXT NOT NULL`, `status TEXT NOT NULL`, `trading_capital_snapshot REAL NOT NULL`, `profit_target_pct REAL NOT NULL`, `stop_loss_pct REAL NOT NULL`, `buy_rule_version_id TEXT` FK → `rule_versions(id)`, `sell_rule_version_id TEXT` FK → `rule_versions(id)`, `avg_cost REAL NOT NULL`, `qty REAL NOT NULL`, `opened_at INTEGER NOT NULL`, `closed_at INTEGER`; indexes `positions_mode_status_idx (mode, status)`, `positions_symbol_idx (symbol)`
- **trades** — `id TEXT PK`, `position_id TEXT NOT NULL` FK → `positions(id)`, `rule_version_id TEXT` FK → `rule_versions(id)`, `side TEXT NOT NULL`, `qty REAL NOT NULL`, `limit_price REAL`, `fill_price REAL`, `session TEXT NOT NULL`, `bid_at_order REAL`, `ask_at_order REAL`, `capital_snapshot REAL NOT NULL`, `size_reason TEXT NOT NULL`, `exit_reason TEXT`, `broker_order_id TEXT`, `status TEXT NOT NULL`, `created_at INTEGER NOT NULL`; index `trades_position_idx (position_id)`
- **trade_signals** — `trade_id TEXT NOT NULL` FK → `trades(id)`, `signal_id TEXT NOT NULL` FK → `signals(id)`, `value REAL`, `passed INTEGER NOT NULL`, `PRIMARY KEY (trade_id, signal_id)`. Later: `threshold REAL` (`0005`); `name TEXT` and `reason TEXT` (`0006`).
- **price_marks** — `id TEXT PK`, `position_id TEXT NOT NULL` FK → `positions(id)`, `at INTEGER NOT NULL`, `price REAL NOT NULL`; index `price_marks_position_at_idx (position_id, at)`
- **position_reviews** — `position_id TEXT PK` FK → `positions(id)`, `pnl_dollars REAL NOT NULL`, `pnl_pct REAL NOT NULL`, `hold_minutes INTEGER NOT NULL`, `exit_type TEXT NOT NULL`, `best_price REAL`, `worst_price REAL`, `spy_change_at_entry REAL`, `session_at_entry TEXT`, `spread_cost REAL`, `adds_count INTEGER NOT NULL`, `adds_helped INTEGER`, `bot_note TEXT NOT NULL`, `user_note TEXT`, `created_at INTEGER NOT NULL`
- **position_capital_history** — `id TEXT PK`, `position_id TEXT NOT NULL` FK → `positions(id)`, `old_value REAL NOT NULL`, `new_value REAL NOT NULL`, `at INTEGER NOT NULL`; index `position_capital_history_idx (position_id, at)`
- **position_exit_settings_history** — `id TEXT PK`, `position_id TEXT NOT NULL` FK → `positions(id)`, `field TEXT NOT NULL`, `old_value REAL NOT NULL`, `new_value REAL NOT NULL`, `at INTEGER NOT NULL`; index `position_exit_settings_history_idx (position_id, at)`
- **rule_score_snapshots** — `id TEXT PK`, `period_start INTEGER NOT NULL`, `period_end INTEGER NOT NULL`, `mode TEXT NOT NULL`, `rule_id TEXT` FK → `trading_rules(id)`, `rule_version_id TEXT` FK → `rule_versions(id)`, `trades INTEGER NOT NULL`, `win_rate REAL`, `avg_pnl_pct REAL`, `worst_loss REAL`, `net_after_costs REAL`, `computed_at INTEGER NOT NULL`; index `rule_score_snapshots_period_idx (mode, period_end)`
- **signal_score_snapshots** — `id TEXT PK`, `period_start INTEGER NOT NULL`, `period_end INTEGER NOT NULL`, `mode TEXT NOT NULL`, `signal_id TEXT NOT NULL` FK → `signals(id)`, `win_rate_true REAL`, `avg_pnl_true REAL`, `sample_true INTEGER NOT NULL`, `win_rate_false REAL`, `avg_pnl_false REAL`, `sample_false INTEGER NOT NULL`, `computed_at INTEGER NOT NULL`; index `signal_score_snapshots_period_idx (mode, period_end, signal_id)`

### 10.4 `0004_live_sync.sql`

- `ALTER TABLE positions ADD COLUMN source TEXT NOT NULL DEFAULT 'app';`
- `ALTER TABLE trades ADD COLUMN source TEXT NOT NULL DEFAULT 'app';`
- `CREATE INDEX IF NOT EXISTS positions_mode_symbol_status_idx ON positions (mode, symbol, status);`
- `CREATE INDEX IF NOT EXISTS trades_broker_order_idx ON trades (broker_order_id);`

The Worker also has `ensureLiveSync()` to add `source` at runtime if a database was opened before `0004` was applied. Prefer applying the migration and recording it in `d1_migrations`.

### 10.5 `0005_trade_signals_threshold.sql`

- `ALTER TABLE trade_signals ADD COLUMN threshold REAL;`

The Worker has `ensureTradeSignalsSchema()` to add `threshold`, `name`, and `reason` at runtime if those columns are missing. Prefer applying the numbered migrations and recording them in `d1_migrations`. Existing rows stay `NULL` until a new fill overwrites them or the backfill script is applied. Prod `0005` and `0006` are applied, and the NVDA backfill for the 7:55 / 8:00 AM CST sim fills is applied (3 rows each, including name and reason).

### 10.6 `0006_trade_signals_name_reason.sql`

- `ALTER TABLE trade_signals ADD COLUMN name TEXT;`
- `ALTER TABLE trade_signals ADD COLUMN reason TEXT;`

Relationships (v3 trading core): `trading_rules` 1—N `rule_versions` 1—N `rule_signals` N—1 `signals`; `positions` 1—N `trades` 1—N `trade_signals`; `positions` 1—N `price_marks`, `position_capital_history`, `position_exit_settings_history`; `positions` 1—0..1 `position_reviews`.

---

## 11. API routes

CSRF: non-GET `/api/*` (except listed auth and callback paths) require the CSRF token issued by `GET /api/csrf`. Rate limits apply (for example reads 120/min). `GET /api/session` is the exception that uses an in-memory bucket and does not write D1. Authenticated API (except `/api/auth/*`, `/api/health`, `/api/csrf`, `/api/session`, `/api/robinhood/callback`) requires a non-recovery app session (opened with a passkey or with TOTP/backup code) and rejects a recovery-only session with `Sign in with your passkey.`

**Step-up** (5 minutes, error `Confirm with your passkey.`, `stepUp: true`) is required for: `POST /api/mode` (when switching to live), `/api/settings`, `/api/top10`, `/api/positions/:id/exits`, `/api/rules`, `/api/rules/:id`, `/api/rules/:id/status`, `/api/robinhood/connect`, `/api/robinhood/disconnect`, and `/api/auth/totp/disable`. A valid passkey or, if TOTP is enrolled, a valid authenticator or backup code satisfies this step-up. **Enrollment and re-enrollment** (`/api/auth/totp/begin` and `/confirm`) require a *passkey* session plus a fresh *passkey* step-up (`stepUpMethod: "passkey"`), so TOTP cannot be enrolled from a TOTP-only session.

**Not** step-up: Sell All, resume, cycle, simulator cycle, **Edit capital**, review notes, robinhood complete, reads.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | `{ ok: true }` |
| GET | `/api/csrf` | Issue CSRF cookie/token |
| GET | `/api/session` | Auth state (`authenticated`, `registered`, `recovery`, `stepUp`, `totpEnabled`, and `authMethod` when signed in). Rate-limited in Worker memory (60/min per IP); does **not** write D1 `rate_limits`. |
| POST | `/api/auth/register/options` and `verify` | WebAuthn register |
| POST | `/api/auth/login/options` and `verify` | WebAuthn login or step-up (`stepUp: true`) |
| POST | `/api/auth/login/totp` | TOTP sign-in or step-up (`stepUp: true`). Rate-limited 5/min per IP; five invalid codes lock TOTP for 15 minutes. |
| POST | `/api/auth/login/backup` | One-time backup-code sign-in or step-up (`stepUp: true`). Same rate limit and lockout. |
| POST | `/api/auth/totp/begin` | Start enrollment: returns `otpauthUri` and `setupKey` once. Requires passkey step-up. Pending secret lives in `challenges` (`kind = totp_enroll`) for 10 minutes, encrypted. |
| POST | `/api/auth/totp/confirm` | Confirm enrollment with a valid app code; issues eight backup codes once. Requires passkey step-up. |
| POST | `/api/auth/totp/disable` | Delete the TOTP row and backup codes. Requires ordinary step-up. |
| POST | `/api/auth/logout` | Clear session |
| POST | `/api/auth/recovery` | If the address is the owner, issue a 15-minute magic link. On localhost, log the raw token and return `{ ok: true, delivery: "log" }`. On a deployed host, send the mail with the `EMAIL` binding (`send_email`, `destination_address` `tom2258@gmail.com`, from `noreply@{ZONE}`) and return `{ ok: true, delivery: "email" }` only after a successful send; otherwise `503` `Recovery email could not be sent.` Never claim `delivery: "email"` when nothing was sent. A non-matching address returns `{ ok: true }` with no `delivery`. The raw token is never logged outside localhost. |
| GET | `/api/auth/recovery/consume` | Consume link, start recovery session, redirect `/?recovery=1` or `/?recovery=invalid` |
| GET | `/api/summary` | Account Summary payload (triggers holdings sync) |
| POST | `/api/cycle` | Account cycle (live entries only if the gate is on) |
| POST | `/api/kill` | Sell all sim + set killed (legacy path; UI uses `/api/sell-all`) |
| POST | `/api/resume` | `killed = 0`, mode back to `view_only` |
| POST | `/api/mode` | `{ mode: "view_only" or "live" }` |
| POST | `/api/settings` | Save caps |
| POST | `/api/top10` | `{ symbols: string[] }` |
| GET | `/api/simulator` | Simulator view |
| POST | `/api/simulator/cycle` | Run a sim cycle with optional `ruleIds` |
| POST | `/api/simulator/select` | Persist selected rule ids |
| POST | `/api/sell-all` | `{ confirm: true }` |
| POST | `/api/positions/:id/capital` | `{ amount, confirm: true }` |
| POST | `/api/positions/:id/exits` | `{ profitTargetPct?, stopLossPct? }` |
| GET | `/api/reviews` | Query: `rule`, `symbol`, `session`, `from`, `to`, `mode` (triggers holdings sync) |
| POST | `/api/reviews/:positionId/note` | `{ userNote }` |
| GET | `/api/rules` | Current rules |
| POST | `/api/rules` | Create |
| POST | `/api/rules/:id` | Edit |
| POST | `/api/rules/:id/status` | `{ status }` |
| GET | `/api/rules/:familyId/history` | History |
| POST | `/api/robinhood/connect` | Start OAuth, returns `{ url }` |
| GET | `/api/robinhood/pending` | Pending connect window |
| POST | `/api/robinhood/disconnect` | Delete stored tokens |
| POST | `/api/robinhood/complete` | `{ callbackUrl }` |
| GET | `/api/robinhood/callback` | Loopback helper (local) |

The SPA is served for `GET` of unknown paths (embedded `index.html`). Cron is `scheduled` → `tickSimulator`.

Default Top 10 on seed: `AAPL`, `MSFT`, `NVDA`, `AMZN`, `GOOGL`, `META`, `AVGO`, `TSLA`, `JPM`, `LLY`.

---

## 12. Cron flow (step by step)

1. Cloudflare invokes the Worker `scheduled` handler every 5 minutes.
2. It gets Durable Object `TRADER` id `"owner"` and calls `tickSimulator()` (waitUntil).
3. `seed()`: `ensureV2`, `ensureLiveSync`, insert default `app_settings` + Top 10 if missing, `seedDraftRules`.
4. `syncLiveHoldings()`: load holdings (MCP or fixture / empty), load orders if connected, apply pending fills, compute effective Trading capital, `reconcileLiveHoldings`, persist and audit.
5. `cycleSimulator()`: `quoteBook()` (live quotes for Top 10 **and open live/sim symbols**, else recorded book), `runSimulatorCycle`, save sim state incrementally as in [§8.5](#85-simulator-persistence-and-d1-write-reduction-built) (`quote_bars` append + 24h prune, last 12 `proposals`, no-op skips for unchanged orders/rules/positions/marks/settings, `db.batch()` for the remaining writes), audit each sim event and `sim_cycle`.
6. If there is at least one **closed** position, `maybeComputeScores()` (no more often than daily).

Account Summary `summary()` and Review `reviewScreen()` also `seed` + `syncLiveHoldings`. `cycle()` on the account path may `proposeLiveEntries` only if the live gate is `"1"`.

---

## 13. Audit events

Each event is a row in `audit_index` and, when R2 succeeds, an object `audit/YYYY-MM-DD/<uuid>.json`. Details are passed through `redactJson` (secret-looking keys stripped; long digit runs masked to last 4).

Actions written by the Worker include: `cycle`, `sim_cycle`, `sell_all`, `resume`, `mode`, `settings`, `top10`, `rule_created`, `rule_edited`, `rule_approved`, `rule_status`, `position_capital`, `position_exits`, `review_note`, `live_import`, `live_qty_change`, `live_broker_close`, `live_avg_cost`, `live_order`, `live_stop_order`, `live_stop_failed`, `live_failed`, `live_fill`, `live_skipped` (reasons `off_hours_live_not_armed`, `not_connected`), `holdings_failed`, `orders_failed`, `quotes_failed`, `robinhood_token_unreadable`, `robinhood_read_failed`, `refresh`, `refresh_failed`, `robinhood_disconnected`, `sim_rules_selected`, plus whatever action strings the simulator emits for entries, adds, and exits (those are audited as `event.action`).

---

## 14. Robinhood MCP tools and contracts

Input schemas live in `docs/contracts/robinhood/schemas/`. Recorded payloads (account numbers omitted or masked) live in `docs/contracts/robinhood/fixtures/`. Outgoing args are validated; unknown properties are rejected.

**Read tools** (`READ_TOOLS`): `get_accounts`, `get_portfolio`, `get_equity_positions`, `get_equity_quotes`, `get_equity_orders`, `get_equity_tradability`, `get_realized_pnl`, `get_pnl_trade_history`.

**Actually called by the Worker today:** `get_accounts`, `get_portfolio`, `get_realized_pnl` (account snapshot), `get_equity_quotes` (quote book), `get_equity_positions` (holdings sync), `get_equity_orders` (fill reconcile). When the live gate is on: `review_equity_order`, `place_equity_order`.

**Schemas exist but the Worker does not call them:** `get_equity_tradability`, `get_pnl_trade_history`. `cancel_equity_order` is listed as a gated tool name but is **always refused**.

OAuth: dynamic client registration + PKCE, redirect `http://127.0.0.1:47621/callback`. Connect is passkey-gated. The user approves on Robinhood, lands on a loopback error page, and pastes the address. State is single-use, 10 minutes. Tokens encrypted with `TOKEN_KEY`. Refresh is attempted when close to expiry; 400/401 refresh deletes stored tokens.

Masking: `maskAccountNumber` shows `••••` + last 4 (or `••••` if length ≤ 4). UI Account field uses the masked value only.

---

## 15. Security rules

- One owner. Access policy is that mailbox only. **No Access bypass, no service tokens, no “everyone.”** Never add a service token to reach prod or dev without a new, explicit owner decision (the current design forbids it).
- When `ACCESS_ENFORCE` is `"1"`, every request must carry `Cf-Access-Jwt-Assertion`. The Worker verifies RS256, `iss`, `aud` (must contain `ACCESS_AUD`), `exp`, and `email === OWNER_EMAIL`. If team or audience is empty while enforcement is on, return **503**, do not skip the check.
- Passkey is the primary app session (12 hours, `__Host-session`). An enrolled authenticator-app TOTP (or a one-time backup code) may open the same 12-hour session or satisfy the 5-minute step-up. Enrollment requires an existing passkey session and a fresh passkey step-up; the setup QR / `otpauth` URI and backup codes are shown once. The `otpauth` issuer is the `TOTP_ISSUER` binding and the label is `<issuer>:<owner email> (<HOSTNAME>)` — on deployed dev, issuer `churntop10 Dev` and label `churntop10 Dev:tom2258@gmail.com (desk-dev.churncapital.com)`; on prod, issuer `churntop10` and label `churntop10:tom2258@gmail.com (top10.ycashlabs.com)`. The TOTP secret is encrypted at rest with `AUTH_KEY`. Codes are 6 digits, 30-second SHA-1 TOTP, ±1 step, with replay blocked via `last_step`. Five invalid attempts lock TOTP for 15 minutes. Recovery email is only for replacing a passkey (15-minute link) and must actually be sent on deployed hosts; a recovery session still cannot trade or call authenticated APIs. Passkeys are tied to the request hostname (WebAuthn RP ID). After a hostname change, register a new passkey on the new host and re-add the authenticator app; the `__Host-session` cookie also does not move across hosts.
- **No real Robinhood orders** (place, cancel, modify) without the owner’s **explicit confirmation of that specific order**. `ALLOW_LIVE_TRADING` stays `"0"` unless they clearly say to turn it on.
- Do not deploy to prod or change prod without an explicit go-ahead.
- Secrets (`TOKEN_KEY`, `AUTH_KEY`, tokens, cookies, TOTP secrets, recovery tokens, passwords) only in Worker secrets / encrypted or hashed D1 columns, never in git, issues, or chat logs. Audit redaction as above.
- **Mask account numbers to last 4** in UI, logs, fixtures, docs, and conversation.
- Dev and prod stay separate. Dev should not hold a live Robinhood token.
- The bundle must remain eval-free.

---

## 16. Build, test, deploy, migrate, and rollback from zero

Detailed commands and current ids: [DEPLOY.md](../DEPLOY.md), [ROLLBACK.md](../ROLLBACK.md), [dev.md](dev.md), [prod.md](prod.md), [ACCESS.md](ACCESS.md), and the living ops snapshot in [HANDOVER.md](HANDOVER.md). Condensed rebuild:

1. **Cloudflare account and zone.** Workers, D1, R2, Access, and a custom domain on the environment’s zone (`churncapital.com` for the canonical desk hosts, `ycashlabs.com` still used for aliases and for Email Sending).
2. **Create, per environment:** D1 database, R2 audit bucket, Worker, Workers Custom Domain, Access application (Include → Emails → owner only, short session is fine). Record the Access audience.
3. **Apply migrations** `0001`–`0007` in order via the D1 query API (one statement at a time is safest). Create `d1_migrations` and insert each filename so Wrangler will not replay them. Take a Time Travel bookmark **before** migrating an existing prod database.
4. **Set bindings** exactly as in the tables in [dev.md](dev.md) / [prod.md](prod.md): D1, R2, DO `AccountTrader`, `send_email` binding `EMAIL` restricted to `tom2258@gmail.com`, plain-text vars including `ALLOW_LIVE_TRADING=0`, `ACCESS_ENFORCE=1`, `ENVIRONMENT`, Access team and audience, `OWNER_EMAIL`, canonical `HOSTNAME`, optional `ALLOWED_HOSTS` aliases, `TOTP_ISSUER` (`churntop10 Dev` on dev, `churntop10` on prod), and `ZONE` (`ycashlabs.com` for the From address). Create a **new** `TOKEN_KEY` and a **new** `AUTH_KEY` (`openssl rand -base64 32` each) as Worker **secrets** per environment. Onboard `ycashlabs.com` to Cloudflare Email Sending so `noreply@ycashlabs.com` can send.
5. **Build:** `npm install && npm run lint && npm run typecheck && npm test && npm run build && npm run check:html && npm run check:bundle && npm run check:design`. `npm run build` embeds the UI into `dist/index.js`.
6. **Upload** the Worker with `multipart/form-data` (metadata JSON + `index.js` module). **No `assets` binding.** Pass `keep_bindings: ["secret_text"]` so `TOKEN_KEY` and `AUTH_KEY` are not dropped. Abort the upload if `ALLOW_LIVE_TRADING` is not `"0"` or if an assets binding is present. Confirm cron `*/5 * * * *`.
7. **Local:** `cp .dev.vars.example .dev.vars`, set `TOKEN_KEY` and `AUTH_KEY`, `npm run dev`, open http://localhost:8787, create a passkey, walk Simulator / Settings. Access is off locally. Recovery links are logged, not emailed, on localhost.
8. **Rollback Worker code** using the previous version id ([ROLLBACK.md](../ROLLBACK.md)). This does **not** undo D1 rows, R2 objects, or DO storage. You cannot run an older Worker that expects a schema the DB no longer has if you also need to “un-migrate”; plan bookmarks before migrations. An older Worker can often run against *added* nullable/default columns; a newer Worker must not be pointed at a DB that lacks `0004` unless `ensureLiveSync` has run.
9. **Promote to prod** only with an explicit go-ahead: bookmark, apply and record `0004` if needed, merge, upload to `churntop10-prod` with the same method, verify bindings and Access, leave the live gate at `"0"`. After the first cron or Account Summary load, prod will import **real** Robinhood holdings (not the dev fixture). Update [HANDOVER.md](HANDOVER.md) with the new version ids and state in the same change.

---

## 17. Decision log

Dates are America/Chicago unless noted. All of the following were agreed 13 November 2026 unless stated.

| When | Decision |
| --- | --- |
| 13 Nov 2026 | Keep the app simple and focused on profit. Rules-based, not free-form AI. The app trades on cron; assistants only build/operate. |
| 13 Nov 2026 | Six screens: Account Summary (real account only), Top 10, Rules, Simulator, Review, Settings. |
| 13 Nov 2026 | “Kill Switch” renamed **Sell All Positions**: confirm, stop new buys, simulated sells only while the live gate is off. |
| 13 Nov 2026 | Top 10 limits **new first buys** only; existing positions stay managed. |
| 13 Nov 2026 | 24/5 trading in the simulator: new buys in every weekday session; off-hours are limit-only; synthetic stop; skip wide spread / stale quotes; overnight whole shares on the eligible list; closed Fri 8:00 PM–Sun 8:00 PM ET; holidays not modeled. |
| 13 Nov 2026 | Percentage sizing only: 10% cap, 20% starter (2% of snapshot), signal-sized adds, no dollar min/max, sells unlimited. Profit target and stop are any positive % of average cost ≤ 100. |
| 13 Nov 2026 | Trading capital is a fixed dollar amount, snapshotted per position, Edit capital logged, `min(capital, real equity)`, exposure cap. |
| 13 Nov 2026 | Safety: daily loss % of Trading capital, order cap, buying power only, no margin. **PDT cap removed** (FINRA Notice 26-10; Robinhood removed PDT). |
| 13 Nov 2026 | Rules: Experimenting / Proven / Retired; only the user marks Proven; version on edit; open trades keep versions; live uses Proven only; simulator may run any selected rules. Draft starter rules recorded as Experimenting. |
| 13 Nov 2026 | Schema through `Storage` interface; D1 now; Postgres later; failover documented, not built. |
| 13 Nov 2026 | Live gate stays `"0"` until explicit approval. No real orders without confirming the specific order. |
| 13 Nov 2026 | v3 deployed to prod (PR #7 / merge `f53af3e`); see [prod.md](prod.md) for version ids and the pre-`0003` Time Travel bookmark. |
| 13 Nov 2026 | Holdings sync, live order records, simulator auto-start (PR #8). Migration `0004`. Promoted to prod the same day (merge `252b479`, Worker `1259682e-103a-491f-a6dd-9ab2b69f589a`). See [HANDOVER.md](HANDOVER.md). |
| 13 Nov 2026 | Persist `trade_signals` (id, value, threshold, fired) on every buy/add/exit. Migration `0005` applied on prod at 8:26:53 AM CST (Worker `286f9178-…`, rollback `1259682e-…`). |
| 13 Nov 2026 | Restore signal `name`/`reason` on `listTrades` (migration `0006`), require live `proposeLiveEntries` signals to fire before placing (same `allRequiredSignalsFired` rule as the simulator), and show stored signals on the trades table with the §6 wording. Promoted to prod the same day (merge `1376f96`, Worker `a776d60f-86da-460e-8512-b1abaa079e3b`, rollback `286f9178-…`). `0006` applied at 8:45:27 AM CST (pre-`0006` bookmark `000000a2-00000000-00005122-15227bc7e1bb4436c9211a513f305447`). The NVDA 7:55 / 8:00 AM CST backfill was applied in the 8:45 AM CST window (6 rows; rerun inserts 0). |
| 13 Nov 2026 | If the session request fails, the first paint keeps `Loading…` and also shows the error (API `error`, else `Request failed.` or `Could not load.`). Promoted to prod the same day with the write-reduction work (PR #11, merge `e5a6667`, Worker `851a1db9-e7bd-4c52-972f-fc03a6a826d8`, rollback `a776d60f-…`). |
| 13 Nov 2026 | Cut D1 writes on the cron path: incremental `quote_bars` plus a 24h prune; cap stored `proposals` to the last 12; skip no-op `sim_orders` / `sim_selected_rules` / `app_settings` rewrites; `db.batch()` remaining writes; skip unchanged position upserts and same-price `price_marks`; take `GET /api/session` off the `rate_limits` table (in-memory 60/min per IP). Locally measured steady-state saveSim statements dropped from 668 to 10. Promoted to prod the same day (merge `e5a6667`, Worker `851a1db9-e7bd-4c52-972f-fc03a6a826d8`, rollback `a776d60f-…`). Prod cron had been paused at 10:49:47 AM CST and was restored to `*/5 * * * *` at 11:32:01 AM CST after the upload. No new D1 migration. The account is on Workers Paid (owner upgrade; do not change the plan further without explicit approval). |
| 13 Nov 2026 | Authenticator-app TOTP as an alternative to the in-app passkey for sign-in and step-up (RDP cannot complete the phone passkey). Enrollment only from a passkey session plus a fresh passkey step-up. Secret encrypted with `AUTH_KEY`. One-time hashed backup codes. Replay and lockout as in §11. Recovery email actually sends on deployed hosts via the `EMAIL` binding and must not claim `delivery: "email"` when nothing was sent. Promoted to prod the same day after an explicit go-ahead at 7:45 PM CST (merge `0fb67e7`, Worker `eff70b4a-c102-465d-9a13-c4c57949455b` after `AUTH_KEY` was set, script upload `48e5f77c-…` at 7:49:42 PM CST, rollback `851a1db9-…`). Migration `0007` applied on prod at **7:49:18 PM CST** (pre-`0007` bookmark `00000128-00000000-00005123-cf7fe1bb7ecb3d63673d0544b96c5593`). At promotion, `ycashlabs.com` was not yet onboarded to Email Sending, so recovery on deployed hosts would return `503` `Recovery email could not be sent.` until onboarding (completed later that evening; see the next row). |
| 13 Nov 2026 | Cloudflare Email Sending onboarded for `ycashlabs.com`. DNS verified at **8:29 PM CST**: `cf-bounce.ycashlabs.com` MX (`route1`/`route2`/`route3.mx.cloudflare.net`) and SPF (`v=spf1 include:_spf.mx.cloudflare.net ~all`), and DKIM TXT at `cf-bounce._domainkey.ycashlabs.com` (selector `cf-bounce`, so `d=ycashlabs.com`). Apex `_dmarc` remains `v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s`; apex SPF remains `v=spf1 -all`. Strict DKIM alignment should pass with From `noreply@ycashlabs.com`; strict SPF alignment likely will not (envelope typically `cf-bounce.ycashlabs.com`), so DMARC can still pass on DKIM. The owner triggered one recovery email on dev (POST `/api/auth/recovery`) at **8:35:07 PM CST** and confirmed it arrived in Gmail at **8:36 PM CST** with no errors. Dev D1 had exactly one unused hashed magic link and one `recovery` audit row; credentials and sessions were unchanged; Worker logs had no `recovery_email_failed`. Prod runs the same Worker script; no recovery was sent on prod. |
| 13 Nov 2026 | Cloudflare Access for team `dawn-rice-07a4`: One-time PIN (`9f7436ed-2228-4fa3-863e-da8c93127752`) was added to `allowed_idps` on both the prod app (`8f553625-0283-41e0-8a63-c43789e8c3a5`) and the dev app (`d0a5f257-6f03-4bfc-b8a4-d104a7180e06`), alongside the existing Cloudflare IdP (`8a3b677e-fc9d-4d0d-a8b0-99d9fcd3fa48`). `auto_redirect_to_identity` stayed `false`. Policies were left unchanged and owner-only for `tom2258@gmail.com` (no bypass, no service tokens). This Access change is already live; it is not a substitute for the in-app passkey or TOTP. |
| 13 Nov 2026 (planned, not built) | AI-created Experimenting rules; AI approve/retire suggestions; rule points 0–100 with the weights in [§9](#9-planned-approved-not-built); weekly Saturday 9:00 AM CST review. |
| 14 Nov 2026 | Move the app onto `churncapital.com`. Canonical dev host is https://desk-dev.churncapital.com; https://top10-dev.ycashlabs.com stays attached during the transition. `HOSTNAME` / `ALLOWED_HOSTS` drive the allowlist and recovery-link base URL; WebAuthn RP ID stays the request host. Email `ZONE` stays `ycashlabs.com`. Dev Worker **`b0794cc1-411f-4586-82f3-e965fa943699`** uploaded 3:31:59 AM CST (rollback `a066fe5b-…`). Prod stays https://top10.ycashlabs.com until an explicit go-ahead, then the same pattern with https://desk.churncapital.com. Passkeys and TOTP must be re-enrolled on the new RP ID. The `churncapital.com` apex is the owner's iCloud+ custom-domain mailbox (MX `mx01`/`mx02.mail.icloud.com`, TXT `apple-domain=…` and `v=spf1 include:icloud.com ~all`, CNAME `sig1._domainkey`); do not modify or remove those records. App hosts on that zone are `desk` / `desk-dev` only. Recovery email still sends from `noreply@ycashlabs.com`. |
| 14 Nov 2026 | Repository transferred from `ycashlabs/churntop10` to `churndev/churntop10` at about 4:50 AM CST (old URL redirects; the name stayed `churntop10`, not `churn-top-10`). Docs, `package.json` `repository`, and PR links use the new URL. The Cursor GitHub App is installed on `churndev`. CI checkout uses `fetch-depth: 0` so the design check can resolve `merge-base` on push. Deploys remain wrangler from the box; prod was not changed. |
| 14 Nov 2026 | Authenticator-app `otpauth` issuer and label are config-driven (`TOTP_ISSUER` plus `HOSTNAME`) so dev and prod entries are not identical. Verbatim: dev issuer `churntop10 Dev`, label `churntop10 Dev:tom2258@gmail.com (desk-dev.churncapital.com)`; prod issuer `churntop10`, label `churntop10:tom2258@gmail.com (top10.ycashlabs.com)`. Local issuer `churntop10 Local`. Already-enrolled authenticator entries keep the old name until the owner sets up again. Dev Worker **`840beac0-66b8-4520-9839-898d739add99`** uploaded 4:19:26 AM CST (rollback `b0794cc1-…`). Prod was not uploaded. |

---

## 18. Maintenance rule

Any change to this product updates **this file in the same PR**. That includes new UI copy, a new setting, a schema column, a guard message, a cron step, or a safety rule. Supporting docs (spec, sessions, storage, DEPLOY, ACCESS, dev, prod) are updated when their subject changes, and must stay consistent with this file.

**[HANDOVER.md](HANDOVER.md)** is the living takeover snapshot (environments, resource ids, secret *locations*, current deploy state, open PRs, pending owner decisions, routines). Update it in the same PR whenever wrangler config, migrations, deploy scripts, routines-related docs, or env/bindings change — and whenever current state or a pending decision changes. CI (`npm run check:design`) fails the PR if those ops files change and `docs/HANDOVER.md` does not, and if `src/`, `migrations/`, or wrangler config change and `docs/DESIGN.md` does not.

Agents: [AGENTS.md](../AGENTS.md).

---

## 19. Doc vs code mismatches

These are accurate observations of the current tree. A rebuild should implement the **code** behavior unless a later decision explicitly changes it; do not silently “fix” these in a clone and claim identity.

1. **Live 24/5 vs simulator 24/5.** The simulator implements 24/5 entries and the synthetic stop. `proposeLiveEntries` (gated live path) **only runs in the regular session** and there is **no live exit engine** against broker orders. [sessions.md](sessions.md) already notes that off-hours live work needs a follow-up.
2. **“Assign a sell rule”** is promised for imported positions in copy and in this design, but **no UI or API assigns a sell rule** to an existing position.
3. **Simulator help** still says stops are watched “normally every 5 minutes **when a position is open**.” Cron now also cycles when there are **no** open sim positions (auto-start).
4. **`signalStrength` comment** mentions a boost from signal values; the function is only `fired / required`.
5. **Settings percent inputs** use HTML `min={0}`; the server requires `> 0`.
6. **Legacy columns** `pdt_limit` and `max_order_pct` and table `day_trades` still exist and are **unused** by the buy guard.
7. **Dev connect path.** Design intent: dev never holds a live token. The same OAuth UI and `TOKEN_KEY` binding exist on dev; a token *can* be saved if someone uses Connect there. Do not.
8. **MCP tools** `get_equity_tradability` and `get_pnl_trade_history` have schemas but are not called. `cancel_equity_order` is always refused.
9. **[spec-v2.md](spec-v2.md)** still opens with “Five screens”; v3 added Review (six). This file is authoritative.
10. **[sessions.md](sessions.md)** says “Every entry is a limit order for whole shares, priced at the ask.” **Regular hours allow fractional** shares. Entries are limits priced at the ask; size is whole-share only off regular hours.
11. **[ACCESS.md](ACCESS.md)** still says “kill switch” and that “changing caps” always asks for the passkey. Sell All is the current name and uses confirm, not a passkey. **Settings → Save caps** is step-up; **Edit capital** on a position is confirm only, no step-up.
12. **[prod.md](prod.md)** originally described `tickSimulator` returning when there were no open sim positions; that was true of the v3 Worker before PR #8. Prod now runs the auto-start plus trade_signals / signal-views / TOTP Worker (`eff70b4a-…`; rollback `851a1db9-…`). Keep prod.md aligned with [HANDOVER.md](HANDOVER.md).
13. **Creating a rule in the UI** sends an empty signal list. Draft seeds have signals; user-created rules do not get a signal picker yet.
14. **Rule status in the stamp** is lowercase raw (`experimenting`), not “Experimenting.”
15. **Signal `description`** stored in D1 is a copy of the name.

End of design.
