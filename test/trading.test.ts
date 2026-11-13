import { describe, expect, it } from "vitest";
import { LiveTradingDisabled, submitGatedTool } from "../src/lib/broker.js";
import { etParts, marketSession } from "../src/lib/clock.js";
import { validateOutgoing } from "../src/lib/requests.js";
import { dailyLossAmount, dayTradeCount, validateExit, validateNewBuy, type GuardContext } from "../src/lib/validator.js";
import { authorizationMetadataUrls, generatePkce, protectedResourceUrls, refreshDue, refreshLeadSecs, resourceMetadataFromHeader, tokenForm } from "../src/lib/oauth.js";

const REGULAR = new Date("2026-11-13T15:00:00-05:00");
const EXTENDED = new Date("2026-11-13T08:00:00-05:00");
const OVERNIGHT = new Date("2026-11-15T21:00:00-05:00");
const CLOSED = new Date("2026-11-13T21:00:00-05:00");

function ctx(overrides: Partial<GuardContext> = {}): GuardContext {
  return {
    now: REGULAR,
    mode: "live",
    killed: false,
    top10: ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "AVGO", "TSLA", "JPM", "LLY"],
    held: [],
    equity: 10000,
    buyingPower: 10000,
    dayStartEquity: 10000,
    profitTargetPct: 1,
    stopLossPct: 1,
    maxOrderPct: 10,
    dailyLossPct: 1,
    dayTrades: [],
    pdtLimit: 3,
    quote: { symbol: "AAPL", bid: 354.75, ask: 355.07, last: 355, tradable: true },
    workingSymbols: [],
    usedRefIds: [],
    agenticAllowed: true,
    symbol: "AAPL",
    refId: "11111111-1111-4111-8111-111111111111",
    ...overrides,
  };
}

describe("sessions", () => {
  it("classifies regular, extended, overnight, and closed", () => {
    expect(marketSession(REGULAR)).toBe("regular");
    expect(marketSession(EXTENDED)).toBe("extended");
    expect(marketSession(OVERNIGHT)).toBe("overnight");
    expect(marketSession(CLOSED)).toBe("closed");
    expect(etParts(REGULAR).date).toBe("2026-11-13");
  });
});

describe("new buy guards", () => {
  it("builds a stopped limit buy inside the cap when Live", () => {
    const verdict = validateNewBuy(ctx());
    expect(verdict.ok).toBe(true);
    expect(verdict.bundle?.entry.type).toBe("limit");
    expect(verdict.bundle?.entry.market_hours).toBe("regular_hours");
    expect(verdict.bundle?.stop.type).toBe("stop_market");
    expect(verdict.bundle?.stop.side).toBe("sell");
    expect(Number(verdict.bundle?.stop.stop_price)).toBeLessThan(355.07);
    expect(verdict.bundle?.quantity).toBe(2);
    expect(validateOutgoing("place_equity_order", { ...verdict.bundle?.entry, account_number: "2000004028" }).ok).toBe(true);
  });

  it("blocks a new buy that is not in the Top 10 and allows an add to a held name", () => {
    const blocked = validateNewBuy(ctx({ symbol: "IBM", quote: { symbol: "IBM", bid: 100, ask: 100.1, last: 100, tradable: true } }));
    expect(blocked.code).toBe("top10");
    const add = validateNewBuy(ctx({ held: [{ symbol: "IBM", quantity: 1, openedOn: "2026-11-12" }], symbol: "IBM", quote: { symbol: "IBM", bid: 100, ask: 100.1, last: 100, tradable: true } }));
    expect(add.ok).toBe(true);
  });

  it("stops new buys on the kill switch, view only, daily loss, pdt, session, and duplicate ref", () => {
    expect(validateNewBuy(ctx({ killed: true })).code).toBe("kill_switch");
    expect(validateNewBuy(ctx({ mode: "view_only" })).code).toBe("view_only");
    expect(validateNewBuy(ctx({ mode: "view_only" })).bundle?.stop.stop_price).toBeTruthy();
    expect(validateNewBuy(ctx({ equity: 9800, dayStartEquity: 10000 })).code).toBe("daily_loss");
    expect(dailyLossAmount(9800, 10000)).toBe(200);
    const trades = [
      { symbol: "AAPL", day: "2026-11-13" },
      { symbol: "MSFT", day: "2026-11-12" },
      { symbol: "NVDA", day: "2026-11-11" },
    ];
    expect(dayTradeCount(trades, "2026-11-13")).toBe(3);
    expect(validateNewBuy(ctx({ dayTrades: trades })).code).toBe("pdt");
    expect(validateNewBuy(ctx({ now: EXTENDED })).code).toBe("session");
    expect(validateNewBuy(ctx({ now: OVERNIGHT })).code).toBe("session");
    expect(validateNewBuy(ctx({ usedRefIds: ["11111111-1111-4111-8111-111111111111"] })).code).toBe("duplicate");
  });

  it("rejects a share that does not fit under the order cap", () => {
    const verdict = validateNewBuy(ctx({ symbol: "LLY", quote: { symbol: "LLY", bid: 1430, ask: 1430.72, last: 1430.3, tradable: true } }));
    expect(verdict.code).toBe("cap");
  });

  it("lets a stop exit through when the day-trade cap or the kill switch is on", () => {
    expect(validateExit({ now: REGULAR, killed: true, quantity: 2, bid: 350, kind: "stop" }).ok).toBe(true);
    expect(validateExit({ now: OVERNIGHT, killed: false, quantity: 2, bid: 350, kind: "stop" }).ok).toBe(true);
    expect(validateExit({ now: CLOSED, killed: false, quantity: 2, bid: 350, kind: "stop" }).code).toBe("session");
  });
});

