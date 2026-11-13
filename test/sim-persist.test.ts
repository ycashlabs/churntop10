import { describe, expect, it } from "vitest";
import {
  BAR_RETENTION_MS,
  legacySimTickWriteStatements,
  planReplaceProposals,
  planReplaceWorkingOrders,
  planSaveBars,
  planSetSelectedRuleIds,
  samePosition,
  shouldWritePriceMark,
  type BarRow,
  type OrderRow,
  type ProposalRow,
} from "../src/lib/sim-persist.js";
import { resetMemoryRateLimits, takeMemoryBucket } from "../src/lib/rate.js";

function bars(symbol: string, start: number, count: number, step = 5 * 60 * 1000): BarRow[] {
  return Array.from({ length: count }, (_, index) => ({
    symbol,
    ts: start + index * step,
    price: 100 + index,
    volume: 10_000,
  }));
}

function proposal(index: number, createdAt: number): ProposalRow {
  return { id: `p${index}`, refId: `r${index}`, symbol: "NVDA", verdict: "skip", message: "n", payload: "[]", createdAt };
}

function order(id: string, status = "working"): OrderRow {
  return { id, refId: `ref-${id}`, symbol: "NVDA", side: "buy", type: "limit", quantity: 1, limit: 10, stop: null, status, role: "entry", openedOn: "2026-11-13", createdAt: 1 };
}

describe("planSaveBars", () => {
  it("inserts only new bars and prunes rows older than 24h", () => {
    const now = 1_000_000_000_000;
    const existing = [
      ...bars("AAPL", now - BAR_RETENTION_MS - 10 * 60 * 1000, 3),
      ...bars("AAPL", now - 30 * 60 * 1000, 5),
    ];
    const incoming = [
      ...existing.filter((row) => row.ts >= now - BAR_RETENTION_MS),
      { symbol: "AAPL", ts: now, price: 110, volume: 12_000 },
    ];
    const writes = planSaveBars(existing, incoming, now);
    expect(writes.some((write) => write.sql.startsWith("DELETE FROM quote_bars WHERE ts <"))).toBe(true);
    expect(writes.filter((write) => write.sql.startsWith("INSERT INTO quote_bars")).length).toBe(1);
    expect(writes).toHaveLength(2);
  });

  it("is a no-op when the incoming 24h window is already stored", () => {
    const now = 1_000_000_000_000;
    const existing = bars("AAPL", now - 30 * 60 * 1000, 5);
    expect(planSaveBars(existing, existing, now)).toEqual([]);
  });
});

describe("planReplaceProposals", () => {
  it("caps storage to the last 12 and only inserts new rows", () => {
    const existing = Array.from({ length: 12 }, (_, index) => proposal(index, index));
    const incoming = [...existing, proposal(12, 12), proposal(13, 13)];
    const writes = planReplaceProposals(existing, incoming);
    const deleted = writes.find((write) => write.sql.startsWith("DELETE FROM proposals"));
    expect(deleted?.params).toEqual(["p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10", "p11", "p12", "p13"]);
    expect(writes.filter((write) => write.sql.startsWith("INSERT")).length).toBe(2);
  });

  it("skips writes when the last 12 are already stored", () => {
    const existing = Array.from({ length: 12 }, (_, index) => proposal(index, index));
    expect(planReplaceProposals(existing, existing)).toEqual([]);
  });
});

describe("planReplaceWorkingOrders and planSetSelectedRuleIds", () => {
  it("skips no-op rewrites", () => {
    const orders = [order("o1"), order("o2")];
    expect(planReplaceWorkingOrders(orders, orders)).toEqual([]);
    expect(planSetSelectedRuleIds(["a", "b"], ["b", "a"])).toEqual([]);
  });

  it("updates only changed or new orders", () => {
    const writes = planReplaceWorkingOrders([order("o1"), order("o2")], [order("o2", "filled"), order("o3")]);
    expect(writes.some((write) => write.sql.startsWith("DELETE FROM sim_orders") && write.params?.includes("o1"))).toBe(true);
    expect(writes.some((write) => write.sql.startsWith("UPDATE sim_orders") && write.params?.at(-1) === "o2")).toBe(true);
    expect(writes.filter((write) => write.sql.startsWith("INSERT INTO sim_orders")).length).toBe(1);
  });
});

