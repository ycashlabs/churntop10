# Churn Top 10

A single-owner account summary and Top 10 list. It reads Robinhood through the Trading MCP and, until you deliberately arm it, it trades only in a local simulator fed by recorded quotes.

Two screens: Account Summary and Top 10. Settings holds the profit target (0.1–3% of account balance), the stop-loss percent, the order cap, the daily loss stop, the Live / View Only switch, and the kill switch. The app starts in View Only. `ALLOW_LIVE_TRADING` is `0`.

## Local

```bash
npm install
cp .dev.vars.example .dev.vars
openssl rand -base64 32   # paste into TOKEN_KEY
npm run dev
```

Open http://localhost:8787, create a passkey, and run a check from Top 10. Switch to Live (the passkey is asked again) and run the check again to see a simulated fill. No Robinhood order is sent.

`npm run build` writes `dist/index.js` and `dist/assets/`. See [DEPLOY.md](DEPLOY.md), [ROLLBACK.md](ROLLBACK.md), and [docs/ACCESS.md](docs/ACCESS.md).

The agreed product redesign (not yet built) is in [docs/spec-v2.md](docs/spec-v2.md). This README describes the app as it runs today.

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

- `docs/spec-v2.md` — agreed v2 redesign (not yet built)
- `docs/contracts/robinhood/` — MCP input schemas, required and optional response fields, recorded payloads
- `src/lib/` — decoder, OAuth helpers, order builder, deterministic guards
- `src/worker/` — Hono Worker, Access check, passkey, Durable Object `AccountTrader`
- `src/client/` — the two screens and Settings

The proposal, the guard, and the broker are separate. The guard is pure and tested. The broker throws `live_trading_disabled` unless `ALLOW_LIVE_TRADING` is `1`, and it refuses cancel and modify tools even then.
