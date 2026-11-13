# Storage and failover

This is the data-access and recovery contract for Churn Top 10. The product rules are in [spec-v2.md](spec-v2.md) (including the v3 section).

## Database plan

Stay on **Cloudflare D1** until the trading system works. D1 is the only backend implemented today.

Long term, move to **self-hosted Postgres we control, with redundancy**. The application talks to the database only through the storage interface in `src/lib/storage.ts`. The D1 implementation lives in `src/worker/storage/d1.ts`. A Postgres implementation can be added later and selected by configuration, without rewriting trading, rules, or the UI.

Migrations are the numbered SQL files in `migrations/`. They use standard types, foreign keys, and indexes, and avoid SQLite-only tricks so they can be translated to Postgres. Applying `0001` through `0004` builds a fresh database. `0003` plus the data backfill in `src/worker/storage/migrate.ts` upgrades a v2 database (positions, trades, rules, and settings) to the v3 schema. `0004_live_sync.sql` adds portable `source` text columns on `positions` and `trades` (default `app`) and indexes on `(mode, symbol, status)` and `trades.broker_order_id`, for Robinhood holdings sync and live order records. Apply `0004` before deploying a Worker that writes those columns, and record it in `d1_migrations`.

## Storage interface

Every read or write of application data (settings, positions, trades, signals, rules, reviews, score snapshots, price marks, capital and exit-setting history) goes through `Storage`. Workers, the Durable Object, and tests should not issue ad-hoc SQL against those tables. Auth, CSRF, OAuth token, and Access helper tables may still be handled next to the Worker’s session code; trading records must not.

## Emergency failover (long-term, not built)

This plan is agreed so it can be implemented when the trading system is already working on Postgres. It is **not built** in the current app.

1. Keep a **standby backend** (application + database) and a **Postgres we control**, replicated, ready to take traffic.
2. Switch public traffic with a **Cloudflare redirect** (or an equivalent route change) from the old origin to the standby.
3. **Trading is paused** for the duration of the switch: no new buys, and no exits other than those already in flight at the broker. `Sell All Positions` and live order placement stay blocked until the owner resumes.
4. **Reconcile positions against Robinhood** (quantities, open orders, cash and buying power) before trading is allowed to resume. Differences are logged and must be resolved or accepted by the owner.
5. The switch itself is **logged** (when it started, when traffic moved, when reconcile finished, when trading resumed).
6. Run **periodic drills on dev** — the same steps against the dev Worker and a dev Postgres — so the runbook is practiced before a production emergency.

Until this is built, the recovery path remains the existing [DEPLOY.md](../DEPLOY.md) and [ROLLBACK.md](../ROLLBACK.md) for the D1 Worker.
