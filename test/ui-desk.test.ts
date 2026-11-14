import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { closedPnlSum, etDayStart, signedDayPnl, windowWinRate } from "../src/lib/desk-stats.js";
import { quoteChange } from "../src/lib/quote-change.js";
import { applyTheme, parseTheme, readTheme, THEME_KEY, writeTheme, type ThemeStorage } from "../src/client/theme.js";
import {
  bestAndWorst,
  countTradesSince,
  defaultStripBook,
  formatSignedUsd,
  resetStripSamples,
  rememberSample,
  startStripPoll,
  stripModelFromSimulator,
  stripModelFromSummary,
  stripPollPath,
  stripPollUsesSummarySync,
  STRIP_POLL_MS,
  type Book,
} from "../src/client/strip.js";
import { columnVisibility, compareValues, nextSort, sortRows } from "../src/client/table-sort.js";
import { DISABLED_RULE_FILTERS, filterRules, RULE_FILTERS, ruleFilterEnabled } from "../src/client/rules-table.js";
import { buildTopRows, exitDistances, parseUsd } from "../src/client/top10-table.js";
import type { PositionView, RuleView, SimulatorView, Summary } from "../src/lib/api-types.js";

function memory(): ThemeStorage & { bag: Map<string, string> } {
  const bag = new Map<string, string>();
  return {
    bag,
    getItem: (key) => bag.get(key) ?? null,
    setItem: (key, value) => { bag.set(key, value); },
  };
}

function rule(partial: Partial<RuleView> & Pick<RuleView, "id" | "name" | "status">): RuleView {
  return {
    familyId: partial.familyId ?? partial.id,
    side: partial.side ?? "buy",
    body: partial.body ?? "Body text",
    signals: partial.signals ?? ["spy_up"],
    version: partial.version ?? 1,
    createdAt: 0,
    updatedAt: 0,
    lastTriggeredAt: partial.lastTriggeredAt ?? null,
    scorecard: partial.scorecard ?? { tradeCount: 0, winRate: null, avgProfit: null, worstLoss: null },
    ...partial,
  };
}

describe("theme persistence", () => {
  it("defaults to light and only stores light or dark", () => {
    const store = memory();
    expect(readTheme(store)).toBe("light");
    expect(parseTheme("system")).toBe("light");
    expect(parseTheme(null)).toBe("light");
    writeTheme("dark", store);
    expect(store.getItem(THEME_KEY)).toBe("dark");
    expect(readTheme(store)).toBe("dark");
    writeTheme("light", store);
    expect(readTheme(store)).toBe("light");
  });

  it("applies the saved theme on the document root", () => {
    const root = { dataset: {} as { theme?: string }, style: { colorScheme: "" } };
    applyTheme(readTheme(null), root);
    expect(root.dataset.theme).toBe("light");
    expect(root.style.colorScheme).toBe("light");
    applyTheme("dark", root);
    expect(root.dataset.theme).toBe("dark");
    expect(root.style.colorScheme).toBe("dark");
  });
});

describe("table sort", () => {
  it("sorts numbers and text, keeps nulls last, and is stable", () => {
    const rows = [
      { name: "b", n: 2 },
      { name: "a", n: null as number | null },
      { name: "c", n: 2 },
      { name: "d", n: -1 },
    ];
    expect(sortRows(rows, (row) => row.n, "asc").map((row) => row.name)).toEqual(["d", "b", "c", "a"]);
    expect(sortRows(rows, (row) => row.n, "desc").map((row) => row.name)).toEqual(["b", "c", "d", "a"]);
    expect(sortRows(rows, (row) => row.name, "asc").map((row) => row.name)).toEqual(["a", "b", "c", "d"]);
    expect(compareValues(null, 1, "desc")).toBe(1);
  });

  it("toggles direction and starts numbers high-to-low", () => {
    expect(nextSort(null, "pnl", true)).toEqual({ key: "pnl", dir: "desc" });
    expect(nextSort({ key: "pnl", dir: "desc" }, "pnl", true)).toEqual({ key: "pnl", dir: "asc" });
    expect(nextSort(null, "symbol", false)).toEqual({ key: "symbol", dir: "asc" });
    expect(nextSort({ key: "symbol", dir: "asc" }, "name", false)).toEqual({ key: "name", dir: "asc" });
  });

  it("keeps locked columns when a saved list hides them", () => {
    const columns = [{ id: "rank", locked: true }, { id: "symbol", locked: true }, { id: "change" }];
    expect(columnVisibility(null, columns)).toEqual({ rank: true, symbol: true, change: true });
    expect(columnVisibility(["change"], columns)).toEqual({ rank: true, symbol: true, change: true });
    expect(columnVisibility([], columns).change).toBe(false);
  });
});

