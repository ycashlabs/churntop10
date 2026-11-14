import { DurableObject } from "cloudflare:workers";
import recordedQuotes from "../../docs/contracts/robinhood/fixtures/get_equity_quotes.json";
import recordedHoldings from "../../docs/contracts/robinhood/fixtures/get_equity_positions_tsll.json";
import type { Summary } from "../lib/api-types.js";
import { etParts, marketSession } from "../lib/clock.js";
import { displayField, parseAccounts, parseOrders, parsePlacedOrder, parsePortfolio, parsePositions, parseQuotes, parseRealizedPnl, selectAgentic, type OrderView, type QuoteView } from "../lib/decode.js";
import { maskAccountNumber, redactJson } from "../lib/mask.js";
import { formatShares, formatUsd, roundMoney } from "../lib/money.js";
import { tradingMcpUrl } from "../lib/oauth.js";
import { submitGatedTool } from "../lib/broker.js";
import { assertOutgoing } from "../lib/requests.js";
import { applyOrderFill, labelBuyRule, recordsForPlacedLiveBuy, reconcileLiveHoldings, shouldComputeScores, type BrokerHolding } from "../lib/holdings.js";
import { equityOf, ordersToday, runSimulatorCycle, sellAllSimPositions, type SimEvent, type SimState } from "../lib/simulator.js";
import { allRequiredSignalsFired, computeSignals, type SignalResult } from "../lib/signals.js";
import { PROPOSAL_CAP } from "../lib/sim-persist.js";
import { closedPnlSum, etDayStart, signedDayPnl, windowWinRate } from "../lib/desk-stats.js";
import { quoteChange } from "../lib/quote-change.js";
import { dailyLossAmount, validExitPct, validateNewBuy, type GuardContext } from "../lib/validator.js";
import type { RuleSide, RuleStatus } from "../lib/rules.js";
import type { DeskFigures, SimulatorView, RuleView, RuleHistoryView, PositionView, ReviewScreen } from "../lib/api-types.js";
import { decryptString, importTokenKey } from "./crypto.js";
import type { Env } from "./env.js";
import { effectiveTradingCapital, openExposure, tradingCapitalPresets, validTradingCapital } from "../lib/capital.js";
import { buildPositionReview } from "../lib/reviews.js";
import type { PositionRecord, ReviewFilters, Storage, TradeRecord } from "../lib/storage.js";
import { prepareStorage } from "./storage/d1.js";

const DEFAULT_TOP10 = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "AVGO", "TSLA", "JPM", "LLY"];

interface SettingsRow {
  profit_target_pct: number;
  stop_loss_pct: number;
  max_order_pct: number;
  daily_loss_pct: number;
  pdt_limit: number;
  order_cap?: number;
  trading_capital?: number;
  mode: "view_only" | "live";
  killed: number;
  day_start_equity: number;
  day_start_date: string;
  cash: number;
  account_number: string;
}

export class AccountTrader extends DurableObject<Env> {
  private storageHandle?: Storage;

  private async store(): Promise<Storage> {
    if (!this.storageHandle) this.storageHandle = await prepareStorage(this.env.DB);
    return this.storageHandle;
  }

  async summary(): Promise<Summary> {
    await this.seed();
    await this.syncLiveHoldings();
    return this.buildSummary(await this.quoteBook());
  }

  /** Same figures as summary(), without syncLiveHoldings(). Reads only, plus the existing quote-failure audit. */
  async summaryRead(): Promise<Summary> {
    await this.seed();
    return this.buildSummary(await this.quoteBook());
  }

  async cycle(): Promise<Summary> {
    await this.seed();
    const book = await this.quoteBook();
    const now = new Date();
    // Account / live path never writes simulator fills. Live broker orders stay behind the gate.
    if (this.env.ALLOW_LIVE_TRADING === "1") await this.proposeLiveEntries(book.quotes, now);
    const summary = await this.buildSummary(book);
    await this.audit("cycle", { session: summary.session, mode: summary.mode, killed: summary.killed, quoteSource: summary.quoteSource, path: "account" });
    return summary;
  }

  async cycleSimulator(selectedRuleIds?: string[]): Promise<SimulatorView> {
    await this.seed();
    if (selectedRuleIds) await this.setSelectedRules(selectedRuleIds);
    const book = await this.quoteBook();
    const now = new Date();
    const { state, events } = runSimulatorCycle(await this.loadSim(), book.quotes, now, () => crypto.randomUUID(), book.source, true);
    await this.saveSim(state, book.quotes);
    for (const event of events) await this.audit(event.action, event.detail);
    await this.audit("sim_cycle", { session: marketSession(now), quoteSource: book.source, events: events.length });
    return this.buildSimulator(book, events);
  }

  async tickSimulator(): Promise<void> {
    await this.seed();
    await this.syncLiveHoldings();
    await this.cycleSimulator();
    const closed = await (await this.store()).listPositions(undefined, "closed");
    if (shouldComputeScores(closed.length)) await this.maybeComputeScores();
  }

  async simulator(): Promise<SimulatorView> {
    await this.seed();
    return this.buildSimulator(await this.quoteBook());
  }

  async listRuleViews(): Promise<RuleView[]> {
    await this.seed();
    return this.ruleViews();
  }

  async createRuleView(input: { name: string; side: RuleSide; body: string; signals: string[] }): Promise<RuleView[]> {
    await this.seed();
    await (await this.store()).createRule(input);
    await this.audit("rule_created", { name: input.name, side: input.side });
    return this.ruleViews();
  }

  async editRuleView(id: string, input: { name?: string; body?: string; signals?: string[] }): Promise<RuleView[]> {
    await this.seed();
    const rule = await (await this.store()).editRule(id, input);
    await this.audit("rule_edited", { id, familyId: rule.familyId, version: rule.version, status: rule.status });
    return this.ruleViews();
  }

  async setRuleStatusView(id: string, status: RuleStatus): Promise<RuleView[]> {
    await this.seed();
    const rule = await (await this.store()).setRuleStatus(id, status);
    await this.audit(status === "proven" ? "rule_approved" : "rule_status", { id, familyId: rule.familyId, status, version: rule.version });
    return this.ruleViews();
  }

  async ruleHistoryView(familyId: string): Promise<RuleHistoryView[]> {
    await this.seed();
    return (await (await this.store()).listRuleHistory(familyId)).map((row) => ({
      id: row.id,
      action: row.action,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      version: row.version,
      detail: row.detail,
      at: row.at,
    }));
  }

  async setSelectedRules(ids: string[]): Promise<SimulatorView> {
    await this.seed();
    await this.env.DB.prepare("DELETE FROM sim_selected_rules").run();
    if (ids.length) {
      await this.env.DB.batch(ids.map((id) => this.env.DB.prepare("INSERT INTO sim_selected_rules (rule_id) VALUES (?)").bind(id)));
    }
    await this.audit("sim_rules_selected", { ids });
    return this.simulator();
  }

  async saveTop10(symbols: string[]): Promise<Summary> {
    await this.seed();
    const clean = symbols.map((symbol) => symbol.trim().toUpperCase());
    if (clean.length < 1 || clean.length > 10 || clean.some((symbol) => !/^[A-Z]{1,5}$/.test(symbol)) || new Set(clean).size !== clean.length) {
      throw new Error("Enter 1 to 10 unique letter symbols.");
    }
    await this.env.DB.prepare("DELETE FROM top10").run();
    await this.env.DB.batch(clean.map((symbol, index) => this.env.DB.prepare("INSERT INTO top10 (rank, symbol) VALUES (?, ?)").bind(index + 1, symbol)));
    await this.audit("top10", { symbols: clean });
    return this.summary();
  }

