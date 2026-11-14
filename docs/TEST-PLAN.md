# Conformance test plan — Churn Top 10

Each item is a checkable statement from [DESIGN.md](DESIGN.md). Results are **PASS**, **FAIL**, or **NOT BUILT** (planned, not in the code). One row per item is recorded in [TEST-RESULTS.md](TEST-RESULTS.md) with columns: Test ID, Area, Test description, Result, Failure reason.

How to run:

- Automated and static: `npm test` (includes `check:design`) plus `node scripts/conformance.mjs`.
- Dev UI: headless walk against local wrangler (`ACCESS_ENFORCE=0`). Checks rendered copy and layout. **Do not capture screenshots.**
- Prod: **read-only** only (D1 selects, Worker settings, Access, unauthenticated HTTP). No settings changes, no migrations, no Worker uploads, no Robinhood orders.

Execute on the current code after the `trade_signals` fix. Fix FAILs on **dev only**. Prod FAILs that need a deploy or migration wait for go-ahead.

Times are America/Chicago.

## Schema

| ID | Statement | Check |
| --- | --- | --- |
| S-01 | Fresh DB is migrations 0001–0007 in order, portable types | `test/migrate.test.ts`; files in `migrations/` |
| S-08 | `0007` adds `sessions.auth_method` / `stepup_method`, `totp`, and `totp_backup_codes` | migrate test; `migrations/0007_auth_totp.sql` |
| S-02 | `positions` and `trades` have `source` default `app` (0004) | migrate test; PRAGMA on dev; prod already has 0004 |
| S-03 | `trade_signals` has `threshold` (0005) | migrate test; PRAGMA on dev and prod (0005 applied) |
| S-04 | v3 relationships: rules, versions, signals, positions, trades | migrate test; DESIGN §10 |
| S-05 | `app_settings` seed columns include legacy `pdt_limit` and `max_order_pct` | seed SQL / migrate test |
| S-06 | `trade_signals` persists `trade_id`, `signal_id`, `value`, `threshold`, `fired`, plus `name` and `reason` after 0006 | `test/trade-signals.test.ts`; schema |
| S-07 | `trade_signals` has `name` and `reason` (0006) on this branch / dev | migrate test; PRAGMA on dev after 0006; not on prod until go-ahead |

## Settings and validation

| ID | Statement | Check |
| --- | --- | --- |
| ST-01 | Defaults: profit/stop/daily loss 1%, order cap 100, capital 10000, view_only, not killed | seed / settings source |
| ST-02 | Percents: finite, > 0, ≤ 100; exact server messages from DESIGN §4 | `validExitPct`; `saveSettings` messages |
| ST-03 | Order cap 1–1000; trading capital > 0, ≤ 1e9; exact messages | validator / trader source and tests |
| ST-04 | `pdt_limit` and `max_order_pct` unused by the buy guard | `validateNewBuy` source / tests |
| ST-05 | HTML percent and capital inputs use `min={0}` while the server rejects 0 | App.tsx (documented mismatch, expected) |

## UI copy and layout

| ID | Statement | Check |
| --- | --- | --- |
| U-01 | Seven screens in nav order: Account Summary, Top 10, Live Positions, Simulator, Review, Rules, Settings | `src/client/nav.ts`; headless walk |
| U-02 | Chrome: title Churn Top 10, stamp, clock ET, raw session name, Sign out | App.tsx; walk |
| U-03 | Account Summary: Robinhood account, Session timeline; Live positions copy on `/positions` | App.tsx; walk |
| U-04 | Top 10 help and table headers Symbol / Bid / Ask / Last | App.tsx; walk |
| U-05 | Settings labels, sizing note, Sell All copy, Robinhood 3-step copy | App.tsx; walk |
| U-06 | Rules contract help; stamps are raw status strings | App.tsx; walk |
| U-07 | Simulator help, Run check, Simulated positions, Latest check | App.tsx; walk |
| U-08 | Review filters, scorecards, imported bot note | App.tsx; walk |
| U-09 | View Only banner verbatim | App.tsx; walk |
| U-10 | SESSION_HELP verbatim in clock.ts and on Settings; Summary shows the one-line stop note | source; walk |
| U-11 | Sign-in copy: one owner, Create passkey / Sign in, recovery | App.tsx; walk |
| U-12 | Shared position table: one Edit dialog, trades table headers inside the expansion | App.tsx |
| U-13 | No `title=` tooltips on controls | App.tsx |
| U-14 | Trades table lists stored signals with the DESIGN §6 `formatTradeSignalLine` wording | App.tsx; `test/trade-signals.test.ts`; headless walk when a trade is visible |

## Rules lifecycle