describe("rules filters", () => {
  const now = Date.parse("2026-11-14T15:00:00Z");
  const rules = [
    rule({ id: "a", name: "First buy on strength", status: "experimenting", scorecard: { tradeCount: 4, winRate: 0.5, avgProfit: 1.2, worstLoss: -3 } }),
    rule({ id: "b", name: "Take profit", status: "proven", side: "sell", signals: [], scorecard: { tradeCount: 10, winRate: 0.7, avgProfit: -2, worstLoss: -8 }, lastTriggeredAt: now - 60_000 }),
    rule({ id: "c", name: "Old exit", status: "retired", lastTriggeredAt: now - 3 * 24 * 60 * 60 * 1000, scorecard: { tradeCount: 2, winRate: 0, avgProfit: -1, worstLoss: -1 } }),
    rule({ id: "d", name: "Quiet", status: "experimenting" }),
  ];

  it("ships every preset name and disables the points filters", () => {
    expect(RULE_FILTERS).toEqual([
      "All", "Active", "Proven", "Experimenting", "Suggest approval", "Suggest retire", "Top scorers", "Losing money", "Recently triggered",
    ]);
    expect(ruleFilterEnabled("Suggest approval")).toBe(false);
    expect(ruleFilterEnabled("Suggest retire")).toBe(false);
    expect(ruleFilterEnabled("Top scorers")).toBe(false);
    expect(DISABLED_RULE_FILTERS["Suggest approval"]).toMatch(/never auto-approves/);
    expect(filterRules(rules, "Suggest approval", "", now).map((item) => item.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("filters on status, losing money, recent triggers, and search", () => {
    expect(filterRules(rules, "Active", "", now).map((item) => item.id)).toEqual(["a", "b", "d"]);
    expect(filterRules(rules, "Proven", "", now).map((item) => item.id)).toEqual(["b"]);
    expect(filterRules(rules, "Experimenting", "", now).map((item) => item.id)).toEqual(["a", "d"]);
    expect(filterRules(rules, "Losing money", "", now).map((item) => item.id)).toEqual(["b", "c"]);
    expect(filterRules(rules, "Recently triggered", "", now).map((item) => item.id)).toEqual(["b"]);
    expect(filterRules(rules, "All", "settings", now).map((item) => item.id)).toEqual(["b"]);
    expect(filterRules(rules, "All", "strength", now).map((item) => item.id)).toEqual(["a"]);
  });
});

describe("strip refresh", () => {
  it("polls the simulator or the read-only summary, never the syncing summary", () => {
    expect(stripPollPath("sim")).toBe("/api/simulator");
    expect(stripPollPath("live")).toBe("/api/summary?read=1");
    expect(stripPollUsesSummarySync("/api/summary")).toBe(true);
    expect(stripPollUsesSummarySync("/api/summary?read=1")).toBe(false);
    expect(stripPollUsesSummarySync("/api/simulator")).toBe(false);
    expect(STRIP_POLL_MS).toBe(5 * 60 * 1000);

    vi.useFakeTimers();
    const paths: string[] = [];
    let book: Book = "sim";
    const listeners = new Map<string, () => void>();
    const target = {
      visibilityState: "hidden",
      addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener); },
      removeEventListener: () => { listeners.clear(); },
    };
    const stop = startStripPoll({
      book: () => book,
      load: (path) => paths.push(path),
      target,
      intervalMs: STRIP_POLL_MS,
    });
    expect(paths).toEqual([]);
    vi.advanceTimersByTime(STRIP_POLL_MS);
    book = "live";
    vi.advanceTimersByTime(STRIP_POLL_MS);
    target.visibilityState = "visible";
    listeners.get("visibilitychange")?.();
    stop();
    vi.useRealTimers();

    expect(paths).toEqual(["/api/simulator", "/api/summary?read=1", "/api/summary?read=1"]);
    expect(paths.some((path) => stripPollUsesSummarySync(path))).toBe(false);
  });

  it("does not call /api/summary from the strip interval in the client source", () => {
    const source = readFileSync(new URL("../src/client/AccountStrip.tsx", import.meta.url), "utf8");
    expect(source).toContain("startStripPoll");
    expect(source).toContain("getSummaryRead");
    expect(source).not.toContain('"/api/summary"');
    expect(source).not.toContain("getSummary()");
    const trader = readFileSync(new URL("../src/worker/trader.ts", import.meta.url), "utf8");
    const start = trader.indexOf("async summaryRead");
    const end = trader.indexOf("async cycle(");
    expect(trader.slice(start, end)).not.toContain("syncLiveHoldings");
  });

  it("defaults the book to Sim in View Only and Live when mode is live", () => {
    expect(defaultStripBook("view_only")).toBe("sim");
    expect(defaultStripBook("live")).toBe("live");
  });
});

describe("strip figures and quote change", () => {
  it("computes ET day start, signed day P&L, and win-rate windows", () => {
    expect(etDayStart(new Date("2026-11-14T13:33:00Z"))).toBe(Date.parse("2026-11-14T05:00:00.000Z"));
    expect(etDayStart(new Date("2026-11-14T04:59:00Z"))).toBe(Date.parse("2026-11-13T05:00:00.000Z"));
    expect(etDayStart(new Date("2026-07-14T16:00:00Z"))).toBe(Date.parse("2026-07-14T04:00:00.000Z"));
    expect(signedDayPnl(10247.18, 10200)).toBe(47.18);
    const start = etDayStart(new Date("2026-11-14T15:00:00Z"));
    const rows = [
      { pnl: 10, closedAt: start + 1000 },
      { pnl: -4, closedAt: start + 2000 },
      { pnl: 3, closedAt: start - 2 * 24 * 60 * 60 * 1000 },
      { pnl: 99, closedAt: null, exitType: "imported" },
    ];
    expect(windowWinRate(rows, start, start + 86_400_000)).toEqual({ rate: 0.5, count: 2 });
    expect(windowWinRate(rows, start - 6 * 86_400_000, start + 86_400_000).count).toBe(3);
    expect(closedPnlSum(rows)).toBe(9);
    expect(quoteChange(226.4, 225.2)).toEqual({ change: 1.2, changePct: 0.53 });
    expect(quoteChange(100, undefined)).toBeNull();
  });

  it("builds sim tiles from the simulator payload and masks nothing that is not an account", () => {
    resetStripSamples();
    const sim = {
      cash: "$6,410.00",
      equity: "$10,247.18",
      dailyLoss: "$0.00",
      dailyLossCap: "$100.00",
      ordersToday: 3,
      orderCap: 100,
      killed: false,
      session: "regular",
      clock: "2026-11-14 08:26 ET",
      quoteSource: "recorded",
      selectedRuleIds: [],
      tradingCapital: { saved: 10000, savedUsd: "$10,000.00", balance: 10247.18, balanceUsd: "$10,247.18", effective: 10000, effectiveUsd: "$10,000.00", warn: false, exposure: 3837, exposureUsd: "$3,837.00", paused: false, presets: [] },
      positions: [position("NVDA", "sim", "+$128.40"), position("TSLA", "sim", "−$42.00")],
      orders: [],
      trades: [],
      events: [],
      proposals: [],
      desk: { dayStartEquity: 10200, dayPnl: 47.18, equityValue: 10247.18, closedPnl: 12, winRateToday: 0.62, winRate7d: 0.55 },
    } as SimulatorView;
    const model = stripModelFromSimulator(sim);
    expect(model.book).toBe("sim");
    expect(model.maskedAccount).toBeNull();
    expect(model.tiles.find((tile) => tile.id === "day")?.value).toBe(formatSignedUsd(47.18));
    expect(model.tiles.find((tile) => tile.id === "trades")?.value).toBe("3 / 100");
    expect(model.tiles.find((tile) => tile.id === "win")?.value).toBe("62% / 55%");
    expect(model.tiles.find((tile) => tile.id === "best")?.value).toContain("NVDA");
    expect(model.tiles.find((tile) => tile.id === "worst")?.value).toContain("TSLA");
    expect(model.tiles.find((tile) => tile.label === "Cash")).toBeTruthy();
    const samples = rememberSample("sim:equity", 10247.18, "2026-11-14");
    expect(rememberSample("sim:equity", 10247.18, "2026-11-14")).toEqual(samples);
    expect(rememberSample("sim:equity", 10250, "2026-11-14")).toHaveLength(2);
    expect(rememberSample("sim:equity", 1, "2026-11-15")).toEqual([1]);
  });

  it("shows a masked live account and does not invent a balance when disconnected", () => {
    const summary = {
      mode: "view_only",
      killed: false,
      liveGate: false,
      session: "regular",
      clock: "2026-11-14 08:26 ET",
      quoteSource: "recorded",
      connected: false,
      robinhoodStatus: "not_connected",
      robinhood: null,
      settings: { profitTargetPct: 1, stopLossPct: 1, dailyLossPct: 1, orderCap: 100, tradingCapital: 10000 },
      top10: [],
      positions: [],
    } as Summary;
    const offline = stripModelFromSummary(summary, Date.parse("2026-11-14T15:00:00Z"));
    expect(offline.tiles.find((tile) => tile.id === "equity")?.value).toBe("Not connected");
    expect(offline.maskedAccount).toBeNull();
    expect(JSON.stringify(offline)).not.toContain("SIM0000999");
    summary.robinhoodStatus = "connected";
    summary.connected = true;
    summary.robinhood = {
      maskedAccount: "••••4028",
      nickname: "Desk",
      brokerageType: "individual",
      tradingType: "cash",
      agentic: true,
      totalValue: "$24,180.55",
      cash: "$1,000.00",
      buyingPower: "$18,220.00",
      pendingDeposits: "$0.00",
      todayPnl: "$62.10",
      unsettled: "$0.00",
    };
    summary.positions = [position("AAPL", "live", "+$40.00", Date.parse("2026-11-14T14:00:00Z"))];
    const live = stripModelFromSummary(summary, Date.parse("2026-11-14T15:00:00Z"));
    expect(live.maskedAccount).toBe("••••4028");
    expect(live.tiles.find((tile) => tile.id === "cash")?.label).toBe("Buying power");
    expect(live.tiles.find((tile) => tile.id === "day")?.title).toMatch(/Today realized/);
    expect(live.tiles.find((tile) => tile.id === "trades")?.value).toBe("1");
    expect(bestAndWorst([{ symbol: "AAPL", pnl: 1 }])).toEqual({ best: { symbol: "AAPL", pnl: 1 }, worst: null });
    expect(countTradesSince(summary.positions, etDayStart(new Date("2026-11-14T15:00:00Z")))).toBe(1);
    expect(parseUsd("−$42.00")).toBe(-42);
    expect(parseUsd("Unavailable")).toBeNull();
  });
});

describe("top 10 rows", () => {
  it("falls back to the symbol and em dashes when no SEC company is on the quote", () => {
    const rows = buildTopRows({
      top10: [{ symbol: "AAPL", bid: "$226.38", ask: "$226.42", last: "$226.40", tradable: true, change: 1.2, changePct: 0.53 }],
      live: [position("AAPL", "live", "+$27.60")],
      sim: [],
      proposals: [{ symbol: "AAPL", verdict: "checked", message: "Checked. Ready for the simulator.", at: 2 }, { symbol: "AAPL", verdict: "older", message: "old", at: 1 }],
    });
    const row = rows[0];
    expect(row?.rank).toBe(1);
    expect(row?.changePct).toBe(0.53);
    expect(row?.position).toContain("Live");
    expect(row?.check).toBe("checked");
    expect(row?.checkTitle).toContain("Checked. Ready for the simulator.");
    expect(row?.name).toBe("");
    expect(row?.sector).toBe("—");
    expect(row?.industry).toBe("—");
    const distances = exitDistances(226.4, 224.1, 1, 1);
    expect(distances?.targetPrice).toBeCloseTo(224.1 * 1.01, 4);
    expect(distances?.stopPrice).toBeCloseTo(224.1 * 0.99, 4);
  });
});

function position(symbol: string, mode: "live" | "sim", pnl: string, at = 0): PositionView {
  return {
    id: symbol,
    symbol,
    mode,
    status: "open",
    quantity: "1",
    avgCost: "$100.00",
    last: "$101.00",
    marketValue: "$101.00",
    pnl,
    tradingCapital: "$10,000.00",
    profitTargetPct: 1,
    stopLossPct: 1,
    buyRule: "First buy on strength v1",
    trades: [{ id: "t", side: "buy", quantity: "1", price: "$100.00", status: "filled", session: "regular", sizeReason: "starter", at }],
  };
}
