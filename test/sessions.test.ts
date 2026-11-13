import { describe, expect, it } from "vitest";
import type { QuoteView } from "../src/lib/decode.js";
import { marketSession, SESSION_HELP, sessionMarketHours } from "../src/lib/clock.js";
import { marketableSellLimit, nextExitAction, quoteIsStale, spreadRatio, MAX_SPREAD } from "../src/lib/exits.js";
import { buildEntryBundle } from "../src/lib/orders.js";
import { validateOutgoing } from "../src/lib/requests.js";
import { runSimulatorCycle, type SimState } from "../src/lib/simulator.js";
import { validateNewBuy, type GuardContext } from "../src/lib/validator.js";

const REGULAR = new Date("2026-11-13T15:00:00-05:00");
const PREMARKET = new Date("2026-11-13T08:00:00-05:00");
const AFTERHOURS = new Date("2026-11-13T17:00:00-05:00");
const OVERNIGHT = new Date("2026-11-15T21:00:00-05:00"); // Sunday 9pm ET
const CLOSED_FRI = new Date("2026-11-13T21:00:00-05:00");
const SUN_BEFORE = new Date("2026-11-15T19:59:00-05:00");
const SUN_OPEN = new Date("2026-11-15T20:00:00-05:00");
const MON_EARLY = new Date("2026-11-16T06:59:00-05:00");
const MON_EXT = new Date("2026-11-16T07:00:00-05:00");
const OPEN_BELL = new Date("2026-11-16T09:30:00-05:00");
const CLOSE_BELL = new Date("2026-11-16T16:00:00-05:00");

function quote(overrides: Partial<QuoteView> = {}): QuoteView {
  return {
    symbol: "AAPL",
    bid: 354.75,
    ask: 355.07,
    last: 355,
    asOf: OVERNIGHT.toISOString(),
    tradable: true,
    hasBidAsk: true,
    previousClose: { status: "ok", value: 355.36 },
    ...overrides,
  };
}

function ctx(overrides: Partial<GuardContext> = {}): GuardContext {
  return {
    now: OVERNIGHT,
    mode: "live",
    killed: false,
    top10: ["AAPL"],
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
    quote: { symbol: "AAPL", bid: 354.75, ask: 355.07, last: 355, tradable: true, hasBidAsk: true, asOf: OVERNIGHT.toISOString() },
    quoteSource: "recorded",
    workingSymbols: [],
    usedRefIds: [],
    agenticAllowed: true,
    symbol: "AAPL",
    refId: "11111111-1111-4111-8111-111111111111",
    ...overrides,
  };
}

function emptyState(): SimState {
  return {
    cash: 10000,
    dayStartEquity: 10000,
    dayStartDate: "2026-11-15",
    mode: "live",
    killed: false,
    profitTargetPct: 1,
    stopLossPct: 1,
    maxOrderPct: 10,
    dailyLossPct: 1,
    pdtLimit: 3,
    top10: ["AAPL"],
    positions: [],
    orders: [],
    dayTrades: [],
    proposals: [],
    usedRefIds: [],
  };
}

describe("session clock", () => {
  it("classifies the weekday and weekend boundaries", () => {
    expect(marketSession(PREMARKET)).toBe("extended");
    expect(marketSession(REGULAR)).toBe("regular");
    expect(marketSession(AFTERHOURS)).toBe("extended");
    expect(marketSession(CLOSED_FRI)).toBe("closed");
    expect(marketSession(SUN_BEFORE)).toBe("closed");
    expect(marketSession(SUN_OPEN)).toBe("overnight");
    expect(marketSession(OVERNIGHT)).toBe("overnight");
    expect(marketSession(MON_EARLY)).toBe("overnight");
    expect(marketSession(MON_EXT)).toBe("extended");
    expect(marketSession(OPEN_BELL)).toBe("regular");
    expect(marketSession(CLOSE_BELL)).toBe("extended");
    expect(sessionMarketHours("regular")).toBe("regular_hours");
    expect(sessionMarketHours("extended")).toBe("extended_hours");
    expect(sessionMarketHours("overnight")).toBe("all_day_hours");
    expect(sessionMarketHours("closed")).toBeNull();
  });
});