| ID | Statement | Check |
| --- | --- | --- |
| R-01 | Draft six seeds start Experimenting with verbatim bodies and signal lists | rules seed / v2 tests |
| R-02 | Only the user marks Proven / Retired; no auto-approve | no worker auto-status |
| R-03 | Edit of Proven creates a new Experimenting version; open trades keep old version ids | rules storage / trader |
| R-04 | Live uses Proven only; simulator may run any selected rules | `hasProvenBuyRule`; simulator `selected()` |
| R-05 | New rules from the UI send `signals: []` (no picker yet) | App.tsx (documented mismatch, expected) |
| R-06 | Rule statuses are Experimenting, Proven, Retired; stamp shows the raw lowercase string | App.tsx |

## Sizing, sessions, synthetic stop, safety, Sell All

| ID | Statement | Check |
| --- | --- | --- |
| T-01 | 10% cap, 20% starter (2% of snapshot), signal-sized adds, whole shares off regular hours | `test/v2.test.ts`, `test/sessions.test.ts`, sizing |
| T-02 | Sessions ET: regular / extended / overnight / closed as in DESIGN §5.1; holidays not modeled | `test/sessions.test.ts` |
| T-03 | Simulator new buys in regular, extended, overnight; closed weekend blocks | sessions tests |
| T-04 | Synthetic stop watching off-hours; marketable limit; attach broker stop at regular open | sessions “simulator cycles” tests |
| T-05 | MAX_SPREAD 1%; live quotes stale after 5 minutes; recorded book not stale | exits / trading tests / source |
| T-06 | Daily loss stop, order cap, no margin, no PDT cap | validator tests |
| T-07 | Sell All: confirm, sim positions only, no broker cancel/place, stops new buys | `sellAllSimPositions`; confirm string |

## Holdings sync, live recording, simulator, trade_signals

| ID | Statement | Check |
| --- | --- | --- |
| H-01 | Reconcile is idempotent; imported source; no auto sell rule | `test/holdings.test.ts` |
| H-02 | Prod disconnected never uses the TSLL fixture; dev may | trader holdings path; ENVIRONMENT check |
| H-03 | Live app orders write positions/trades with broker_order_id and source=app | holdings tests |
| H-04 | Simulator auto-start: tick when no open sim position | holdings `shouldTickSimulator` test |
| H-05 | Every buy/add/exit writes `trade_signals` (id, name, value, threshold, fired, reason) when signals were computed; `positionViews` forwards them | `test/trade-signals.test.ts`; local sim cycle; `/api/simulator` payload |
| H-07 | Live `proposeLiveEntries` requires first-buy signals to fire before placing, matching the simulator | `test/trade-signals.test.ts`; trader source |
| H-06 | Prod NVDA 7:55 fill has `trade_signals` rows | read-only prod D1 (expects none until go-ahead) |

## Review, Access, security

| ID | Statement | Check |
| --- | --- | --- |
| V-01 | Review lists imported open holdings with exitType imported and the imported bot note | holdings / reviews code; UI copy |
| A-01 | Access owner-only (`tom2258@gmail.com`); no bypass or service token; Worker re-checks JWT when ACCESS_ENFORCE=1 | security tests; read-only Access policy |
| A-02 | Passkey session 12 hours; step-up 5 minutes on the listed routes; Sell All and Edit capital are not step-up | http.ts / index.ts |
| A-03 | `submitGatedTool` throws unless gate is `"1"`; cancel/modify always refused | `test/trading.test.ts` |
| A-04 | Account numbers masked to last 4; no eval / new Function in the Worker bundle | mask tests; `check:bundle` |
| A-05 | Unauthenticated prod and dev hosts 302 to Access | curl (read-only) |
| A-06 | Dev and prod `ALLOW_LIVE_TRADING` is `"0"` | Worker settings (read-only) |
| A-07 | Cron is `*/5 * * * *` on both Workers; no `assets` binding | Worker settings (read-only) |

## Planned (expect NOT BUILT)

| ID | Statement |
| --- | --- |
| P-01 | AI-created Experimenting rules |
| P-02 | AI approve/retire suggestions (user always decides) |
| P-03 | Rule points 0–100 with 40/25/20/15 weights |
| P-04 | Weekly Saturday 9:00 AM CST review job in the Worker |
| P-05 | churncapital.com subdomain |
| P-06 | Self-hosted Postgres + emergency failover |
| P-07 | Live 24/5 placement and live synthetic-stop engine |
| P-08 | UI to assign a sell rule to an imported position |
| P-09 | `get_equity_tradability` used for overnight eligibility |

## Results

The filled table is [TEST-RESULTS.md](TEST-RESULTS.md). It is regenerated by `npm run conformance` (optional overlays `CONFORMANCE_UI` and `CONFORMANCE_ENV`). Headless UI checks do not capture screenshots.
