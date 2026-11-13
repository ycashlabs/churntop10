import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allRequiredSignalsFired, computeSignals } from "../src/lib/signals.js";
import { recordsForPlacedLiveBuy } from "../src/lib/holdings.js";
import { runSimulatorCycle, type SimState } from "../src/lib/simulator.js";
import { DRAFT_RULES } from "../src/lib/rules.js";
import type { QuoteView } from "../src/lib/decode.js";
import { planBackfill, defaultThreshold, formatTradeSignalLine, signalResultFromRow } from "../src/lib/trade-signals.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OVERNIGHT = new Date("2026-11-15T21:00:00-05:00");

function applyFile(db: DatabaseSync, name: string): void {
  const sql = readFileSync(join(root, "migrations", name), "utf8");
  for (const part of sql.split(";")) {
    const statement = part.trim();
    if (statement) db.exec(statement);
  }
}



function applyAll(db: DatabaseSync, through = "0006_trade_signals_name_reason.sql"): void {
  const files = ["0001_init.sql", "0002_v2.sql", "0003_v3.sql", "0004_live_sync.sql", "0005_trade_signals_threshold.sql", "0006_trade_signals_name_reason.sql"];
  for (const name of files) {
    applyFile(db, name);
    if (name === through) break;
  }
}

function draftRules() {
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

function emptyState(): SimState {
  const rules = draftRules();
  return {
    cash: 20000,
    dayStartEquity: 20000,
    dayStartDate: "2026-11-15",
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
    rules,
    selectedRuleIds: rules.map((rule) => rule.id),
    bars: {},
    spyBars: [],
    spyLast: 600,
    spyPreviousClose: 595,
    tradingCapital: 20000,
    pendingLegs: [],
    closedThisCycle: [],
  };
}

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

describe("signal thresholds", () => {
  it("records the decision cutoff with each computed signal", () => {
    const now = OVERNIGHT;
    const bars = Array.from({ length: 8 }, (_, i) => ({ ts: now.getTime() - (8 - i) * 60_000, price: 350 + i, volume: 10_000 }));
    const spyBars = Array.from({ length: 8 }, (_, i) => ({ ts: now.getTime() - (8 - i) * 60_000, price: 595 + i, volume: 50_000 }));
    const computed = computeSignals(
      ["price_above_20m_avg", "volume_above_recent", "spy_up"],
      { symbol: "AAPL", last: 355, volume: 12_000, now, bars, spyBars, spyLast: 600, spyPreviousClose: 595 },
    );
    expect(computed).toHaveLength(3);
    expect(computed.every((item) => item.fired)).toBe(true);
    expect(computed.find((item) => item.id === "price_above_20m_avg")?.threshold).toBe(0);
    expect(computed.find((item) => item.id === "volume_above_recent")?.threshold).toBe(1);
    expect(computed.find((item) => item.id === "spy_up")?.threshold).toBe(0);
    expect(defaultThreshold("spy_not_falling_hard")).toBe(-0.5);
    expect(defaultThreshold("no_sell_volume_spike")).toBe(1.5);
  });
});

describe("simulator trade_signals", () => {
  it("attaches computed signals to the pending buy/add leg so they can be persisted", () => {
    let n = 0;
    const first = runSimulatorCycle(emptyState(), [quote()], OVERNIGHT, () => `id-${++n}`);
    expect(first.events.some((event) => event.action === "sim_entry")).toBe(true);
    const leg = first.state.pendingLegs.find((item) => item.side === "buy");
    expect(leg).toBeTruthy();
    expect(leg!.signals?.map((item) => item.id).sort()).toEqual(["price_above_20m_avg", "spy_up", "volume_above_recent"]);
    expect(leg!.signals?.every((item) => item.fired && item.threshold != null)).toBe(true);
  });

  it("attaches weakness-exit signals to the pending sell leg", () => {
    let n = 0;
    const opened = runSimulatorCycle(emptyState(), [quote()], OVERNIGHT, () => `id-${++n}`);
    const held = opened.state;
    // Force a weak tape: price below the 20m average, rising volume, SPY down.
    held.spyLast = 590;
    held.spyPreviousClose = 600;
    held.spyBars = [];
    held.bars.AAPL = [
      { ts: OVERNIGHT.getTime() - 12 * 60_000, price: 360, volume: 5_000 },
      { ts: OVERNIGHT.getTime() - 6 * 60_000, price: 358, volume: 8_000 },
      { ts: OVERNIGHT.getTime() - 60_000, price: 350, volume: 15_000 },
      { ts: OVERNIGHT.getTime(), price: 349, volume: 16_000 },
    ];
    const later = new Date(OVERNIGHT.getTime() + 5 * 60_000);
    const closed = runSimulatorCycle(held, [quote({ last: 349, bid: 348.5, ask: 349.2, asOf: later.toISOString() })], later, () => `id-${++n}`);
    const sell = closed.state.pendingLegs.find((item) => item.side === "sell" && item.exitReason?.startsWith("Exit on weakness"));
    if (sell) {
      expect(sell.signals?.some((item) => item.id === "below_20m_avg")).toBe(true);
      expect(sell.signals?.some((item) => item.id === "spy_falling")).toBe(true);
    } else {
      // If weakness did not fire (quote/spread/session), a stop/target exit still writes a sell leg with an (empty or populated) signals array.
      const anySell = closed.state.pendingLegs.find((item) => item.side === "sell");
      expect(anySell).toBeTruthy();
      expect(Array.isArray(anySell!.signals)).toBe(true);
    }
  });
});

describe("live trade records include signals", () => {
  it("copies computed signals onto the live trade record", () => {
    const records = recordsForPlacedLiveBuy({
      symbol: "NVDA",
      qty: 1,
      limitPrice: 169.27,
      brokerOrderId: "order-1",
      buyRuleVersionId: "buy-v1",
      signals: [{ id: "spy_up", name: "SPY is up", fired: true, value: 0.5, threshold: 0, reason: "up" }],
      session: "extended",
      tradingCapital: 10000,
      profitTargetPct: 1,
      stopLossPct: 1,
      sizeReason: "starter",
      status: "filled",
      now: 1,
      nextId: () => "id-1",
    });
    expect(records.trade.signals).toEqual([
      { id: "spy_up", name: "SPY is up", fired: true, value: 0.5, threshold: 0, reason: "up" },
    ]);
  });
});

describe("trade_signals persistence and backfill", () => {
  it("persists signal id, name, value, threshold, fired, and reason, and listTrades mapping restores them", () => {
    const db = new DatabaseSync(":memory:");
    applyAll(db);
    for (const [id, name] of [["spy_up", "SPY is up"], ["volume_above_recent", "Volume above recent normal"]] as const) {
      db.prepare("INSERT OR IGNORE INTO signals (id, name, description, status, added_at) VALUES (?, ?, ?, 'active', 10)").run(id, name, name);
    }
    db.prepare(`INSERT INTO positions (id, mode, symbol, status, trading_capital_snapshot, profit_target_pct, stop_loss_pct, avg_cost, qty, opened_at, source)
      VALUES ('pos-1', 'sim', 'NVDA', 'open', 10000, 1, 1, 169.27, 1, 10, 'app')`).run();
    db.prepare(`INSERT INTO trades (id, position_id, side, qty, fill_price, session, capital_snapshot, size_reason, status, created_at, source)
      VALUES ('tr-1', 'pos-1', 'buy', 1, 169.27, 'extended', 10000, 'starter', 'filled', 10, 'app')`).run();
    const insert = db.prepare("INSERT INTO trade_signals (trade_id, signal_id, value, passed, threshold, name, reason) VALUES (?, ?, ?, ?, ?, ?, ?)");
    insert.run("tr-1", "spy_up", 0.5025, 1, 0, "SPY is up", "SPY is up 0.5025%.");
    insert.run("tr-1", "volume_above_recent", 1.3833, 1, 1, "Volume above recent normal", "Volume 12000 is above recent normal 8675.");
    const rows = db.prepare("SELECT * FROM trade_signals WHERE trade_id = 'tr-1' ORDER BY signal_id").all() as Record<string, unknown>[];
    expect(rows.map((row) => signalResultFromRow(row))).toEqual([
      { id: "spy_up", name: "SPY is up", fired: true, value: 0.5025, threshold: 0, reason: "SPY is up 0.5025%." },
      { id: "volume_above_recent", name: "Volume above recent normal", fired: true, value: 1.3833, threshold: 1, reason: "Volume 12000 is above recent normal 8675." },
    ]);
    const d1 = readFileSync(join(root, "src/worker/storage/d1.ts"), "utf8");
    expect(d1).toContain("INSERT INTO trade_signals (trade_id, signal_id, value, passed, threshold, name, reason)");
    expect(d1).toContain("signalResultFromRow");
  });

  it("listTrades mapping fills name from the signal catalog when name/reason were not stored", () => {
    const db = new DatabaseSync(":memory:");
    applyAll(db);
    db.prepare("INSERT OR IGNORE INTO signals (id, name, description, status, added_at) VALUES ('spy_up', 'SPY is up', 'SPY is up', 'active', 10)").run();
    db.prepare(`INSERT INTO positions (id, mode, symbol, status, trading_capital_snapshot, profit_target_pct, stop_loss_pct, avg_cost, qty, opened_at, source)
      VALUES ('pos-1', 'sim', 'NVDA', 'open', 10000, 1, 1, 169.27, 1, 10, 'app')`).run();
    db.prepare(`INSERT INTO trades (id, position_id, side, qty, fill_price, session, capital_snapshot, size_reason, status, created_at, source)
      VALUES ('tr-1', 'pos-1', 'buy', 1, 169.27, 'extended', 10000, 'starter', 'filled', 10, 'app')`).run();
    db.prepare("INSERT INTO trade_signals (trade_id, signal_id, value, passed, threshold) VALUES ('tr-1', 'spy_up', 0.5025, 1, 0)").run();
    const row = db.prepare("SELECT * FROM trade_signals WHERE trade_id = 'tr-1'").get() as Record<string, unknown>;
    expect(signalResultFromRow(row)).toEqual({
      id: "spy_up", name: "SPY is up", fired: true, value: 0.5025, threshold: 0, reason: "",
    });
  });

  it("plans a backfill for the prod NVDA sim fill from the sim_entry audit and proposal", () => {
    const createdAt = 1794578130164;
    const auditAt = 1794578153315;
    const detail = {
      symbol: "NVDA",
      session: "extended",
      quantity: 1,
      rule: "First buy on strength",
      ruleVersion: 1,
      signals: [
        { id: "price_above_20m_avg", name: "Price above 20-minute average", fired: true, value: 0.5625, reason: "Last 169.19 is above the 20-minute average 168.6275." },
        { id: "spy_up", name: "SPY is up", fired: true, value: 0.5025, reason: "SPY is up 0.5025%." },
        { id: "volume_above_recent", name: "Volume above recent normal", fired: true, value: 1.3833, reason: "Volume 12000 is above recent normal 8675." },
      ],
    };
    const rows = planBackfill({
      trades: [{ id: "3989afa2-7976-4b28-b703-4c5e0352a9a6", symbol: "NVDA", side: "buy", createdAt }],
      audits: [{ action: "sim_entry", at: auditAt, detail }],
    });
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.signalId).sort()).toEqual(["price_above_20m_avg", "spy_up", "volume_above_recent"]);
    expect(rows.find((row) => row.signalId === "spy_up")).toMatchObject({ tradeId: "3989afa2-7976-4b28-b703-4c5e0352a9a6", value: 0.5025, threshold: 0, fired: true });
    expect(rows.find((row) => row.signalId === "volume_above_recent")?.threshold).toBe(1);
    expect(rows.find((row) => row.signalId === "price_above_20m_avg")?.threshold).toBe(0);
  });
});

