import * as esbuild from "esbuild";
import Ajv from "ajv";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { knownTools, validateOutgoing } from "../src/lib/requests.js";
import { validateSchema, type JsonSchema } from "../src/lib/schema.js";

describe("schema interpreter", () => {
  it("matches Ajv on every tool schema for accepted and rejected payloads", () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    for (const tool of knownTools()) {
      const schema = JSON.parse(readFileSync(new URL(`../docs/contracts/robinhood/schemas/${tool}.json`, import.meta.url), "utf8")) as JsonSchema;
      const compiled = ajv.compile(schema);
      for (const value of samplesFor(tool)) {
        const ours = validateOutgoing(tool, value).ok;
        const theirs = compiled(value) as boolean;
        expect(ours, `${tool} ${JSON.stringify(value)}`).toBe(theirs);
      }
    }
  });

  it("checks nested tax lots and nullable lists without codegen", () => {
    expect(validateOutgoing("place_equity_order", {
      account_number: "1",
      symbol: "AAPL",
      side: "buy",
      type: "limit",
      tax_lots: [{ open_lot_id: "lot", quantity: "1" }],
    }).ok).toBe(true);
    expect(validateOutgoing("place_equity_order", {
      account_number: "1",
      symbol: "AAPL",
      side: "buy",
      type: "limit",
      tax_lots: [{ open_lot_id: "lot" }],
    }).ok).toBe(false);
    expect(validateOutgoing("get_equity_quotes", { symbols: null }).ok).toBe(true);
    expect(validateOutgoing("get_equity_quotes", { symbols: [1] }).ok).toBe(false);
    expect(validateOutgoing("get_equity_orders", { account_number: "1", agent_initiated: null }).ok).toBe(true);
    expect(validateOutgoing("get_equity_orders", { account_number: "1", agent_initiated: "yes" }).ok).toBe(false);
    expect(validateSchema({ type: "string" }, 1).ok).toBe(false);
  });
});

describe("worker bundle", () => {
  it("contains no eval or new Function after the worker build", async () => {
    const dir = mkdtempSync(join(tmpdir(), "churntop10-bundle-"));
    const outfile = join(dir, "index.js");
    try {
      await esbuild.build({
        entryPoints: ["src/worker/index.ts"],
        outfile,
        bundle: true,
        format: "esm",
        platform: "browser",
        target: "es2022",
        external: ["cloudflare:workers"],
        conditions: ["workerd", "worker", "browser"],
        mainFields: ["browser", "module", "main"],
        sourcemap: false,
        legalComments: "none",
        logLevel: "silent",
      });
      const result = spawnSync(process.execPath, ["scripts/check-bundle.mjs", outfile], { encoding: "utf8" });
      expect(result.stderr.trim(), result.stderr).toBe("");
      expect(result.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function samplesFor(tool: string): unknown[] {
  const base: Record<string, unknown> = {
    get_accounts: {},
    get_portfolio: { account_number: "2000004028" },
    get_equity_positions: { account_number: "2000004028" },
    get_equity_quotes: { symbols: ["AAPL"] },
    get_equity_orders: { account_number: "2000004028" },
    get_equity_tradability: { account_number: "2000004028", symbols: ["AAPL"] },
    get_realized_pnl: { account_number: "2000004028", span: "day" },
    get_pnl_trade_history: { account_number: "2000004028" },
    review_equity_order: { account_number: "2000004028", symbol: "AAPL", side: "buy", type: "limit", quantity: "1", limit_price: "1", time_in_force: "gfd", market_hours: "regular_hours" },
    place_equity_order: { account_number: "2000004028", symbol: "AAPL", side: "buy", type: "limit", quantity: "1", limit_price: "1", time_in_force: "gfd", market_hours: "regular_hours", ref_id: "11111111-1111-4111-8111-111111111111" },
    cancel_equity_order: { account_number: "2000004028", order_id: "abc" },
  };
  const valid = base[tool] ?? {};
  return [
    valid,
    {},
    { unexpected: true },
    { ...valid, unexpected: true },
    { ...valid, account_number: 1 },
    { ...valid, symbols: "AAPL" },
    { ...valid, symbols: null },
    { ...valid, symbols: [1] },
    { ...valid, agent_initiated: null },
    { ...valid, tax_lots: null },
    { ...valid, tax_lots: [{ open_lot_id: "x", quantity: "1" }] },
    { ...valid, tax_lots: [{ open_lot_id: "x" }] },
    null,
    [],
    "x",
    1,
    true,
  ];
}
