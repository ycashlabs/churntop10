# Churn Top 10

A single-owner trading app. It reads the real Robinhood account through the Trading MCP. Fake-money trading lives on a separate Simulator screen. Live real-money trading stays off until you explicitly approve it (`ALLOW_LIVE_TRADING` is `0`).

Six screens: Account Summary (real Robinhood account only), Top 10, Rules, Simulator, Review, and Settings. Settings holds Trading capital (a fixed dollar amount, with 10% quick-fills of the current balance), the profit target and stop-loss (defaults for new positions, both percent of average cost), the daily loss stop (a percent of Trading capital), the daily order cap, the Live / View Only switch, and Sell All Positions. There are no buy amount fields; sizing is the 20% starter (2% of the position’s Trading capital snapshot), signal-sized adds, and a 10% per-symbol cap on that snapshot. The PDT day-trade cap is removed.

The authoritative rebuild document is [docs/DESIGN.md](docs/DESIGN.md). Every behavior, schema, or UI change must update it in the same PR. Current environments and pending decisions are in [docs/HANDOVER.md](docs/HANDOVER.md). The conformance checklist is [docs/TEST-PLAN.md](docs/TEST-PLAN.md). Session and synthetic-stop rules are also in [docs/sessions.md](docs/sessions.md). The older iterative contract is [docs/spec-v2.md](docs/spec-v2.md).

## Local

```bash
npm install
cp .dev.vars.example .dev.vars
openssl rand -base64 32   # paste into TOKEN_KEY
npm run dev
```

Open http://localhost:8787, create a passkey, edit the Top 10, review the Rules screen, and run a check from the Simulator. No Robinhood order is sent.

`npm run build` writes `dist/index.js` with the HTML, JS, and CSS embedded in the Worker, so a deploy does not depend on the separate assets-upload JWT. See [DEPLOY.md](DEPLOY.md), [ROLLBACK.md](ROLLBACK.md), and [docs/ACCESS.md](docs/ACCESS.md).

## Checks

```bash
npm run lint
npm run typecheck
npm test          # runs check:design, then unit tests
npm run build
npm run check:html
npm run check:bundle
```

CI already runs lint, typecheck, test, build, and check:html. `npm test` starts with `node scripts/check-design.mjs`, which fails if `src/`, `migrations/`, or wrangler config change without `docs/DESIGN.md`, or if ops/env files change without `docs/HANDOVER.md`. A dedicated Actions job with a full git history is in [docs/ci-design-job.pending.yml](docs/ci-design-job.pending.yml) and needs a GitHub token with the `workflow` scope before it can be added to `.github/workflows/`.

## Layout

- `docs/DESIGN.md` — authoritative rebuild document (update in the same PR as any change)
- `docs/HANDOVER.md` — environments, resource ids, current state, first-day checklist
- `docs/TEST-PLAN.md` — conformance checklist against DESIGN.md
- `docs/spec-v2.md` — earlier product contract (v2 and v3, still iterative)
- `docs/storage.md` — storage interface, D1-now / Postgres-later, emergency failover (not built)
- `docs/sessions.md` — 24/5 sessions and the synthetic stop
- `docs/contracts/robinhood/` — MCP input schemas, required and optional response fields, recorded payloads
- `src/lib/` — decoder, OAuth helpers, order builder, signals, sizing, simulator, deterministic guards
- `src/worker/` — Hono Worker, Access check, passkey, Durable Object `AccountTrader`, embedded UI
- `src/client/` — the six screens

The proposal, the guard, and the broker are separate. The guard is pure and tested. The broker throws `live_trading_disabled` unless `ALLOW_LIVE_TRADING` is `1`, and it refuses cancel and modify tools even then.