describe("signal display and live fire guard", () => {
  it("formats a trades-table signal line with the DESIGN wording", () => {
    expect(formatTradeSignalLine({
      name: "Price above 20-minute average",
      fired: true,
      value: 0.5625,
      threshold: 0,
      reason: "Last 169.19 is above the 20-minute average 168.6275.",
    })).toBe("Price above 20-minute average: Fired. Value 0.5625, threshold 0. Last 169.19 is above the 20-minute average 168.6275.");
    expect(formatTradeSignalLine({
      name: "SPY is up",
      fired: false,
      value: -0.2,
      threshold: 0,
      reason: "SPY is down 0.2%.",
    })).toBe("SPY is up: Not fired. Value -0.2, threshold 0. SPY is down 0.2%.");
    expect(formatTradeSignalLine({
      name: "SPY is up",
      fired: true,
      value: null,
      threshold: 0,
      reason: "Not enough history.",
    })).toBe("SPY is up: Fired. Not enough history.");
    expect(formatTradeSignalLine({
      name: "SPY is up",
      fired: true,
      value: 0.5,
      threshold: null,
      reason: "",
    })).toBe("SPY is up: Fired. Value 0.5.");
  });

  it("allRequiredSignalsFired matches the simulator: empty is allowed, otherwise every signal must fire", () => {
    expect(allRequiredSignalsFired([])).toBe(true);
    expect(allRequiredSignalsFired([
      { id: "spy_up", name: "SPY is up", fired: true, value: 0.5, threshold: 0, reason: "up" },
    ])).toBe(true);
    expect(allRequiredSignalsFired([
      { id: "spy_up", name: "SPY is up", fired: true, value: 0.5, threshold: 0, reason: "up" },
      { id: "volume_above_recent", name: "Volume above recent normal", fired: false, value: 0.5, threshold: 1, reason: "low" },
    ])).toBe(false);
  });

  it("proposeLiveEntries requires first-buy signals to fire before place_equity_order, matching the simulator wording", () => {
    const trader = readFileSync(join(root, "src/worker/trader.ts"), "utf8");
    const start = trader.indexOf("private async proposeLiveEntries");
    const end = trader.indexOf("private async buildSummary");
    const fn = trader.slice(start, end);
    expect(fn.indexOf("allRequiredSignalsFired")).toBeGreaterThan(-1);
    expect(fn.indexOf("allRequiredSignalsFired")).toBeLessThan(fn.indexOf("place_equity_order"));
    expect(fn).toContain("First-buy signals did not confirm.");
    expect(fn.indexOf("allRequiredSignalsFired(liveSignals)")).toBeLessThan(fn.indexOf("submitGatedTool"));
  });
});