  async saveSettings(input: { profitTargetPct: number; stopLossPct: number; dailyLossPct: number; orderCap: number; tradingCapital?: number }): Promise<Summary> {
    await this.seed();
    const { profitTargetPct, stopLossPct, dailyLossPct, orderCap } = input;
    if (!validExitPct(profitTargetPct)) throw new Error("Profit target must be a positive percent no greater than 100.");
    if (!validExitPct(stopLossPct)) throw new Error("Stop-loss must be a positive percent no greater than 100.");
    if (!validExitPct(dailyLossPct)) throw new Error("Daily loss stop must be a positive percent no greater than 100.");
    if (orderCap < 1 || orderCap > 1000) throw new Error("Order cap must be between 1 and 1000 orders per day.");
    const store = await this.store();
    const patch: { profitTargetPct: number; stopLossPct: number; dailyLossPct: number; orderCap: number; tradingCapital?: number } = { profitTargetPct, stopLossPct, dailyLossPct, orderCap };
    if (input.tradingCapital != null) {
      if (!validTradingCapital(input.tradingCapital)) throw new Error("Trading capital must be a positive dollar amount.");
      patch.tradingCapital = input.tradingCapital;
    }
    await store.saveSettings(patch);
    await this.audit("settings", patch);
    return this.summary();
  }

  async setMode(mode: "view_only" | "live"): Promise<Summary> {
    await this.seed();
    if (mode !== "view_only" && mode !== "live") throw new Error("Unknown mode.");
    await this.env.DB.prepare("UPDATE app_settings SET mode = ? WHERE id = 1").bind(mode).run();
    await this.audit("mode", { mode, liveGate: this.env.ALLOW_LIVE_TRADING === "1" });
    return this.summary();
  }

  async sellAll(): Promise<SimulatorView> {
    await this.seed();
    const book = await this.quoteBook();
    const now = new Date();
    const { state, events } = sellAllSimPositions(await this.loadSim(), book.quotes, now, () => crypto.randomUUID());
    await this.saveSim(state, book.quotes);
    await this.env.DB.prepare("UPDATE app_settings SET killed = 1 WHERE id = 1").run();
    for (const event of events) await this.audit(event.action, event.detail);
    await this.audit("sell_all", { liveCancel: "suppressed", events: events.length });
    return this.buildSimulator(book, events);
  }

  async kill(): Promise<Summary> {
    await this.sellAll();
    return this.summary();
  }

  async resume(): Promise<Summary> {
    await this.seed();
    await this.env.DB.prepare("UPDATE app_settings SET killed = 0, mode = 'view_only' WHERE id = 1").run();
    await this.audit("resume", { mode: "view_only" });
    return this.summary();
  }

  private async seed(): Promise<void> {
    await this.ensureV2();
    await this.ensureLiveSync();
    await this.ensureTradeSignalsSchema();
    const existing = await this.env.DB.prepare("SELECT id FROM app_settings WHERE id = 1").first();
    if (!existing) {
      const today = etParts(new Date()).date;
      await this.env.DB.prepare(`INSERT INTO app_settings
        (id, profit_target_pct, stop_loss_pct, max_order_pct, daily_loss_pct, pdt_limit, order_cap, trading_capital, mode, killed, day_start_equity, day_start_date, cash, account_number)
        VALUES (1, 1, 1, 10, 1, 3, 100, 10000, 'view_only', 0, 10000, ?, 10000, 'SIM0000999')`).bind(today).run();
      await this.env.DB.batch(DEFAULT_TOP10.map((symbol, index) => this.env.DB.prepare("INSERT INTO top10 (rank, symbol) VALUES (?, ?)").bind(index + 1, symbol)));
    }
    await (await this.store()).seedDraftRules();
  }



  private async ensureTradeSignalsSchema(): Promise<void> {
    const cols = (await this.env.DB.prepare("PRAGMA table_info(trade_signals)").all<{ name: string }>()).results.map((row) => row.name);
    if (cols.length === 0) return;
    const add: Array<[string, string]> = [
      ["threshold", "ALTER TABLE trade_signals ADD COLUMN threshold REAL"],
      ["name", "ALTER TABLE trade_signals ADD COLUMN name TEXT"],
      ["reason", "ALTER TABLE trade_signals ADD COLUMN reason TEXT"],
    ];
    for (const [name, sql] of add) {
      if (!cols.includes(name)) {
        await this.env.DB.prepare(sql).run();
        cols.push(name);
      }
    }
  }