describe("new buys 24/5", () => {
  it("accepts pre-market, regular, after-hours, and overnight buys and builds session-correct limits", () => {
    for (const [now, hours, kind] of [
      [PREMARKET, "extended_hours", "synthetic"],
      [REGULAR, "regular_hours", "broker"],
      [AFTERHOURS, "extended_hours", "synthetic"],
      [OVERNIGHT, "all_day_hours", "synthetic"],
    ] as const) {
      const verdict = validateNewBuy(ctx({ now }));
      expect(verdict.ok, hours).toBe(true);
      expect(verdict.bundle?.entry.type).toBe("limit");
      expect(verdict.bundle?.entry.market_hours).toBe(hours);
      expect(verdict.bundle?.takeProfit.market_hours).toBe(hours);
      expect(verdict.bundle?.stopKind).toBe(kind);
      expect(verdict.bundle?.stop.type).toBe("stop_market");
      expect(verdict.bundle?.stop.market_hours).toBe("regular_hours");
      expect(validateOutgoing("place_equity_order", { ...verdict.bundle?.entry, account_number: "2000004028" }).ok).toBe(true);
    }
  });

  it("blocks the weekend close, a wide spread, a stale live quote, a missing bid, and an ineligible overnight symbol", () => {
    expect(validateNewBuy(ctx({ now: CLOSED_FRI })).code).toBe("session");
    expect(validateNewBuy(ctx({ now: SUN_BEFORE })).code).toBe("session");
    expect(validateNewBuy(ctx({ quote: { symbol: "AAPL", bid: 350, ask: 360, last: 355, tradable: true, hasBidAsk: true } })).code).toBe("spread");
    expect(spreadRatio(350, 360)!).toBeGreaterThan(MAX_SPREAD);
    expect(validateNewBuy(ctx({ quote: { symbol: "AAPL", bid: 355, ask: 355, last: 355, tradable: true, hasBidAsk: false } })).code).toBe("spread");
    const stale = new Date(OVERNIGHT.getTime() - 6 * 60 * 1000).toISOString();
    expect(validateNewBuy(ctx({ quoteSource: "robinhood", quote: { symbol: "AAPL", bid: 354.75, ask: 355.07, last: 355, tradable: true, hasBidAsk: true, asOf: stale } })).code).toBe("stale");
    expect(quoteIsStale(stale, OVERNIGHT, "robinhood")).toBe(true);
    expect(quoteIsStale(stale, OVERNIGHT, "recorded")).toBe(false);
    expect(validateNewBuy(ctx({ now: OVERNIGHT, quote: { symbol: "AAPL", bid: 354.75, ask: 355.07, last: 355, tradable: true, hasBidAsk: true, overnightEligible: false } })).code).toBe("overnight");
  });

  it("does not treat a recorded print as stale", () => {
    expect(validateNewBuy(ctx({ quoteSource: "recorded", quote: { symbol: "AAPL", bid: 354.75, ask: 355.07, last: 355, tradable: true, hasBidAsk: true, asOf: "2020-01-01T00:00:00Z" } })).ok).toBe(true);
  });
});

describe("synthetic stop actions", () => {
  it("fires a bid-based marketable sell, waits without a bid, and reprices when the bid drops", () => {
    const stop = 351.52;
    const bid = 350;
    const last = 350;
    expect(marketableSellLimit(bid, last)).toBeLessThan(bid);
    expect(nextExitAction({ session: "overnight", last, bid, hasBid: true, stopPrice: stop, stopKind: "synthetic", quantity: 2 })).toEqual({
      type: "fire_synthetic",
      limitPrice: marketableSellLimit(bid, last),
    });
    expect(nextExitAction({ session: "overnight", last, bid: 0, hasBid: false, stopPrice: stop, stopKind: "synthetic", quantity: 2 }).type).toBe("wait");
    expect(nextExitAction({ session: "closed", last, bid, hasBid: true, stopPrice: stop, stopKind: "synthetic", quantity: 2 }).type).toBe("wait");
    const oldLimit = 349;
    const lowerBid = 348;
    expect(nextExitAction({ session: "overnight", last: 348, bid: lowerBid, hasBid: true, stopExitLimit: oldLimit, quantity: 2 })).toEqual({
      type: "reprice_stop_exit",
      limitPrice: marketableSellLimit(lowerBid, 348),
    });
    const liveLimit = marketableSellLimit(350, 350);
    expect(nextExitAction({ session: "overnight", last: 350, bid: 350, hasBid: true, stopExitLimit: liveLimit, quantity: 2 })).toEqual({
      type: "fill_stop_exit",
      price: liveLimit,
    });
  });

  it("attaches a broker stop at the regular open unless a stop-exit is already working, and fills a gapped broker stop at the bid", () => {
    expect(nextExitAction({ session: "regular", last: 355, bid: 354.75, hasBid: true, stopPrice: 351.52, stopKind: "synthetic", quantity: 2 }).type).toBe("attach_broker_stop");
    expect(nextExitAction({ session: "regular", last: 350, bid: 349.5, hasBid: true, stopPrice: 351.52, stopKind: "synthetic", stopExitLimit: 349.4, quantity: 2 }).type).toBe("fill_stop_exit");
    expect(nextExitAction({ session: "regular", last: 350, bid: 349.5, hasBid: true, stopPrice: 351.52, stopKind: "broker", quantity: 2 })).toEqual({
      type: "fill_broker_stop",
      price: 349.5,
    });
    expect(nextExitAction({ session: "overnight", last: 360, bid: 359, hasBid: true, targetPrice: 358, quantity: 2 })).toEqual({
      type: "fill_target",
      price: 358,
    });
  });
});

