# Churn Top 10

A single-owner trading app. It reads the real Robinhood account through the Trading MCP. Fake-money trading lives on a separate Simulator screen. Live real-money trading stays off until you explicitly approve it (`ALLOW_LIVE_TRADING` is `0`).

Five screens: Account Summary (real Robinhood account only), Top 10, Rules, Simulator, and Settings. Settings holds the profit target and stop-loss (both percent of average cost), the daily loss stop, the daily order cap, the Live / View Only switch, and Sell All Positions. There are no buy amount fields; sizing is the 20% starter (2% of balance), signal-sized adds, and a 10% per-symbol cap. The PDT day-trade cap is removed.

The product contract is [docs/spec-v2.md](docs/spec-v2.md). Session and synthetic-stop rules are in [docs/sessions.md](docs/sessions.md).

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
npm test
npm run build
npm run check:html
```

CI runs those on every push.

## Layout

- `docs/spec-v2.md` — product contract (built, still iterative)
- `docs/sessions.md` — 24/5 sessions and the synthetic stop
- `docs/contracts/robinhood/` — MCP input schemas, required and optional response fields, recorded payloads
- `src/lib/` — decoder, OAuth helpers, order builder, signals, sizing, simulator, deterministic guards
- `src/worker/` — Hono Worker, Access check, passkey, Durable Object `AccountTrader`, embedded UI
- `src/client/` — the five screens

The proposal, the guard, and the broker are separate. The guard is pure and tested. The broker throws `live_trading_disabled` unless `ALLOW_LIVE_TRADING` is `1`, and it refuses cancel and modify tools even then.