describe("unchanged positions and price marks", () => {
  const position = {
    id: "pos", mode: "sim", symbol: "NVDA", status: "open",
    tradingCapitalSnapshot: 1000, profitTargetPct: 1, stopLossPct: 1,
    avgCost: 10, qty: 1, openedAt: 1, source: "app",
  };
  it("detects unchanged positions", () => {
    expect(samePosition(position, { ...position })).toBe(true);
    expect(samePosition(position, { ...position, qty: 2 })).toBe(false);
  });
  it("skips a price mark when the last price is unchanged", () => {
    expect(shouldWritePriceMark(169.27, 169.27)).toBe(false);
    expect(shouldWritePriceMark(169.27, 170)).toBe(true);
    expect(shouldWritePriceMark(undefined, 169.27)).toBe(true);
  });
});

describe("GET /api/session memory rate limit", () => {
  it("limits in memory without a D1 write", () => {
    resetMemoryRateLimits();
    const now = 1_000;
    for (let i = 0; i < 60; i++) {
      expect(takeMemoryBucket("session:1.1.1.1", now, 60, 60_000).allow).toBe(true);
    }
    expect(takeMemoryBucket("session:1.1.1.1", now, 60, 60_000).allow).toBe(false);
    expect(takeMemoryBucket("session:1.1.1.1", now + 60_000, 60, 60_000).allow).toBe(true);
  });
});

describe("D1 write statements per cron tick", () => {
  it("counts a steady-state tick against the legacy rewrite", () => {
    const now = 1_794_582_000_000;
    const symbols = ["AAPL", "AMZN", "AVGO", "GOOGL", "JPM", "LLY", "META", "MSFT", "NVDA", "TSLA"];
    const existingBars = symbols.flatMap((symbol) => bars(symbol, now - 59 * 5 * 60 * 1000, 60));
    const incomingBars = symbols.flatMap((symbol) => [
      ...bars(symbol, now - 59 * 5 * 60 * 1000, 60),
      { symbol, ts: now + 5 * 60 * 1000, price: 200, volume: 12_000 },
    ]);
    const existingProposals = Array.from({ length: 12 }, (_, index) => proposal(index, index));
    const incomingProposals = [...existingProposals];
    const existingOrders = Array.from({ length: 27 }, (_, index) => order(`o${index}`));
    const selected = ["r1", "r2", "r3", "r4", "r5", "r6"];

    const writes = [
      ...planSaveBars(existingBars, incomingBars, now + 5 * 60 * 1000),
      ...planReplaceProposals(existingProposals, incomingProposals),
      ...planReplaceWorkingOrders(existingOrders, existingOrders),
      ...planSetSelectedRuleIds(selected, selected),
    ];
    // Unchanged positions and same-price marks add no writes.
    expect(samePosition(
      { id: "p", mode: "sim", symbol: "NVDA", status: "open", tradingCapitalSnapshot: 1, profitTargetPct: 1, stopLossPct: 1, avgCost: 1, qty: 1, openedAt: 1, source: "app" },
      { id: "p", mode: "sim", symbol: "NVDA", status: "open", tradingCapitalSnapshot: 1, profitTargetPct: 1, stopLossPct: 1, avgCost: 1, qty: 1, openedAt: 1, source: "app" },
    )).toBe(true);
    expect(shouldWritePriceMark(200, 200)).toBe(false);

    const before = legacySimTickWriteStatements({
      bars: existingBars.length,
      proposals: existingProposals.length,
      orders: existingOrders.length,
      selected: selected.length,
      positions: 9,
      priceMarks: 9,
    });
    const after = writes.length;
    expect(existingBars).toHaveLength(600);
    expect(before).toBe(1 + 600 + 1 + 12 + 1 + 27 + 1 + 6 + 9 + 9 + 1);
    expect(before).toBe(668);
    expect(after).toBe(10);
    expect(writes.every((write) => write.sql.startsWith("INSERT INTO quote_bars"))).toBe(true);
    expect(after).toBeLessThan(before / 50);
  });
});
