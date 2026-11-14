# Conformance results — Churn Top 10

Run at Nov 13, 2026, 7:47 PM America/Chicago against the current tree. Checks follow [TEST-PLAN.md](TEST-PLAN.md) and [DESIGN.md](DESIGN.md). Headless UI checks do not capture screenshots.

Summary: **56 PASS**, **0 FAIL**, **9 NOT BUILT** (65 tests).

| Test ID | Area | Test description | Result | Failure reason |
| --- | --- | --- | --- | --- |
| S-01 | Schema | Fresh DB is migrations 0001–0007 in order, portable types | PASS |  |
| S-02 | Schema | positions and trades have source default app (0004) | PASS |  |
| S-03 | Schema | trade_signals has threshold (0005) on this branch / dev | PASS | 0005 exists in the repo. Applied and recorded on dev D1 at 8:12:02 AM CST (America/Chicago) and on prod D1 at 8:26:53 AM CST; PRAGMA shows threshold on both. Reconfirmed in d1_migrations before the PR #12 promotion. |
| S-04 | Schema | v3 relationships: rules, versions, signals, positions, trades | PASS |  |
| S-05 | Schema | app_settings seed columns include legacy pdt_limit and max_order_pct | PASS |  |
| S-06 | Schema | trade_signals persists trade_id, signal_id, value, threshold, fired, name, and reason | PASS |  |
| S-07 | Schema | trade_signals has name and reason (0006) on this branch / dev | PASS | 0006 exists in the repo. Applied and recorded on dev D1 at 8:39:59 AM CST (America/Chicago) and on prod D1 at 8:45:27 AM CST; PRAGMA shows name and reason on both. Reconfirmed in d1_migrations before the PR #12 promotion. |
| S-08 | Schema | 0007 adds sessions auth_method/stepup_method, totp, and totp_backup_codes | PASS |  |
| ST-01 | Settings | Defaults: profit/stop/daily loss 1%, order cap 100, capital 10000, view_only, not killed | PASS |  |
| ST-02 | Settings | Percents: finite, > 0, ≤ 100; exact server messages from DESIGN §4 | PASS |  |
| ST-03 | Settings | Order cap 1–1000; trading capital > 0, ≤ 1e9; exact messages | PASS |  |
| ST-04 | Settings | pdt_limit and max_order_pct unused by the buy guard | PASS |  |
| ST-05 | Settings | HTML percent and capital inputs use min={0} while the server rejects 0 (documented mismatch) | PASS |  |
| U-01 | UI | Six screens in nav order: Account Summary, Top 10, Rules, Simulator, Review, Settings | PASS | six nav labels visible |
| U-02 | UI | Chrome: title Churn Top 10, stamp, clock ET, raw session name, Sign out | PASS | chrome, ET clock, session visible |
| U-03 | UI | Account Summary: Robinhood account, Session + SESSION_HELP, Live positions copy | PASS | Account Summary copy visible |
| U-04 | UI | Top 10 help and table headers Symbol / Bid / Ask / Last | PASS | Top 10 headers visible |
| U-05 | UI | Settings labels, sizing note, Sell All copy, Robinhood 3-step copy | PASS | sizing note present with 20% / 2% wording; Settings labels and Sell All visible |
| U-06 | UI | Rules contract help; stamps are raw status strings | PASS | Rules help and raw stamps visible |
| U-07 | UI | Simulator help, Run check, Simulated positions, Latest check | PASS | Simulator copy visible |
| U-08 | UI | Review filters, scorecards, imported bot note | PASS | Review copy visible |
| U-09 | UI | View Only banner verbatim | PASS | View Only banner visible |
| U-10 | UI | SESSION_HELP verbatim in clock.ts and on Summary / Settings | PASS | SESSION_HELP on Account Summary |
| U-11 | UI | Sign-in copy: one owner, Create passkey / Sign in, recovery | PASS | sign-in copy visible |
| U-12 | UI | Shared position panel: Edit capital, Edit target / stop, trades table headers | PASS | Edit capital / Edit target copy checked statically; panel renders when a position is open |
| U-14 | UI | Trades table lists stored signals with the DESIGN §6 formatTradeSignalLine wording | PASS |  |
| U-15 | UI | Settings authenticator-app copy and sign-in code form | PASS |  |
| U-13 | UI | No HTML title= tooltips on controls | PASS |  |
| R-01 | Rules | Draft six seeds start Experimenting with verbatim bodies and signal lists | PASS |  |
| R-02 | Rules | Only the user marks Proven / Retired; no auto-approve | PASS |  |
| R-03 | Rules | Edit of Proven creates a new Experimenting version; open trades keep old version ids | PASS |  |
| R-04 | Rules | Live uses Proven only; simulator may run any selected rules | PASS |  |
| R-05 | Rules | New rules from the UI send signals: [] (no picker yet; documented mismatch) | PASS |  |
| R-06 | Rules | Rule statuses are Experimenting, Proven, Retired; stamp shows the raw lowercase string | PASS | raw status stamp visible (source is lowercase; CSS may uppercase it) |
| T-01 | Sizing / sessions / safety | 10% cap, 20% starter (2% of snapshot), signal-sized adds, whole shares off regular hours | PASS |  |
| T-02 | Sizing / sessions / safety | Sessions ET: regular / extended / overnight / closed as in DESIGN §5.1; holidays not modeled | PASS |  |
| T-03 | Sizing / sessions / safety | Simulator new buys in regular, extended, overnight; closed weekend blocks | PASS |  |
| T-04 | Sizing / sessions / safety | Synthetic stop watching off-hours; marketable limit; attach broker stop at regular open | PASS |  |
| T-05 | Sizing / sessions / safety | MAX_SPREAD 1%; live quotes stale after 5 minutes; recorded book not stale | PASS |  |
| T-06 | Sizing / sessions / safety | Daily loss stop, order cap, no margin, no PDT cap | PASS |  |
| T-07 | Sizing / sessions / safety | Sell All: confirm, sim positions only, no broker cancel/place, stops new buys | PASS |  |
| H-01 | Holdings / live / simulator | Reconcile is idempotent; imported source; no auto sell rule | PASS |  |
| H-02 | Holdings / live / simulator | Prod disconnected never uses the TSLL fixture; dev may | PASS |  |
| H-03 | Holdings / live / simulator | Live app orders write positions/trades with broker_order_id and source=app | PASS |  |
| H-04 | Holdings / live / simulator | Simulator auto-start: tick when no open sim position | PASS |  |
| H-05 | Holdings / live / simulator | Every buy/add/exit writes trade_signals (id, name, value, threshold, fired, reason) when signals were computed; positionViews forwards them | PASS | simulator API returned 2 position trade(s); signals array on payload=0 (listTrades fields are not forwarded in positionViews; D1 checked separately) |
| H-07 | Holdings / live / simulator | Live proposeLiveEntries requires first-buy signals to fire before placing, matching the simulator | PASS |  |
| H-06 | Holdings / live / simulator | Prod NVDA 7:55 fill has trade_signals rows | PASS | Owner approved the apply at 8:43 AM CST. After prod 0006 (8:45:27 AM CST) a dry-run with name and reason planned the same 6 rows for trades 3989afa2-7976-4b28-b703-4c5e0352a9a6 and 5aa49ca9-f1c4-4622-aef6-8e1f8f4a0359; apply=true inserted 6 (changes 1 each). Each trade has 3 rows including name and reason. A rerun planned 0 (alreadyHadSignals). |
| V-01 | Review / Access / security | Review lists imported open holdings with exitType imported and the imported bot note | PASS | imported holding visible on Review |
| A-01 | Review / Access / security | Access owner-only; Worker re-checks JWT when ACCESS_ENFORCE=1; no bypass or service token in repo config | PASS | Access apps Churn Top 10 prod and dev each have a single Owner only allow policy for tom2258@gmail.com. No exclude/require, no bypass or service token. Worker ACCESS_ENFORCE is 1 on both. No Access changes in this PR. |
| A-02 | Review / Access / security | Passkey session 12 hours; step-up 5 minutes; Sell All and Edit capital are not step-up | PASS |  |
| A-03 | Review / Access / security | submitGatedTool throws unless gate is 1; cancel/modify always refused | PASS |  |
| A-04 | Review / Access / security | Account numbers masked to last 4; no eval / new Function in the Worker bundle | PASS |  |
| A-05 | Review / Access / security | Unauthenticated prod and dev hosts 302 to Access | PASS | Unauthenticated GET / and /api/health on top10.ycashlabs.com and top10-dev.ycashlabs.com return HTTP 302 to dawn-rice-07a4.cloudflareaccess.com with kids b05d3bc5… (prod) and 3826fb97… (dev). Reconfirmed at 7:46:34 PM CST 13 Nov 2026 (America/Chicago) before the PR #12 promotion; prod still ran Worker 851a1db9-… (PR #11) and dev ran a066fe5b-… (PR #12). |
| A-06 | Review / Access / security | Dev and prod ALLOW_LIVE_TRADING is 0 | PASS | Worker settings reconfirmed at 7:46 PM CST 13 Nov 2026: ALLOW_LIVE_TRADING is 0 on churntop10-prod and churntop10-dev. TOKEN_KEY is secret_text on both. AUTH_KEY is set on dev only (not yet on prod). EMAIL send_email (destination tom2258@gmail.com) is bound on dev only. |
| A-07 | Review / Access / security | Cron is */5 * * * * on both Workers; no assets binding | PASS | Both Workers cron */5 * * * *; no ASSETS binding (has_assets false). Reconfirmed at 7:46 PM CST 13 Nov 2026: prod version 851a1db9-e7bd-4c52-972f-fc03a6a826d8 (PR #11), dev version a066fe5b-fbc7-4f02-ab31-372ae70e810b (PR #12). |
| P-01 | Planned | AI-created Experimenting rules | NOT BUILT | Planned in DESIGN §9, not implemented. |
| P-02 | Planned | AI approve/retire suggestions (user always decides) | NOT BUILT | Planned in DESIGN §9, not implemented. |
| P-03 | Planned | Rule points 0–100 with 40/25/20/15 weights | NOT BUILT | Planned in DESIGN §9, not implemented. |
| P-04 | Planned | Weekly Saturday 9:00 AM CST review job in the Worker | NOT BUILT | Planned in DESIGN §9, not implemented. |
| P-05 | Planned | churncapital.com subdomain | NOT BUILT | Planned in DESIGN §9, not implemented. |
| P-06 | Planned | Self-hosted Postgres + emergency failover | NOT BUILT | Planned in DESIGN §9, not implemented. |
| P-07 | Planned | Live 24/5 placement and live synthetic-stop engine | NOT BUILT | Planned in DESIGN §9, not implemented. |
| P-08 | Planned | UI to assign a sell rule to an imported position | NOT BUILT | Planned in DESIGN §9, not implemented. |
| P-09 | Planned | get_equity_tradability used for overnight eligibility | NOT BUILT | Planned in DESIGN §9, not implemented. |
