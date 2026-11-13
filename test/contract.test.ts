import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeToolPayload, displayField, parseAccounts, parsePortfolio, parsePositions, parseQuotes, parseRealizedPnl, selectAgentic } from "../src/lib/decode.js";
import { maskAccountNumber, redactJson } from "../src/lib/mask.js";
import { knownTools, validateOutgoing } from "../src/lib/requests.js";
import { buildEntryBundle } from "../src/lib/orders.js";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../docs/contracts/robinhood/fixtures/${name}`, import.meta.url), "utf8"));
}

describe("outgoing contracts", () => {
  it("rejects unknown properties on every tool", () => {
    for (const tool of knownTools()) {
      const extra = validateOutgoing(tool, { unexpected: true });
      expect(extra.ok, tool).toBe(false);
    }
  });

  it("accepts an empty get_accounts request and rejects a guessed field", () => {
    expect(validateOutgoing("get_accounts", {}).ok).toBe(true);
    expect(validateOutgoing("get_accounts", { account_number: "2000004028" }).ok).toBe(false);
  });

  it("accepts the order bundle field names and rejects a renamed field", () => {
    const bundle = buildEntryBundle({
      accountNumber: "2000004028",
      symbol: "AAPL",
      ask: 355.07,
      quantity: 2,
      stopLossPct: 1,
      profitTargetDollars: 7.1,
      refId: "11111111-1111-4111-8111-111111111111",
    });
    expect(validateOutgoing("place_equity_order", bundle.entry).ok).toBe(true);
    expect(validateOutgoing("place_equity_order", bundle.stop).ok).toBe(true);
    const review = { ...bundle.entry };
    delete review.ref_id;
    expect(validateOutgoing("review_equity_order", review).ok).toBe(true);
    const renamed = { ...bundle.entry, order_type: bundle.entry.type };
    delete (renamed as { type?: string }).type;
    expect(validateOutgoing("place_equity_order", renamed).ok).toBe(false);
  });

  it("requires account_number on portfolio and quotes symbols", () => {
    expect(validateOutgoing("get_portfolio", {}).ok).toBe(false);
    expect(validateOutgoing("get_portfolio", { account_number: "2000004028" }).ok).toBe(true);
    expect(validateOutgoing("get_equity_quotes", { symbols: ["AAPL"] }).ok).toBe(true);
    expect(validateOutgoing("get_equity_quotes", { symbol: "AAPL" }).ok).toBe(false);
    expect(validateOutgoing("cancel_equity_order", { account_number: "2000004028", order_id: "abc", extra: 1 }).ok).toBe(false);
  });
});

describe("recorded payloads", () => {
  it("decodes the data/guide envelope and ignores guide", () => {
    const payload = fixture("get_accounts.json") as { guide: string };
    const data = decodeToolPayload(payload) as { accounts: unknown[] };
    expect(data.accounts).toHaveLength(2);
    expect(JSON.stringify(data)).not.toContain(payload.guide);
  });

  it("parses accounts, selects the agentic one, and masks it", () => {
    const accounts = parseAccounts(fixture("get_accounts.json"));
    expect(accounts[0]?.agenticAllowed).toBe(false);
    expect(accounts[1]?.nickname).toEqual({ status: "ok", value: "MCP" });
    expect(accounts[0]?.nickname.status).toBe("not_reported");
    const selected = selectAgentic(accounts);
    expect(selected?.accountNumber).toBe("2000004028");
    expect(maskAccountNumber(selected?.accountNumber ?? "")).toBe("••••4028");
    const logged = redactJson(fixture("get_accounts.json"));
    expect(logged).toContain("••••4028");
    expect(logged).not.toContain("2000004028");
    expect(logged).not.toContain("1000000362");
  });

  it("reads text content when structured content has no accounts", () => {
    const accounts = parseAccounts(fixture("mcp_text_accounts.json"));
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.agenticAllowed).toBe(true);
  });

  it("parses portfolio required fields and a missing optional crypto block", () => {
    const full = parsePortfolio(fixture("get_portfolio.json"));
    expect(full.totalValue).toEqual({ status: "ok", value: 10000 });
    expect(full.buyingPower).toEqual({ status: "ok", value: 10000 });
    expect(full.cryptoBuyingPower.status).toBe("ok");
    const partial = parsePortfolio(fixture("get_portfolio_no_crypto.json"));
    expect(partial.cryptoBuyingPower.status).toBe("not_reported");
    expect(displayField(partial.cryptoBuyingPower)).toBe("Not reported");
    const broken = parsePortfolio({ data: { cash: "10" }, guide: "x" });
    expect(broken.totalValue.status).toBe("unavailable");
    expect(displayField(broken.totalValue, "usd")).toBe("Unavailable");
  });

  it("parses an empty position list and an open position", () => {
    expect(parsePositions(fixture("get_equity_positions.json")).positions).toEqual([]);
    const open = parsePositions(fixture("get_equity_positions_open.json"));
    expect(open.positions[0]).toMatchObject({ symbol: "AAPL", quantity: 2 });
    expect(open.positions[0]?.averageBuyPrice.status).toBe("ok");
  });

  it("parses the recorded quote book and prefers the later extended print", () => {
    const quotes = parseQuotes(fixture("get_equity_quotes.json"));
    expect(quotes).toHaveLength(10);
    const aapl = quotes.find((quote) => quote.symbol === "AAPL");
    expect(aapl?.last).toBeCloseTo(355, 2);
    expect(aapl?.asOf.startsWith("2026-11-13")).toBe(true);
    expect(aapl?.bid).toBeCloseTo(354.75, 2);
    expect(aapl?.tradable).toBe(true);
    const nvda = quotes.find((quote) => quote.symbol === "NVDA");
    expect(nvda?.last).toBeCloseTo(167.92, 2);
  });

  it("treats a null realized-gain bucket as n/a and zero totals as zero", () => {
    const pnl = parseRealizedPnl(fixture("get_realized_pnl_day.json"));
    expect(pnl.totalReturns).toEqual({ status: "ok", value: 0 });
    expect(pnl.bucketGain).toEqual({ status: "ok", value: null });
    expect(displayField(pnl.bucketGain)).toBe("n/a");
    expect(displayField(pnl.totalReturns, "usd")).toBe("$0.00");
  });
});