  private async ensureLiveSync(): Promise<void> {
    const addSource = async (table: string) => {
      const cols = (await this.env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results.map((row) => row.name);
      if (cols.length > 0 && !cols.includes("source")) {
        await this.env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN source TEXT NOT NULL DEFAULT 'app'`).run();
      }
    };
    await addSource("positions");
    await addSource("trades");
    await this.env.DB.prepare("CREATE INDEX IF NOT EXISTS positions_mode_symbol_status_idx ON positions (mode, symbol, status)").run();
    await this.env.DB.prepare("CREATE INDEX IF NOT EXISTS trades_broker_order_idx ON trades (broker_order_id)").run();
  }

  private async ensureV2(): Promise<void> {
    const cols = (await this.env.DB.prepare("PRAGMA table_info(app_settings)").all<{ name: string }>()).results.map((row) => row.name);
    if (!cols.includes("order_cap")) {
      await this.env.DB.prepare("ALTER TABLE app_settings ADD COLUMN order_cap INTEGER NOT NULL DEFAULT 100").run();
    }
    await this.env.DB.prepare("CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, family_id TEXT NOT NULL, name TEXT NOT NULL, side TEXT NOT NULL, body TEXT NOT NULL, signals TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)").run();
    await this.env.DB.prepare("CREATE TABLE IF NOT EXISTS rule_history (id TEXT PRIMARY KEY, rule_id TEXT NOT NULL, family_id TEXT NOT NULL, action TEXT NOT NULL, from_status TEXT, to_status TEXT, version INTEGER NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL)").run();
    await this.env.DB.prepare("CREATE TABLE IF NOT EXISTS sim_trades (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, quantity REAL NOT NULL, entry_price REAL NOT NULL, exit_price REAL NOT NULL, pnl REAL NOT NULL, opened_on TEXT NOT NULL, closed_at INTEGER NOT NULL, buy_rule_id TEXT, buy_rule_version INTEGER, sell_rule_id TEXT, sell_rule_version INTEGER, signals TEXT NOT NULL, reason TEXT NOT NULL)").run();
    await this.env.DB.prepare("CREATE TABLE IF NOT EXISTS sim_selected_rules (rule_id TEXT PRIMARY KEY)").run();
    await this.env.DB.prepare("CREATE TABLE IF NOT EXISTS quote_bars (symbol TEXT NOT NULL, ts INTEGER NOT NULL, price REAL NOT NULL, volume REAL NOT NULL, PRIMARY KEY (symbol, ts))").run();
    const posCols = (await this.env.DB.prepare("PRAGMA table_info(sim_positions)").all<{ name: string }>()).results.map((row) => row.name);
    for (const [name, sql] of [
      ["buy_rule_id", "ALTER TABLE sim_positions ADD COLUMN buy_rule_id TEXT"],
      ["buy_rule_version", "ALTER TABLE sim_positions ADD COLUMN buy_rule_version INTEGER"],
      ["sell_rule_id", "ALTER TABLE sim_positions ADD COLUMN sell_rule_id TEXT"],
      ["sell_rule_version", "ALTER TABLE sim_positions ADD COLUMN sell_rule_version INTEGER"],
    ] as const) {
      if (!posCols.includes(name)) await this.env.DB.prepare(sql).run();
    }
  }

  private async settings(): Promise<SettingsRow> {
    const row = await this.env.DB.prepare("SELECT * FROM app_settings WHERE id = 1").first<SettingsRow>();
    if (!row) throw new Error("settings missing");
    return row;
  }

  private async quoteBook(): Promise<{ quotes: QuoteView[]; source: "recorded" | "robinhood" }> {
    const live = await this.liveQuotes();
    if (live && live.length > 0) return { quotes: live, source: "robinhood" };
    return { quotes: parseQuotes(recordedQuotes), source: "recorded" };
  }

  private async liveQuotes(): Promise<QuoteView[] | undefined> {
    const token = await this.accessToken().catch(() => undefined);
    if (!token) return undefined;
    const top = (await this.env.DB.prepare("SELECT symbol FROM top10 ORDER BY rank").all<{ symbol: string }>()).results.map((row) => row.symbol);
    const store = await this.store();
    const held = [
      ...(await store.listPositions("live", "open")),
      ...(await store.listPositions("sim", "open")),
    ].map((position) => position.symbol);
    const symbols = [...new Set([...top, ...held])];
    if (symbols.length === 0) return undefined;
    try {
      const args = { symbols };
      assertOutgoing("get_equity_quotes", args);
      const payload = await this.mcpCall(token, "get_equity_quotes", args);
      return parseQuotes(payload);
    } catch (error) {
      await this.audit("quotes_failed", { message: error instanceof Error ? error.message : "quote refresh failed" });
      return undefined;
    }
  }

  private async agenticAccountNumber(token: string): Promise<string | undefined> {
    assertOutgoing("get_accounts", {});
    const account = selectAgentic(parseAccounts(await this.mcpCall(token, "get_accounts", {})));
    return account?.accountNumber;
  }

  private async accessToken(): Promise<string | undefined> {
    if (!this.env.TOKEN_KEY) return undefined;
    const row = await this.env.DB.prepare("SELECT access_ct, access_iv, refresh_ct, refresh_iv, expires_at, lifetime_secs FROM rh_tokens WHERE id = 1").first<{ access_ct: string; access_iv: string; refresh_ct: string | null; refresh_iv: string | null; expires_at: string | null; lifetime_secs: number | null }>();
    if (!row) return undefined;
    const key = await importTokenKey(this.env.TOKEN_KEY);
    const due = row.expires_at ? Date.parse(row.expires_at) - Date.now() < Math.min(60, Math.max(1, Math.floor((row.lifetime_secs ?? 3600) / 10))) * 1000 : false;
    if (due && row.refresh_ct && row.refresh_iv) {
      const refreshed = await this.refresh(key, row.refresh_ct, row.refresh_iv);
      if (refreshed) return refreshed;
    }
    return decryptString(key, row.access_iv, row.access_ct);
  }

  private async refresh(key: CryptoKey, refreshCt: string, refreshIv: string): Promise<string | undefined> {
    const client = await this.env.DB.prepare("SELECT client_id, token_endpoint, resource FROM rh_client WHERE id = 1").first<{ client_id: string; token_endpoint: string; resource: string }>();
    if (!client) return undefined;
    const refreshToken = await decryptString(key, refreshIv, refreshCt);
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: client.client_id, resource: client.resource });
    const response = await fetch(client.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
    if (!response.ok) {
      await this.audit("refresh_failed", { status: response.status });
      if (response.status === 400 || response.status === 401) {
        await this.env.DB.prepare("DELETE FROM rh_tokens WHERE id = 1").run();
      }
      return undefined;
    }
    const json = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number | string };
    if (!json.access_token) return undefined;
    const { encryptString } = await import("./crypto.js");
    const access = await encryptString(key, json.access_token);
    const nextRefresh = json.refresh_token ? await encryptString(key, json.refresh_token) : undefined;
    const lifetime = typeof json.expires_in === "number" ? json.expires_in : Number(json.expires_in ?? 0);
    const expires = lifetime > 0 ? new Date(Date.now() + lifetime * 1000).toISOString() : null;
    await this.env.DB.prepare("UPDATE rh_tokens SET access_ct = ?, access_iv = ?, refresh_ct = ?, refresh_iv = ?, expires_at = ?, lifetime_secs = ? WHERE id = 1").bind(access.ct, access.iv, nextRefresh?.ct ?? refreshCt, nextRefresh?.iv ?? refreshIv, expires, lifetime || null).run();
    await this.audit("refresh", { expiresAt: expires });
    return json.access_token;
  }

  private async mcpCall(token: string, name: string, args: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    };
    const init = await fetch(tradingMcpUrl(), {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "churntop10", version: "0.1.0" } } }),
    });
    const session = init.headers.get("mcp-session-id");
    if (session) headers["mcp-session-id"] = session;
    await init.arrayBuffer();
    if (session) {
      await fetch(tradingMcpUrl(), { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    }
    const response = await fetch(tradingMcpUrl(), {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`mcp ${response.status}`);
    return parseMcp(response.headers.get("content-type") ?? "", text);
  }

  private async loadSim(): Promise<SimState> {
    const store = await this.store();
    const settings = await store.getSettings();
    if (!settings) throw new Error("settings missing");
    const top10 = await store.listTop10();
    const open = await store.listPositions("sim", "open");
    const orders = await store.listWorkingOrders();
    const proposals = await store.listProposals();
    const barsRows = await store.listBars();
    const bars: SimState["bars"] = {};
    for (const row of barsRows) {
      (bars[row.symbol] ??= []).push({ ts: row.ts, price: row.price, volume: row.volume });
    }
    const rules = await store.currentRules();
    const selected = await store.selectedRuleIds();
    const closed = await store.listPositions("sim", "closed");
    const trades = [];
    for (const position of closed.slice(0, 50)) {
      const legs = await store.listTrades(position.id);
      const buy = legs.find((leg) => leg.side === "buy" && leg.status === "filled");
      const sell = [...legs].reverse().find((leg) => leg.side === "sell" && leg.status === "filled");
      if (!buy || !sell) continue;
      trades.push({
        id: position.id,
        symbol: position.symbol,
        quantity: position.qty,
        entryPrice: position.avgCost,
        exitPrice: sell.fillPrice ?? position.avgCost,
        pnl: (sell.fillPrice ?? 0) * position.qty - position.avgCost * position.qty,
        openedOn: new Date(position.openedAt).toISOString().slice(0, 10),
        closedAt: position.closedAt ?? 0,
        buyRuleId: position.buyRuleVersionId,
        sellRuleId: position.sellRuleVersionId,
        signals: sell.signals ?? [],
        reason: sell.exitReason ?? "exit",
      });
    }
    return {
      cash: settings.cash,
      dayStartEquity: settings.dayStartEquity,
      dayStartDate: settings.dayStartDate,
      mode: settings.mode,
      killed: settings.killed,
      profitTargetPct: settings.profitTargetPct,
      stopLossPct: settings.stopLossPct,
      dailyLossPct: settings.dailyLossPct,
      orderCap: settings.orderCap,
      tradingCapital: settings.tradingCapital,
      top10,
      positions: open.map((row) => ({
        id: row.id,
        symbol: row.symbol,
        quantity: row.qty,
        avgCost: row.avgCost,
        openedOn: new Date(row.openedAt).toISOString().slice(0, 10),
        openedAt: row.openedAt,
        tradingCapitalSnapshot: row.tradingCapitalSnapshot,
        profitTargetPct: row.profitTargetPct,
        stopLossPct: row.stopLossPct,
        buyRuleId: row.buyRuleVersionId,
        sellRuleId: row.sellRuleVersionId,
      })),
      orders: orders.map((row) => ({
        id: String(row.id), refId: String(row.refId), symbol: String(row.symbol), side: String(row.side), type: String(row.type),
        quantity: Number(row.quantity), limit: row.limit == null ? null : Number(row.limit), stop: row.stop == null ? null : Number(row.stop),
        status: String(row.status), role: String(row.role), openedOn: String(row.openedOn), createdAt: Number(row.createdAt),
      })),
      dayTrades: [],
      proposals: proposals.map((row) => ({
        id: String(row.id), refId: String(row.refId), symbol: String(row.symbol), verdict: String(row.verdict),
        message: String(row.message), payload: String(row.payload ?? ""), createdAt: Number(row.createdAt),
      })),
      trades,
      usedRefIds: proposals.map((row) => String(row.refId)),
      rules,
      selectedRuleIds: selected,
      bars,
      spyBars: bars.SPY ?? [],
      spyLast: bars.SPY?.at(-1)?.price,
      pendingLegs: [],
      closedThisCycle: [],
    };
  }

  private async saveSim(state: SimState, quotes: QuoteView[] = []): Promise<void> {
    const store = await this.store();
    await store.saveSettings({ cash: state.cash, dayStartEquity: state.dayStartEquity, dayStartDate: state.dayStartDate, killed: state.killed });
    const openIds = new Set(state.positions.map((position) => position.id));
    for (const position of state.positions) {
      await store.upsertPosition({
        id: position.id,
        mode: "sim",
        symbol: position.symbol,
        status: "open",
        tradingCapitalSnapshot: position.tradingCapitalSnapshot,
        profitTargetPct: position.profitTargetPct,
        stopLossPct: position.stopLossPct,
        buyRuleVersionId: position.buyRuleId,
        sellRuleVersionId: position.sellRuleId,
        avgCost: position.avgCost,
        qty: position.quantity,
        openedAt: position.openedAt,
      });
      const last = quotes.find((quote) => quote.symbol === position.symbol)?.last;
      if (last) {
        await store.insertPriceMark({ id: crypto.randomUUID(), positionId: position.id, at: Date.now(), price: last });
      }
    }
    for (const closed of state.closedThisCycle ?? []) {
      const record: PositionRecord = {
        id: closed.position.id,
        mode: "sim",
        symbol: closed.position.symbol,
        status: "closed",
        tradingCapitalSnapshot: closed.position.tradingCapitalSnapshot,
        profitTargetPct: closed.position.profitTargetPct,
        stopLossPct: closed.position.stopLossPct,
        buyRuleVersionId: closed.position.buyRuleId,
        sellRuleVersionId: closed.position.sellRuleId,
        avgCost: closed.position.avgCost,
        qty: closed.position.quantity,
        openedAt: closed.position.openedAt,
        closedAt: closed.at,
      };
      await store.upsertPosition(record);
    }
    for (const leg of state.pendingLegs ?? []) {
      const trade: TradeRecord = {
        id: leg.id,
        positionId: leg.positionId,
        ruleVersionId: leg.ruleVersionId,
        side: leg.side,
        qty: leg.qty,
        limitPrice: leg.limitPrice,
        fillPrice: leg.fillPrice,
        session: leg.session,
        bidAtOrder: leg.bidAtOrder,
        askAtOrder: leg.askAtOrder,
        capitalSnapshot: leg.capitalSnapshot,
        sizeReason: leg.sizeReason,
        exitReason: leg.exitReason,
        status: leg.status,
        createdAt: leg.createdAt,
        signals: leg.signals,
      };
      await store.insertTrade(trade);
    }
    for (const closed of state.closedThisCycle ?? []) {
      const existing = await store.getReview(closed.position.id);
      if (existing) continue;
      const trades = await store.listTrades(closed.position.id);
      const marks = await store.listPriceMarks(closed.position.id);
      const record = (await store.getPosition(closed.position.id))!;
      const review = buildPositionReview({
        position: record,
        trades,
        marks,
        exitType: closed.exitType,
        exitPrice: closed.exitPrice,
        now: closed.at,
        sessionAtEntry: trades.find((item) => item.side === "buy")?.session,
      });
      await store.insertReview(review);
    }
    const leftover = (await store.listPositions("sim", "open")).filter((row) => !openIds.has(row.id));
    for (const row of leftover) {
      if ((state.closedThisCycle ?? []).some((item) => item.position.id === row.id)) continue;
      await store.upsertPosition({ ...row, status: "closed", closedAt: Date.now() });
    }
    const barRows = Object.entries(state.bars).flatMap(([symbol, bars]) => bars.map((bar) => ({ symbol, ...bar })));
    await store.saveBars(barRows);
    await store.replaceWorkingOrders(state.orders);
    await store.replaceProposals(state.proposals.slice(-PROPOSAL_CAP));
    await store.setSelectedRuleIds(state.selectedRuleIds);
  }


  private async computeLiveSignals(symbol: string, quote: QuoteView | undefined, now: Date, ruleSignals: string[] | undefined, allQuotes: QuoteView[]): Promise<SignalResult[]> {
    if (!quote || !ruleSignals?.length) return [];
    const rows = await (await this.store()).listBars();
    const bars: Record<string, { ts: number; price: number; volume: number }[]> = {};
    for (const row of rows) {
      (bars[row.symbol] ??= []).push({ ts: row.ts, price: row.price, volume: row.volume });
    }
    const spy = allQuotes.find((item) => item.symbol === "SPY");
    return computeSignals(ruleSignals, {
      symbol,
      last: quote.last,
      volume: bars[symbol]?.at(-1)?.volume ?? 0,
      now,
      bars: bars[symbol] ?? [],
      spyBars: bars.SPY ?? [],
      spyLast: spy?.last,
    });
  }

  /** Live submits stay off unless the gate is armed. Off-hours, never send a broker stop. */
  private async proposeLiveEntries(quotes: QuoteView[], now: Date): Promise<void> {
    if (this.env.ALLOW_LIVE_TRADING !== "1") return;
    if (marketSession(now) !== "regular") {
      await this.audit("live_skipped", { reason: "off_hours_live_not_armed" });
      return;
    }
    const settings = await this.settings();
    const top10 = (await this.env.DB.prepare("SELECT symbol FROM top10 ORDER BY rank").all<{ symbol: string }>()).results.map((row) => row.symbol);
    const rules = await (await this.store()).currentRules();
    const hasProvenBuyRule = rules.some((rule) => rule.side === "buy" && rule.status === "proven");
    const provenBuy = rules.find((rule) => rule.side === "buy" && rule.status === "proven" && rule.familyId === "buy-first-strength")
      ?? rules.find((rule) => rule.side === "buy" && rule.status === "proven");
    const refs = (await this.env.DB.prepare("SELECT ref_id FROM proposals").all<{ ref_id: string }>()).results.map((row) => row.ref_id);
    // Live orders must not use simulator positions or cash.
    for (const symbol of top10) {
      const refId = crypto.randomUUID();
      const quote = quotes.find((item) => item.symbol === symbol);
      const guard: GuardContext = {
        now,
        mode: settings.mode,
        killed: settings.killed === 1,
        top10,
        held: [],
        equity: 0,
        buyingPower: 0,
        dayStartEquity: 0,
        profitTargetPct: settings.profit_target_pct,
        stopLossPct: settings.stop_loss_pct,
        dailyLossPct: settings.daily_loss_pct,
        orderCap: settings.order_cap ?? 100,
        ordersToday: 0,
        quote: quote ? { symbol: quote.symbol, bid: quote.bid, ask: quote.ask, last: quote.last, tradable: quote.tradable, hasBidAsk: quote.hasBidAsk, asOf: quote.asOf } : undefined,
        quoteSource: "robinhood",
        workingSymbols: [],
        usedRefIds: refs,
        agenticAllowed: true,
        symbol,
        refId,
        audience: "live",
        hasProvenBuyRule,
      };
      const verdict = validateNewBuy(guard);
      if (!verdict.ok || !verdict.bundle || verdict.bundle.stopKind !== "broker") continue;
      const liveSignals = await this.computeLiveSignals(symbol, quote, now, provenBuy?.signals, quotes);
      if (!allRequiredSignalsFired(liveSignals)) {
        await this.audit("live_skipped", { reason: "signals", message: "First-buy signals did not confirm.", symbol, signals: liveSignals });
        continue;
      }
      const token = await this.accessToken();
      const accountNumber = token ? await this.agenticAccountNumber(token) : undefined;
      if (!token || !accountNumber) {
        await this.audit("live_skipped", { reason: "not_connected" });
        continue;
      }
      const bundle = verdict.bundle;
      bundle.entry.account_number = accountNumber;
      bundle.stop.account_number = accountNumber;
      const review = { ...bundle.entry };
      delete review.ref_id;
      try {
        await submitGatedTool({ allowLive: this.env.ALLOW_LIVE_TRADING, tool: "review_equity_order", args: review, send: (tool, args) => this.mcpCall(token, tool, args) });
        const placed = await submitGatedTool({ allowLive: this.env.ALLOW_LIVE_TRADING, tool: "place_equity_order", args: bundle.entry, send: (tool, args) => this.mcpCall(token, tool, args) });
        await this.recordLivePlacement({
          payload: placed,
          fallbackId: typeof bundle.entry.ref_id === "string" ? bundle.entry.ref_id : refId,
          symbol,
          quantity: Number(bundle.entry.quantity),
          limitPrice: Number(bundle.entry.limit_price),
          session: marketSession(now),
          bid: quote?.bid,
          ask: quote?.ask,
          sizeReason: verdict.sizeReason ?? "Live starter buy.",
          signals: liveSignals,
        });
        try {
          const stopPlaced = await submitGatedTool({ allowLive: this.env.ALLOW_LIVE_TRADING, tool: "place_equity_order", args: bundle.stop, send: (tool, args) => this.mcpCall(token, tool, args) });
          await this.recordLiveStop(symbol, stopPlaced, marketSession(now));
        } catch (error) {
          await this.audit("live_stop_failed", { message: error instanceof Error ? error.name : "live_stop_failed", symbol });
        }
      } catch (error) {
        await this.audit("live_failed", { message: error instanceof Error ? error.name : "live_failed" });
      }
    }
  }

  private async buildSummary(book: { quotes: QuoteView[]; source: "recorded" | "robinhood" }): Promise<Summary> {
    const settings = await this.settings();
    const top10 = (await this.env.DB.prepare("SELECT symbol FROM top10 ORDER BY rank").all<{ symbol: string }>()).results.map((row) => row.symbol);
    const now = new Date();
    const parts = etParts(now);
    this.robinhoodError = undefined;
    const robinhood = await this.robinhoodSnapshot();
    const linked = !!(await this.env.DB.prepare("SELECT id FROM rh_tokens WHERE id = 1").first());
    const robinhoodStatus: Summary["robinhoodStatus"] = robinhood ? "connected" : linked || this.robinhoodError ? "error" : "not_connected";
    return {
      mode: settings.mode,
      killed: settings.killed === 1,
      liveGate: this.env.ALLOW_LIVE_TRADING === "1",
      session: marketSession(now),
      clock: `${parts.date} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")} ET`,
      quoteSource: book.source,
      connected: robinhood !== null,
      robinhoodStatus,
      ...(robinhoodStatus === "error" ? { robinhoodError: this.robinhoodError ?? "Robinhood sign-in expired or was revoked. Connect again from Settings." } : {}),
      robinhood,
      settings: {
        profitTargetPct: settings.profit_target_pct,
        stopLossPct: settings.stop_loss_pct,
        dailyLossPct: settings.daily_loss_pct,
        orderCap: settings.order_cap ?? 100,
        tradingCapital: settings.trading_capital ?? 0,
      },
      tradingCapital: await this.tradingCapitalView(settings.trading_capital ?? 0, robinhood, book.quotes, "live"),
      positions: await this.positionViews("live", book.quotes),
      top10: top10.map((symbol) => {
        const quote = book.quotes.find((item) => item.symbol === symbol);
        const previous = quote?.previousClose?.status === "ok" ? quote.previousClose.value : undefined;
        const delta = quote ? quoteChange(quote.last, previous) : null;
        return {
          symbol,
          bid: quote ? formatUsd(quote.bid) : "Unavailable",
          ask: quote ? formatUsd(quote.ask) : "Unavailable",
          last: quote ? formatUsd(quote.last) : "Unavailable",
          tradable: quote?.tradable ?? false,
          change: delta?.change ?? null,
          changePct: delta?.changePct ?? null,
        };
      }),
      desk: await this.deskFigures("live", now, null, settings.day_start_equity, null),
    };
  }

  private async buildSimulator(book: { quotes: QuoteView[]; source: "recorded" | "robinhood" }, events: SimEvent[] = []): Promise<SimulatorView> {
    const state = await this.loadSim();
    const now = new Date();
    const parts = etParts(now);
    const equity = equityOf(state, book.quotes);
    const dayPnl = signedDayPnl(equity, state.dayStartEquity);
    return {
      cash: formatUsd(state.cash),
      equity: formatUsd(equity),
      dailyLoss: formatUsd(dailyLossAmount(equity, state.dayStartEquity)),
      dailyLossCap: formatUsd(roundMoney((effectiveTradingCapital(state.tradingCapital, equity).capital) * (state.dailyLossPct / 100))),
      ordersToday: ordersToday(state, now),
      orderCap: state.orderCap,
      killed: state.killed,
      session: marketSession(now),
      clock: `${parts.date} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")} ET`,
      quoteSource: book.source,
      selectedRuleIds: state.selectedRuleIds,
      tradingCapital: await this.tradingCapitalView(state.tradingCapital, undefined, book.quotes, "sim", equity),
      positions: await this.positionViews("sim", book.quotes),
      orders: state.orders.slice(-20).reverse().map((order) => ({
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        quantity: formatShares(order.quantity),
        status: order.status,
        role: order.role,
        price: formatUsd(order.limit ?? order.stop ?? 0),
      })),
      trades: state.trades.slice(-20).reverse().map((trade) => ({
        symbol: trade.symbol,
        quantity: formatShares(trade.quantity),
        entry: formatUsd(trade.entryPrice),
        exit: formatUsd(trade.exitPrice),
        pnl: formatUsd(trade.pnl),
        reason: trade.reason,
        at: trade.closedAt,
      })),
      events: events.map((event) => ({ action: event.action, detail: JSON.stringify(event.detail) })),
      proposals: state.proposals.slice(-PROPOSAL_CAP).reverse().map((proposal) => ({ symbol: proposal.symbol, verdict: proposal.verdict, message: proposal.message, at: proposal.createdAt })),
      desk: await this.deskFigures("sim", now, equity, state.dayStartEquity, dayPnl),
    };
  }

  private async deskFigures(mode: "live" | "sim", now: Date, equity: number | null, dayStartEquity: number, dayPnl: number | null): Promise<DeskFigures> {
    const reviews = await (await this.store()).listReviews({ mode });
    const rows = reviews.map((row) => ({ pnl: row.pnlDollars, closedAt: row.closedAt ?? null, exitType: row.exitType }));
    const start = etDayStart(now);
    const today = windowWinRate(rows, start, now.getTime());
    const week = windowWinRate(rows, start - 6 * 24 * 60 * 60 * 1000, now.getTime());
    return {
      dayStartEquity,
      dayPnl,
      equityValue: equity,
      closedPnl: closedPnlSum(rows),
      winRateToday: today.rate,
      winRate7d: week.rate,
    };
  }

  private async ruleViews(): Promise<RuleView[]> {
    const rules = await (await this.store()).currentRules();
    const cards = await (await this.store()).ruleScorecards(rules);
    const lastTriggered = await this.lastTriggeredByFamily();
    return rules.map((rule) => ({
      id: rule.id,
      familyId: rule.familyId,
      name: rule.name,
      side: rule.side,
      body: rule.body,
      signals: rule.signals,
      status: rule.status,
      version: rule.version,
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
      lastTriggeredAt: lastTriggered.get(rule.familyId) ?? null,
      scorecard: cards.get(rule.familyId) ?? { tradeCount: 0, winRate: null, avgProfit: null, worstLoss: null },
    }));
  }

  private async lastTriggeredByFamily(): Promise<Map<string, number>> {
    const rows = (await this.env.DB.prepare(
      `SELECT rv.rule_id AS family_id, MAX(t.created_at) AS last_at
       FROM trades t
       JOIN rule_versions rv ON rv.id = t.rule_version_id
       WHERE t.rule_version_id IS NOT NULL
       GROUP BY rv.rule_id`,
    ).all<{ family_id: string; last_at: number }>()).results;
    return new Map(rows.map((row) => [row.family_id, Number(row.last_at)]));
  }

  private robinhoodError: string | undefined;
  private snapshotCache?: { at: number; value: Summary["robinhood"] };


  async editPositionCapital(id: string, amount: number, confirm: boolean): Promise<{ ok: true }> {
    await this.seed();
    if (!confirm) throw new Error("Confirm the capital change for this position.");
    if (!validTradingCapital(amount)) throw new Error("Trading capital must be a positive dollar amount.");
    const store = await this.store();
    const position = await store.getPosition(id);
    if (!position || position.status !== "open") throw new Error("That open position was not found.");
    const oldValue = position.tradingCapitalSnapshot;
    await store.upsertPosition({ ...position, tradingCapitalSnapshot: amount });
    await store.insertCapitalHistory({ id: crypto.randomUUID(), positionId: id, oldValue, newValue: amount, at: Date.now() });
    await this.audit("position_capital", { id, oldValue, newValue: amount });
    return { ok: true };
  }

  async editPositionExits(id: string, input: { profitTargetPct?: number; stopLossPct?: number }): Promise<{ ok: true }> {
    await this.seed();
    const store = await this.store();
    const position = await store.getPosition(id);
    if (!position || position.status !== "open") throw new Error("That open position was not found.");
    const now = Date.now();
    const next = { ...position };
    if (input.profitTargetPct != null) {
      if (!validExitPct(input.profitTargetPct)) throw new Error("Profit target must be a positive percent no greater than 100.");
      await store.insertExitSettingsHistory({ id: crypto.randomUUID(), positionId: id, field: "profit_target_pct", oldValue: position.profitTargetPct, newValue: input.profitTargetPct, at: now });
      next.profitTargetPct = input.profitTargetPct;
    }
    if (input.stopLossPct != null) {
      if (!validExitPct(input.stopLossPct)) throw new Error("Stop-loss must be a positive percent no greater than 100.");
      await store.insertExitSettingsHistory({ id: crypto.randomUUID(), positionId: id, field: "stop_loss_pct", oldValue: position.stopLossPct, newValue: input.stopLossPct, at: now });
      next.stopLossPct = input.stopLossPct;
    }
    await store.upsertPosition(next);
    await this.audit("position_exits", { id, ...input });
    return { ok: true };
  }

  async reviewScreen(filters: ReviewFilters): Promise<ReviewScreen> {
    await this.seed();
    await this.syncLiveHoldings();
    const store = await this.store();
    const closed = await store.listPositions(undefined, "closed");
    if (shouldComputeScores(closed.length)) await this.maybeComputeScores();
    const reviews = await store.listReviews(filters);
    const ruleScores = await store.latestRuleScoreSnapshots(filters.mode);
    const signalScores = await store.latestSignalScoreSnapshots(filters.mode);
    const rules = await store.currentRules();
    const signals = await store.listSignals();
    const nameOf = (id?: string) => rules.find((rule) => rule.id === id || rule.familyId === id)?.name;
    const signalName = (id: string) => signals.find((item) => item.id === id)?.name ?? id;
    const ranked = [...signalScores].sort((a, b) => (b.avgPnlTrue ?? 0) - (a.avgPnlTrue ?? 0));
    return {
      reviews: reviews.map((row) => ({
        positionId: row.positionId,
        symbol: row.symbol,
        mode: row.mode,
        closedAt: row.closedAt ?? row.createdAt,
        pnl: formatUsd(row.pnlDollars),
        pnlPct: `${row.pnlPct.toFixed(2)}%`,
        holdMinutes: row.holdMinutes,
        exitType: row.exitType,
        session: row.sessionAtEntry ?? "",
        addsCount: row.addsCount,
        addsHelped: row.addsHelped,
        botNote: row.botNote,
        userNote: row.userNote ?? "",
        buyRule: row.buyRuleName ?? (row.exitType === "imported" || row.exitType === "imported_close" ? "imported/manual" : undefined),
        sellRule: row.sellRuleName,
      })),
      ruleScores: ruleScores.map((row) => ({
        rule: nameOf(row.ruleVersionId) ?? nameOf(row.ruleId) ?? row.ruleId ?? "Rule",
        mode: row.mode,
        trades: row.trades,
        winRate: row.winRate,
        avgPnlPct: row.avgPnlPct,
        worstLoss: row.worstLoss,
        netAfterCosts: row.netAfterCosts,
      })),
      bestSignals: ranked.filter((row) => (row.sampleTrue ?? 0) > 0 && (row.avgPnlTrue ?? 0) >= 0).slice(0, 5).map((row) => ({
        name: signalName(row.signalId), id: row.signalId, winRate: row.winRateTrue, avgPnl: row.avgPnlTrue, sample: row.sampleTrue,
      })),
      worstSignals: [...ranked].reverse().filter((row) => (row.sampleTrue ?? 0) > 0).slice(0, 5).map((row) => ({
        name: signalName(row.signalId), id: row.signalId, winRate: row.winRateTrue, avgPnl: row.avgPnlTrue, sample: row.sampleTrue,
      })),
    };
  }

  async updateReviewNote(positionId: string, userNote: string): Promise<void> {
    await this.seed();
    await (await this.store()).updateReviewNote(positionId, userNote);
    await this.audit("review_note", { positionId });
  }

  private async positionViews(mode: "live" | "sim", quotes: QuoteView[]): Promise<PositionView[]> {
    const store = await this.store();
    const positions = await store.listPositions(mode, "open");
    const versions = await store.listRuleVersions();
    const byId = new Map(versions.map((rule) => [rule.id, rule]));
    const out: PositionView[] = [];
    for (const position of positions) {
      const last = quotes.find((quote) => quote.symbol === position.symbol)?.last ?? position.avgCost;
      const trades = await store.listTrades(position.id);
      const buy = position.buyRuleVersionId ? byId.get(position.buyRuleVersionId) : undefined;
      const sell = position.sellRuleVersionId ? byId.get(position.sellRuleVersionId) : undefined;
      out.push({
        id: position.id,
        symbol: position.symbol,
        mode: position.mode,
        status: position.status,
        quantity: formatShares(position.qty),
        avgCost: formatUsd(position.avgCost),
        last: formatUsd(last),
        marketValue: formatUsd(roundMoney(last * position.qty)),
        pnl: formatUsd(roundMoney((last - position.avgCost) * position.qty)),
        tradingCapital: formatUsd(position.tradingCapitalSnapshot),
        profitTargetPct: position.profitTargetPct,
        stopLossPct: position.stopLossPct,
        buyRule: buy ? `${buy.name} v${buy.version}` : labelBuyRule(position),
        sellRule: sell ? `${sell.name} v${sell.version}` : undefined,
        trades: trades.map((trade) => ({
          id: trade.id,
          side: trade.side,
          quantity: formatShares(trade.qty),
          price: formatUsd(trade.fillPrice ?? trade.limitPrice ?? 0),
          status: trade.status,
          session: trade.session,
          sizeReason: trade.sizeReason,
          exitReason: trade.exitReason,
          at: trade.createdAt,
          signals: (trade.signals ?? []).map((signal) => ({
            id: signal.id,
            name: signal.name,
            value: signal.value,
            threshold: signal.threshold ?? null,
            fired: signal.fired,
            reason: signal.reason,
          })),
        })),
      });
    }
    return out;
  }

  private async tradingCapitalView(saved: number, robinhood: Summary["robinhood"] | undefined, quotes: QuoteView[], mode: "live" | "sim", simEquity?: number) {
    const store = await this.store();
    let balance = simEquity ?? 0;
    if (mode === "live") {
      const raw = robinhood?.totalValue ? Number(String(robinhood.totalValue).replace(/[^0-9.-]/g, "")) : NaN;
      balance = Number.isFinite(raw) && raw > 0 ? raw : balance;
    }
    if (!(balance > 0)) {
      const settings = await store.getSettings();
      balance = settings?.cash ?? 0;
    }
    const effective = effectiveTradingCapital(saved, balance);
    const open = await store.listPositions(mode, "open");
    const exposure = openExposure(open.map((position) => {
      const last = quotes.find((quote) => quote.symbol === position.symbol)?.last;
      return { qty: position.qty, avgCost: position.avgCost, last };
    }));
    return {
      saved,
      savedUsd: formatUsd(saved),
      balance,
      balanceUsd: formatUsd(balance),
      effective: effective.capital,
      effectiveUsd: formatUsd(effective.capital),
      warn: effective.warn,
      exposure,
      exposureUsd: formatUsd(exposure),
      paused: exposure >= effective.capital && effective.capital > 0,
      presets: tradingCapitalPresets(balance),
    };
  }

  private async maybeComputeScores(): Promise<void> {
    const store = await this.store();
    const last = await store.lastScoreSnapshotEnd();
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const periodEnd = now;
    const periodStart = now - day;
    if (last && now - last < day) return;
    const closed = await store.listPositions(undefined, "closed");
    if (!shouldComputeScores(closed.length)) return;
    await this.computeScores(periodStart, periodEnd);
  }

  private async computeScores(periodStart: number, periodEnd: number): Promise<void> {
    const store = await this.store();
    const computedAt = Date.now();
    for (const mode of ["sim", "live"] as const) {
      const reviews = await store.listReviews({ mode, from: periodStart, to: periodEnd });
      const rules = await store.currentRules();
      const byRule = new Map<string, { pnl: number[] }>();
      for (const review of reviews) {
        for (const name of [review.buyRuleName, review.sellRuleName]) {
          if (!name) continue;
          const rule = rules.find((item) => item.name === name);
          const key = rule?.familyId ?? name;
          const list = byRule.get(key) ?? { pnl: [] };
          list.pnl.push(review.pnlDollars);
          byRule.set(key, list);
        }
      }
      const ruleRows = [];
      for (const rule of rules) {
        const list = byRule.get(rule.familyId)?.pnl ?? [];
        const wins = list.filter((item) => item > 0);
        ruleRows.push({
          id: crypto.randomUUID(),
          periodStart, periodEnd, mode,
          ruleId: rule.familyId,
          ruleVersionId: rule.id,
          trades: list.length,
          winRate: list.length ? wins.length / list.length : null,
          avgPnlPct: reviews.length ? reviews.filter((item) => item.buyRuleName === rule.name || item.sellRuleName === rule.name).reduce((sum, item) => sum + item.pnlPct, 0) / Math.max(1, list.length) : null,
          worstLoss: list.length ? Math.min(0, ...list) : null,
          netAfterCosts: list.length ? list.reduce((sum, item) => sum + item, 0) : null,
          computedAt,
        });
      }
      await store.saveRuleScoreSnapshots(ruleRows);
      const signals = await store.listSignals();
      const signalRows = [];
      for (const signal of signals) {
        const truePnl: number[] = [];
        const falsePnl: number[] = [];
        for (const review of reviews) {
          const trades = await store.listTrades(review.positionId);
          const fired = trades.some((trade) => trade.signals?.some((item) => item.id === signal.id && item.fired));
          const seen = trades.some((trade) => trade.signals?.some((item) => item.id === signal.id));
          if (!seen) continue;
          (fired ? truePnl : falsePnl).push(review.pnlDollars);
        }
        const avg = (list: number[]) => list.length ? list.reduce((sum, item) => sum + item, 0) / list.length : null;
        const win = (list: number[]) => list.length ? list.filter((item) => item > 0).length / list.length : null;
        signalRows.push({
          id: crypto.randomUUID(), periodStart, periodEnd, mode, signalId: signal.id,
          winRateTrue: win(truePnl), avgPnlTrue: avg(truePnl), sampleTrue: truePnl.length,
          winRateFalse: win(falsePnl), avgPnlFalse: avg(falsePnl), sampleFalse: falsePnl.length,
          computedAt,
        });
      }
      await store.saveSignalScoreSnapshots(signalRows);
    }
  }

  async disconnect(): Promise<Summary> {
    await this.env.DB.prepare("DELETE FROM rh_tokens WHERE id = 1").run();
    await this.env.DB.prepare("DELETE FROM oauth_state").run();
    await this.audit("robinhood_disconnected", {});
    return this.summary();
  }


  private async syncLiveHoldings(snapshot?: Summary["robinhood"]): Promise<void> {
    const store = await this.store();
    const settings = await store.getSettings();
    if (!settings) return;
    const holdings = await this.loadBrokerHoldings();
    const orders = await this.loadBrokerOrders();
    await this.applyPendingFills(orders);
    const robinhood = snapshot === undefined ? await this.robinhoodSnapshot() : snapshot;
    const equity = usdNumber(robinhood?.totalValue) || settings.cash;
    const capital = effectiveTradingCapital(settings.tradingCapital, equity).capital;
    const now = Date.now();
    const open = await store.listPositions("live", "open");
    const changes = reconcileLiveHoldings(open, holdings, {
      now,
      session: marketSession(new Date(now)),
      tradingCapital: capital,
      profitTargetPct: settings.profitTargetPct,
      stopLossPct: settings.stopLossPct,
      nextId: () => crypto.randomUUID(),
    });
    for (const change of changes) {
      await store.upsertPosition(change.position);
      if (change.trade) await store.insertTrade(change.trade);
      if (change.capital) await store.insertCapitalHistory(change.capital);
      if (change.review) await store.insertReview(change.review);
      await this.audit(
        change.kind === "import" ? "live_import" : change.kind === "close" ? "live_broker_close" : change.kind === "qty_change" ? "live_qty_change" : "live_avg_cost",
        { symbol: change.position.symbol, qty: change.position.qty, source: change.position.source, avgCost: change.position.avgCost },
      );
    }
  }

  private recordedHoldings(): BrokerHolding[] {
    return parsePositions(recordedHoldings).positions.map((position) => ({
      symbol: position.symbol,
      quantity: position.quantity,
      averageBuyPrice: position.averageBuyPrice.status === "ok" ? position.averageBuyPrice.value : undefined,
    }));
  }

  /** Prod never invents holdings from the recorded fixture. Dev and tests use it when Robinhood is not connected. */
  private async loadBrokerHoldings(): Promise<BrokerHolding[]> {
    const token = await this.accessToken().catch(() => undefined);
    if (!token) return this.env.ENVIRONMENT === "prod" ? [] : this.recordedHoldings();
    try {
      const account = await this.agenticAccountNumber(token);
      if (!account) return this.env.ENVIRONMENT === "prod" ? [] : this.recordedHoldings();
      const args = { account_number: account };
      assertOutgoing("get_equity_positions", args);
      const parsed = parsePositions(await this.mcpCall(token, "get_equity_positions", args));
      return parsed.positions.map((position) => ({
        symbol: position.symbol,
        quantity: position.quantity,
        averageBuyPrice: position.averageBuyPrice.status === "ok" ? position.averageBuyPrice.value : undefined,
      }));
    } catch (error) {
      await this.audit("holdings_failed", { message: error instanceof Error ? error.message : "holdings read failed" });
      return [];
    }
  }

  private async loadBrokerOrders(): Promise<OrderView[]> {
    const token = await this.accessToken().catch(() => undefined);
    if (!token) return [];
    try {
      const account = await this.agenticAccountNumber(token);
      if (!account) return [];
      const args = { account_number: account };
      assertOutgoing("get_equity_orders", args);
      return parseOrders(await this.mcpCall(token, "get_equity_orders", args));
    } catch (error) {
      await this.audit("orders_failed", { message: error instanceof Error ? error.message : "orders read failed" });
      return [];
    }
  }

  private async applyPendingFills(orders: OrderView[]): Promise<void> {
    if (orders.length === 0) return;
    const store = await this.store();
    const open = await store.listPositions("live", "open");
    const byId = new Map(orders.map((order) => [order.id, order]));
    for (const position of open) {
      const trades = await store.listTrades(position.id);
      for (const trade of trades) {
        if (!trade.brokerOrderId) continue;
        const order = byId.get(trade.brokerOrderId);
        if (!order) continue;
        const next = applyOrderFill(trade, order);
        if (!next) continue;
        await store.insertTrade(next);
        await this.audit("live_fill", { symbol: position.symbol, brokerOrderId: trade.brokerOrderId, status: next.status, fillPrice: next.fillPrice });
      }
    }
  }

  private async recordLivePlacement(input: {
    payload: unknown;
    fallbackId: string;
    symbol: string;
    quantity: number;
    limitPrice: number;
    session: string;
    bid?: number;
    ask?: number;
    sizeReason: string;
    signals?: SignalResult[];
  }): Promise<void> {
    const parsed = parsePlacedOrder(input.payload);
    const brokerOrderId = parsed?.id ?? input.fallbackId;
    const store = await this.store();
    if (await store.getTradeByBrokerOrderId(brokerOrderId)) return;
    const settings = await store.getSettings();
    if (!settings) return;
    const existing = (await store.listPositions("live", "open")).find((position) => position.symbol === input.symbol.toUpperCase());
    const equity = usdNumber((await this.robinhoodSnapshot())?.totalValue) || settings.cash;
    const capital = effectiveTradingCapital(settings.tradingCapital, equity).capital;
    const proven = await store.currentRules();
    const buy = proven.find((rule) => rule.side === "buy" && rule.status === "proven");
    const sell = proven.find((rule) => rule.side === "sell" && rule.status === "proven");
    const records = recordsForPlacedLiveBuy({
      existing,
      symbol: input.symbol,
      qty: input.quantity,
      limitPrice: input.limitPrice,
      fillPrice: parsed?.averagePrice ?? parsed?.price,
      brokerOrderId,
      buyRuleVersionId: buy?.id,
      sellRuleVersionId: sell?.id,
      session: input.session,
      bid: input.bid,
      ask: input.ask,
      tradingCapital: capital,
      profitTargetPct: settings.profitTargetPct,
      stopLossPct: settings.stopLossPct,
      sizeReason: input.sizeReason,
      signals: input.signals,
      status: parsed?.state ?? "submitted",
      now: Date.now(),
      nextId: () => crypto.randomUUID(),
    });
    await store.upsertPosition(records.position);
    await store.insertTrade(records.trade);
    if (records.capital) await store.insertCapitalHistory(records.capital);
    await this.audit("live_order", { symbol: input.symbol, brokerOrderId, qty: input.quantity, status: records.trade.status });
  }

  private async recordLiveStop(symbol: string, payload: unknown, session: string): Promise<void> {
    const parsed = parsePlacedOrder(payload);
    if (!parsed?.id) return;
    const store = await this.store();
    if (await store.getTradeByBrokerOrderId(parsed.id)) return;
    const position = (await store.listPositions("live", "open")).find((item) => item.symbol === symbol.toUpperCase());
    if (!position) return;
    await store.insertTrade({
      id: crypto.randomUUID(),
      positionId: position.id,
      ruleVersionId: position.sellRuleVersionId,
      side: "sell",
      qty: parsed.quantity || position.qty,
      limitPrice: parsed.price,
      session,
      capitalSnapshot: position.tradingCapitalSnapshot,
      sizeReason: "Broker stop submitted with the live entry.",
      exitReason: "stop",
      brokerOrderId: parsed.id,
      status: parsed.state || "submitted",
      createdAt: Date.now(),
      source: "app",
    });
    await this.audit("live_stop_order", { symbol, brokerOrderId: parsed.id, status: parsed.state });
  }

  private async robinhoodSnapshot(): Promise<Summary["robinhood"]> {
    if (this.snapshotCache && Date.now() - this.snapshotCache.at < 5000) return this.snapshotCache.value;
    let token: string | undefined;
    try {
      token = await this.accessToken();
    } catch {
      // A saved sign-in that cannot be decrypted (for example after a key change) must not break the summary.
      this.robinhoodError = "The saved Robinhood sign-in could not be read. Disconnect and connect again.";
      await this.audit("robinhood_token_unreadable", {});
      return this.cacheSnapshot(null);
    }
    if (!token) return this.cacheSnapshot(null);
    try {
      assertOutgoing("get_accounts", {});
      const accountsPayload = await this.mcpCall(token, "get_accounts", {});
      const account = selectAgentic(parseAccounts(accountsPayload));
      if (!account) {
        this.robinhoodError = "Robinhood is connected, but no agent trading account was found.";
        return this.cacheSnapshot(null);
      }
      assertOutgoing("get_portfolio", { account_number: account.accountNumber });
      const portfolio = parsePortfolio(await this.mcpCall(token, "get_portfolio", { account_number: account.accountNumber }));
      assertOutgoing("get_realized_pnl", { account_number: account.rhsAccountNumber, span: "day" });
      const pnl = parseRealizedPnl(await this.mcpCall(token, "get_realized_pnl", { account_number: account.rhsAccountNumber, span: "day" }));
      const snapshot = {
        maskedAccount: maskAccountNumber(account.accountNumber),
        nickname: displayField(account.nickname),
        brokerageType: account.brokerageAccountType || "Unavailable",
        tradingType: account.tradingType || "Unavailable",
        agentic: account.agenticAllowed,
        totalValue: displayField(portfolio.totalValue, "usd"),
        cash: displayField(portfolio.cash, "usd"),
        buyingPower: displayField(portfolio.buyingPower, "usd"),
        pendingDeposits: displayField(portfolio.pendingDeposits, "usd"),
        todayPnl: displayField(pnl.totalReturns, "usd"),
        unsettled: displayField(account.unsettledFunds, "usd"),
      };
      return this.cacheSnapshot(snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : "read failed";
      this.robinhoodError = `Robinhood is connected, but reading the account failed: ${message.slice(0, 160)}`;
      await this.audit("robinhood_read_failed", { message });
      return this.cacheSnapshot(null);
    }
  }

  private cacheSnapshot(value: Summary["robinhood"]): Summary["robinhood"] {
    this.snapshotCache = { at: Date.now(), value };
    return value;
  }

  private async audit(action: string, detail: unknown): Promise<void> {
    const id = crypto.randomUUID();
    const text = redactJson(detail);
    const at = Date.now();
    await this.env.DB.prepare("INSERT INTO audit_index (id, at, action, detail) VALUES (?, ?, ?, ?)").bind(id, at, action, text).run();
    try {
      await this.env.AUDIT.put(`audit/${new Date(at).toISOString().slice(0, 10)}/${id}.json`, JSON.stringify({ id, at, action, detail: text }));
    } catch {
      // The D1 index still has the event. R2 is the durable copy when the bucket exists.
    }
  }
}

function parseMcp(contentType: string, body: string): unknown {
  if (contentType.includes("text/event-stream")) {
    let last: unknown;
    for (const line of body.split("\n")) {
      const data = line.trim().startsWith("data:") ? line.trim().slice(5).trim() : "";
      if (!data || data === "[DONE]") continue;
      last = JSON.parse(data) as unknown;
    }
    if (last === undefined) throw new Error("empty event stream");
    return last;
  }
  return JSON.parse(body) as unknown;
}

function usdNumber(value: string | undefined): number {
  if (!value) return 0;
  const amount = Number(String(value).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}
