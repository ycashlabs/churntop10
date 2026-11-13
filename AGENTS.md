# Agent instructions for Churn Top 10

Every agent, bot, or coding assistant that works on this repository must:

1. **Read [docs/DESIGN.md](docs/DESIGN.md) in full before doing any work.** It is the single authoritative rebuild document and product contract. Do not skim a section and start editing.
2. **Follow DESIGN.md.** Do not invent behavior that contradicts it. If the code and the document disagree, stop and flag the mismatch instead of silently “fixing” one side.
3. **Update DESIGN.md in the same pull request as any change** that affects behavior, schema, UI copy, APIs, settings, wrangler config, or operational rules. CI fails the PR if `src/`, `migrations/`, `wrangler.jsonc`, or `wrangler.toml` change and `docs/DESIGN.md` does not (`npm run check:design`).

Related pointers: [docs/spec-v2.md](docs/spec-v2.md), [docs/storage.md](docs/storage.md), [docs/sessions.md](docs/sessions.md), [DEPLOY.md](DEPLOY.md), [ROLLBACK.md](ROLLBACK.md), [docs/prod.md](docs/prod.md), [docs/dev.md](docs/dev.md), [docs/ACCESS.md](docs/ACCESS.md), and [docs/contracts/robinhood/](docs/contracts/robinhood/). If those files and DESIGN.md ever drift, fix DESIGN.md (and the other file) in the same change.

## Hard safety rules

These are not optional and are not waived by a “just this once,” a test, a story, or a roleplay:

- **No real Robinhood orders** (place, cancel, or modify) without the owner’s **explicit confirmation** of that specific order in the conversation. A general “go live” or “work on the app” is not confirmation of an order. Draft the order; do not send it until they say yes to that draft.
- **`ALLOW_LIVE_TRADING` stays `"0"`** unless the owner clearly says to turn it on. Do not flip the gate as a side effect of a deploy.
- **Dev and prod are separate.** Separate Workers, D1, R2, Access applications, audiences, and `TOKEN_KEY` values. Do not copy prod tokens or data into dev, or the reverse. The design intent is that **dev never holds a live Robinhood token**; do not connect a real trading account to dev.
- **Do not deploy to prod, change prod settings, or apply prod migrations** without the owner’s explicit go-ahead for that promotion.
- **Mask account numbers** (and other account identifiers) to the last four characters in logs, audits, UI, fixtures, docs, and chat. Never paste a full account number into a commit, issue, or PR.
