import { describe, expect, it } from "vitest";
import { synthesizeBars } from "../src/lib/bars.js";
import { DRAFT_RULES, scorecardFromTrades } from "../src/lib/rules.js";
import { listSignalTypes, computeSignals, signalStrength, FIRST_BUY_SIGNALS, ADD_DIP_SIGNALS, EXIT_WEAKNESS_SIGNALS } from "../src/lib/signals.js";
import { maxPositionNotional, sizeAdd, sizeStarter, starterNotional } from "../src/lib/sizing.js";
import { runSimulatorCycle, sellAllSimPositions, type SimState } from "../src/lib/simulator.js";
import type { QuoteView } from "../src/lib/decode.js";

const REGULAR = new Date("2026-11-13T15:00:00-05:00");
const OVERNIGHT = new Date("2026-11-15T21:00:00-05:00");

function quote(overrides: Partial<QuoteView> = {}): QuoteView {
  return {
    symbol: "AAPL",
    bid: 354.75,
    ask: 355.07,
    last: 355,
    asOf: REGULAR.toISOString(),
    tradable: true,
    hasBidAsk: true,
    previousClose: { status: "ok", value: 355.36 },
    ...overrides,
  };
}

function rules(): SimState["rules"] {
  const now = Date.now();
  return DRAFT_RULES.map((seed, index) => ({
    id: `rule-${index}`,
    familyId: seed.familyId,
    name: seed.name,
    side: seed.side,
    body: seed.body,
    signals: seed.signals,
    status: "experimenting" as const,
    version: 1,
    createdAt: now,
    updatedAt: now,
  }));
}

function state(overrides: Partial<SimState> = {}): SimState {
  const list = rules();
  return {
    cash: 20000,
    dayStartEquity: 20000,
    dayStartDate: "2026-11-13",
    mode: "live",
    killed: false,
    profitTargetPct: 1,
    stopLossPct: 1,
    dailyLossPct: 1,
    orderCap: 100,
    top10: ["AAPL"],
    positions: [],
    orders: [],
    dayTrades: [],
    proposals: [],
    trades: [],
    usedRefIds: [],
    rules: list,
    selectedRuleIds: list.map((rule) => rule.id),
    bars: {},
    spyBars: [],
    spyLast: 600,
    spyPreviousClose: 595,
    ...overrides,
  };
}

describe("sizing", () => {
  it("caps a position at 10% of balance and starts at 20% of that cap", () => {
    expect(maxPositionNotional(300)).toBe(30);
    expect(starterNotional(300)).toBe(6);
    expect(maxPositionNotional(10000)).toBe(1000);
    expect(starterNotional(10000)).toBe(200);
    const regular = sizeStarter({ balance: 10000, price: 355.07, buyingPower: 10000, now: REGULAR });
    expect("quantity" in regular && regular.quantity < 1).toBe(true);
    const overnight = sizeStarter({ balance: 10000, price: 355.07, buyingPower: 10000, now: OVERNIGHT });
    expect("error" in overnight && overnight.error === "cap").toBe(true);
    const add = sizeAdd({ balance: 10000, positionNotional: 200, price: 100, buyingPower: 8000, strength: 0.5, now: REGULAR });
    expect("notional" in add && add.notional).toBeCloseTo(400, 0);
    expect(sizeAdd({ balance: 10000, positionNotional: 200, price: 100, buyingPower: 8000, strength: 0, now: REGULAR })).toEqual({ error: "strength" });
  });
});

describe("signals", () => {
  it("registers the 20-minute, volume, and SPY signals as a pluggable set", () => {
    const ids = listSignalTypes().map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining([...FIRST_BUY_SIGNALS, ...ADD_DIP_SIGNALS, ...EXIT_WEAKNESS_SIGNALS]));
    const now = REGULAR;
    const strength = synthesizeBars({ last: 355, now, style: "strength" });
    const first = computeSignals(FIRST_BUY_SIGNALS, {
      symbol: "AAPL", last: 355, volume: strength.at(-1)!.volume, now, bars: strength, spyBars: [], spyLast: 600, spyPreviousClose: 595,
    });
    expect(first.every((item) => item.fired)).toBe(true);
    expect(signalStrength(first)).toBe(1);
    const dip = synthesizeBars({ last: 99, now, style: "dip" });
    const dipSignals = computeSignals(ADD_DIP_SIGNALS, {
      symbol: "AAPL", last: 99, volume: dip.at(-1)!.volume, now, bars: dip, spyBars: [], spyLast: 600, spyPreviousClose: 598, averageCost: 100,
    });
    expect(dipSignals.every((item) => item.fired)).toBe(true);
  });
});

describe("scorecard and draft rules", () => {
  it("seeds six experimenting rules and scores wins and losses", () => {
    expect(DRAFT_RULES).toHaveLength(6);
    expect(DRAFT_RULES.every((rule) => rule.name.length > 0)).toBe(true);
    const card = scorecardFromTrades("buy-first-strength", [10, -4, 6]);
    expect(card.tradeCount).toBe(3);
    expect(card.winRate).toBeCloseTo(2 / 3);
    expect(card.avgProfit).toBeCloseTo(4);
    expect(card.worstLoss).toBe(-4);
  });
});

describe("simulator v2", () => {
  it("opens a starter on strength, sizes an add from signals, and can take profit before the cap is full", () => {
    let n = 0;
    const ids = () => `id-${++n}`;
    const first = runSimulatorCycle(state(), [quote()], REGULAR, ids);
    expect(first.events.some((event) => event.action === "sim_entry")).toBe(true);
    expect(first.state.positions).toHaveLength(1);
    const opened = first.state.positions[0]!;
    const starterCost = opened.quantity * opened.avgCost;
    expect(starterCost).toBeLessThan(maxPositionNotional(20000) * 0.3);
    const add = runSimulatorCycle(first.state, [quote({ last: 356, bid: 355.8, ask: 356.1 })], new Date(REGULAR.getTime() + 5 * 60 * 1000), ids);
    const added = add.events.some((event) => event.action === "sim_add");
    const held = add.state.positions[0] ?? opened;
    if (added) expect(held.quantity * held.avgCost).toBeLessThanOrEqual(maxPositionNotional(20000) + 0.02);
    const target = held.avgCost * 1.01;
    const profit = runSimulatorCycle(add.state, [quote({ last: target + 1, bid: target + 0.5, ask: target + 1.2 })], new Date(REGULAR.getTime() + 10 * 60 * 1000), ids);
    expect(profit.events.some((event) => event.action === "target_filled")).toBe(true);
    expect(profit.state.positions).toHaveLength(0);
    expect(profit.state.trades[0]?.buyRuleId).toBeTruthy();
  });

  it("sells every position on Sell All Positions and stops later buys", () => {
    let n = 0;
    const ids = () => `id-${++n}`;
    const opened = runSimulatorCycle(state(), [quote()], REGULAR, ids);
    const sold = sellAllSimPositions(opened.state, [quote()], REGULAR, ids);
    expect(sold.state.killed).toBe(true);
    expect(sold.state.positions).toHaveLength(0);
    const again = runSimulatorCycle(sold.state, [quote()], new Date(REGULAR.getTime() + 5 * 60 * 1000), ids);
    expect(again.events.some((event) => event.action === "sim_entry")).toBe(false);
  });
});
