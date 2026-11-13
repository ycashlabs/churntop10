import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseOrders, parsePlacedOrder, parsePositions } from "../src/lib/decode.js";
import {
  applyOrderFill,
  labelBuyRule,
  recordsForPlacedLiveBuy,
  reconcileLiveHoldings,
  shouldComputeScores,
  shouldTickSimulator,
  type ReconcileContext,
} from "../src/lib/holdings.js";
import type { PositionRecord } from "../src/lib/storage.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(root, "docs/contracts/robinhood/fixtures", name), "utf8"));
}

function ctx(overrides: Partial<ReconcileContext> = {}): ReconcileContext {
  let n = 0;
  return {
    now: 1_700_000_000_000,
    session: "extended",
    tradingCapital: 1000,
    profitTargetPct: 3,
    stopLossPct: 1.5,
    nextId: () => `id-${++n}`,
    ...overrides,
  };
}

function holding(symbol = "TSLL", quantity = 1, averageBuyPrice = 11.05) {
  return { symbol, quantity, averageBuyPrice };
}

describe("recorded holdings fixture", () => {
  it("parses the recorded get_equity_positions shape without account numbers", () => {
    const raw = JSON.stringify(fixture("get_equity_positions_tsll.json"));
    expect(raw).not.toMatch(/544784028|2000004028|account_number/);
    const parsed = parsePositions(fixture("get_equity_positions_tsll.json"));
    expect(parsed.violated).toBe(false);
    expect(parsed.positions).toEqual([
      expect.objectContaining({ symbol: "TSLL", quantity: 1, averageBuyPrice: { status: "ok", value: 11.05 } }),
    ]);
  });
});

describe("reconcileLiveHoldings", () => {
  it("imports a holding that has no app record, and is idempotent", () => {
    const first = reconcileLiveHoldings([], [holding()], ctx());
    expect(first).toHaveLength(1);
    expect(first[0]?.kind).toBe("import");
    expect(first[0]?.position.source).toBe("imported");
    expect(first[0]?.position.buyRuleVersionId).toBeUndefined();
    expect(first[0]?.position.tradingCapitalSnapshot).toBe(1000);
    expect(first[0]?.position.qty).toBe(1);
    expect(first[0]?.position.avgCost).toBe(11.05);
    expect(first[0]?.trade?.source).toBe("broker_import");
    expect(first[0]?.trade?.qty).toBe(1);
    expect(first[0]?.capital?.newValue).toBe(1000);
    expect(first[0]?.review?.exitType).toBe("imported");
    expect(labelBuyRule(first[0]!.position)).toBe("imported/manual");

    const again = reconcileLiveHoldings([first[0]!.position], [holding()], ctx());
    expect(again).toEqual([]);
  });

  it("records outside quantity increases and decreases, and closes a full sell-out", () => {
    const imported = reconcileLiveHoldings([], [holding()], ctx())[0]!.position;
    const add = reconcileLiveHoldings([imported], [holding("TSLL", 2, 11.2)], ctx());
    expect(add).toHaveLength(1);
    expect(add[0]?.kind).toBe("qty_change");
    expect(add[0]?.trade?.side).toBe("buy");
    expect(add[0]?.trade?.qty).toBe(1);
    expect(add[0]?.trade?.source).toBe("broker_qty_change");
    expect(add[0]?.position.qty).toBe(2);
    expect(add[0]?.position.avgCost).toBe(11.2);

    const trim = reconcileLiveHoldings([add[0]!.position], [holding("TSLL", 1, 11.2)], ctx());
    expect(trim[0]?.trade?.side).toBe("sell");
    expect(trim[0]?.position.qty).toBe(1);

    const closed = reconcileLiveHoldings([trim[0]!.position], [], ctx());
    expect(closed[0]?.kind).toBe("close");
    expect(closed[0]?.position.status).toBe("closed");
    expect(closed[0]?.position.qty).toBe(0);
    expect(closed[0]?.trade?.source).toBe("broker_close");
    expect(closed[0]?.review?.exitType).toBe("imported_close");

    const stillClosed = reconcileLiveHoldings([], [], ctx());
    expect(stillClosed).toEqual([]);
  });

  it("does not import a second live position when the app already has that symbol", () => {
    const app: PositionRecord = {
      id: "live-1",
      mode: "live",
      symbol: "TSLL",
      status: "open",
      tradingCapitalSnapshot: 500,
      profitTargetPct: 3,
      stopLossPct: 1,
      avgCost: 11.048,
      qty: 1,
      openedAt: 1,
      source: "app",
      buyRuleVersionId: "buy-v1",
    };
    expect(reconcileLiveHoldings([app], [holding("TSLL", 1, 11.048)], ctx())).toEqual([]);
  });
});

describe("live order records", () => {
  it("writes a live position and trade with rule versions, signals, capital snapshot, and broker order id", () => {
    const records = recordsForPlacedLiveBuy({
      symbol: "TSLL",
      qty: 1,
      limitPrice: 11.08,
      fillPrice: 11.048,
      brokerOrderId: "11111111-2222-4333-8444-555555555555",
      buyRuleVersionId: "buy-v1",
      sellRuleVersionId: "sell-v1",
      signals: [{ id: "spy_up", name: "SPY up", fired: true, value: 1, reason: "up" }],
      session: "extended",
      bid: 11.04,
      ask: 11.05,
      tradingCapital: 1000,
      profitTargetPct: 3,
      stopLossPct: 1.5,
      sizeReason: "Starter buy, 20% of the cap.",
      status: "confirmed",
      now: 1_700_000_000_000,
      nextId: (() => { let n = 0; return () => `new-${++n}`; })(),
    });
    expect(records.position.source).toBe("app");
    expect(records.position.buyRuleVersionId).toBe("buy-v1");
    expect(records.position.sellRuleVersionId).toBe("sell-v1");
    expect(records.position.tradingCapitalSnapshot).toBe(1000);
    expect(records.position.avgCost).toBe(11.048);
    expect(records.trade.brokerOrderId).toBe("11111111-2222-4333-8444-555555555555");
    expect(records.trade.source).toBe("app");
    expect(records.trade.signals?.[0]?.id).toBe("spy_up");
    expect(records.capital?.newValue).toBe(1000);
  });

  it("reconciles a later fill by broker order id", () => {
    const placed = parsePlacedOrder(fixture("place_equity_order_submitted.json"));
    expect(placed?.id).toBe("11111111-2222-4333-8444-555555555555");
    expect(placed?.state).toBe("confirmed");
    const orders = parseOrders(fixture("get_equity_orders_filled.json"));
    const trade = recordsForPlacedLiveBuy({
      symbol: "TSLL",
      qty: 1,
      limitPrice: 11.048,
      brokerOrderId: placed!.id,
      session: "extended",
      tradingCapital: 1000,
      profitTargetPct: 3,
      stopLossPct: 1,
      sizeReason: "Starter",
      status: placed!.state,
      now: 1,
      nextId: () => "t1",
    }).trade;
    const filled = applyOrderFill(trade, orders[0]!);
    expect(filled?.status).toBe("filled");
    expect(filled?.fillPrice).toBe(11.048);
    expect(applyOrderFill(filled!, orders[0]!)).toBeUndefined();
  });
});

describe("simulator auto-start and score skip", () => {
  it("ticks the simulator even when no positions are open, and skips scores when nothing is closed", () => {
    expect(shouldTickSimulator(0)).toBe(true);
    expect(shouldTickSimulator(2)).toBe(true);
    expect(shouldComputeScores(0)).toBe(false);
    expect(shouldComputeScores(1)).toBe(true);
  });
});