describe("simulator cycles", () => {
  it("buys overnight and exits on a later cycle through a synthetic stop", () => {
    let n = 0;
    const ids = () => `id-${++n}`;
    const first = runSimulatorCycle(emptyState(), [quote({ last: 355, asOf: OVERNIGHT.toISOString() })], OVERNIGHT, ids);
    const stop = first.state.orders.find((order) => order.role === "stop");
    expect(first.events.some((event) => event.action === "sim_entry")).toBe(true);
    expect(first.state.positions).toHaveLength(1);
    expect(stop?.type).toBe("synthetic");
    expect(stop?.status).toBe("watching");
    expect(first.state.orders.find((order) => order.role === "target")?.status).toBe("working");

    const through = stop!.stop! - 1;
    const bid = through;
    const second = runSimulatorCycle(first.state, [quote({ last: through, bid, ask: bid + 0.2, asOf: OVERNIGHT.toISOString() })], new Date(OVERNIGHT.getTime() + 5 * 60 * 1000), ids);
    expect(second.events.some((event) => event.action === "synthetic_stop")).toBe(true);
    expect(second.events.some((event) => event.action === "stop_exit_filled")).toBe(true);
    expect(second.state.positions).toHaveLength(0);
    const target = second.state.orders.find((order) => order.role === "target");
    expect(target?.status).toBe("cancelled");
    expect(second.state.orders.some((order) => order.role === "stop_exit" && order.status === "filled")).toBe(true);
    expect(second.state.cash).toBeGreaterThan(0);
  });

  it("holds a synthetic stop over the weekend and attaches a broker stop at the Monday open", () => {
    let n = 0;
    const ids = () => `id-${++n}`;
    const opened = runSimulatorCycle(emptyState(), [quote()], AFTERHOURS, ids);
    expect(opened.state.orders.find((order) => order.role === "stop")?.status).toBe("watching");
    const weekend = runSimulatorCycle(opened.state, [quote({ last: 1, bid: 1, ask: 1.1 })], CLOSED_FRI, ids);
    expect(weekend.state.positions).toHaveLength(1);
    expect(weekend.events.some((event) => event.action === "synthetic_stop")).toBe(false);
    const monday = runSimulatorCycle(weekend.state, [quote({ last: 355, asOf: OPEN_BELL.toISOString() })], OPEN_BELL, ids);
    expect(monday.events.some((event) => event.action === "broker_stop_attached")).toBe(true);
    const stop = monday.state.orders.find((order) => order.role === "stop");
    expect(stop?.type).toBe("stop_market");
    expect(stop?.status).toBe("working");
    expect(monday.state.positions).toHaveLength(1);
  });

  it("fills a gapped regular-hours broker stop at the bid", () => {
    let n = 0;
    const ids = () => `id-${++n}`;
    const opened = runSimulatorCycle(emptyState(), [quote({ asOf: REGULAR.toISOString() })], REGULAR, ids);
    expect(opened.state.orders.find((order) => order.role === "stop")?.type).toBe("stop_market");
    const gapped = runSimulatorCycle(opened.state, [quote({ last: 300, bid: 299.5, ask: 300.2, asOf: REGULAR.toISOString() })], new Date(REGULAR.getTime() + 5 * 60 * 1000), ids);
    expect(gapped.events.some((event) => event.action === "broker_stop_filled")).toBe(true);
    expect(gapped.state.positions).toHaveLength(0);
  });

  it("leaves a copy line that 24/5 buys are watched every 5 minutes", () => {
    expect(SESSION_HELP).toMatch(/24\/5/);
    expect(SESSION_HELP).toMatch(/5 minutes/);
    expect(SESSION_HELP).not.toMatch(/only in regular hours/i);
  });
});

describe("entry bundle hours", () => {
  it("keeps an off-hours take-profit on the session clock and a broker stop template for the open", () => {
    const bundle = buildEntryBundle({
      accountNumber: "2000004028",
      symbol: "AAPL",
      ask: 355.07,
      quantity: 2,
      stopLossPct: 1,
      profitTargetDollars: 7.1,
      refId: "11111111-1111-4111-8111-111111111111",
      session: "overnight",
    });
    expect(bundle.stopKind).toBe("synthetic");
    expect(bundle.entry.market_hours).toBe("all_day_hours");
    expect(bundle.takeProfit.time_in_force).toBe("gtc");
    expect(bundle.stop.type).toBe("stop_market");
    expect(validateOutgoing("place_equity_order", bundle.entry).ok).toBe(true);
    expect(validateOutgoing("place_equity_order", bundle.takeProfit).ok).toBe(true);
    expect(validateOutgoing("place_equity_order", bundle.stop).ok).toBe(true);
  });
});