describe("oauth and the live gate", () => {
  it("discovers path-inserted metadata and refreshes inside the lead window", async () => {
    const pkce = await generatePkce();
    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pkce.verifier));
    const bytes = new Uint8Array(digest);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const challenge = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    expect(pkce.challenge).toBe(challenge);
    const resource = "https://agent.robinhood.com/mcp/trading";
    expect(protectedResourceUrls(resource)[0]).toBe("https://agent.robinhood.com/.well-known/oauth-protected-resource/mcp/trading");
    const urls = authorizationMetadataUrls(resource);
    expect(urls[0]).toBe("https://agent.robinhood.com/.well-known/oauth-authorization-server/mcp/trading");
    expect(urls.some((url) => url.includes("/mcp/trading/.well-known/"))).toBe(false);
    const header = 'Bearer resource_metadata="https://agent.robinhood.com/.well-known/oauth-protected-resource/mcp/trading"';
    expect(resourceMetadataFromHeader(header)).toContain("oauth-protected-resource/mcp/trading");
    expect(refreshLeadSecs(3600)).toBe(60);
    expect(refreshLeadSecs(30)).toBe(3);
    const soon = new Date(Date.now() + 20_000).toISOString();
    expect(refreshDue(soon, 3600)).toBe(true);
    expect(refreshDue(new Date(Date.now() + 600_000).toISOString(), 3600)).toBe(false);
    const form = tokenForm("refresh_token", { refresh_token: "super-secret", client_id: "client", resource });
    expect(form.startsWith("grant_type=refresh_token")).toBe(true);
    expect(form).not.toContain("offline_access");
  });

  it("does not call the broker when the live gate is off, and never cancels", async () => {
    const calls: string[] = [];
    const send = async (tool: string) => {
      calls.push(tool);
      return { ok: true };
    };
    await expect(submitGatedTool({ allowLive: "0", tool: "place_equity_order", args: { account_number: "1", symbol: "AAPL", side: "buy", type: "limit" }, send })).rejects.toBeInstanceOf(LiveTradingDisabled);
    await expect(submitGatedTool({ allowLive: "1", tool: "cancel_equity_order", args: { account_number: "1", order_id: "x" }, send })).rejects.toBeInstanceOf(LiveTradingDisabled);
    expect(calls).toEqual([]);
    const args = { account_number: "2000004028", symbol: "AAPL", side: "buy", type: "limit", quantity: "1", limit_price: "355.07", market_hours: "regular_hours", time_in_force: "gfd", ref_id: "11111111-1111-4111-8111-111111111111" };
    await submitGatedTool({ allowLive: "1", tool: "place_equity_order", args, send });
    expect(calls).toEqual(["place_equity_order"]);
  });
});
