import { DurableObject } from "cloudflare:workers";
import recordedQuotes from "../../docs/contracts/robinhood/fixtures/get_equity_quotes.json";
import type { Summary } from "../lib/api-types.js";
import { etParts, marketSession } from "../lib/clock.js";
import { displayField, parseAccounts, parsePortfolio, parseQuotes, parseRealizedPnl, selectAgentic, type QuoteView } from "../lib/decode.js";
import { maskAccountNumber, redactJson } from "../lib/mask.js";
import { formatShares, formatUsd, roundMoney } from "../lib/money.js";
import { tradingMcpUrl } from "../lib/oauth.js";
import { submitGatedTool } from "../lib/broker.js";
import { assertOutgoing } from "../lib/requests.js";
import { equityOf, ordersToday, runSimulatorCycle, sellAllSimPositions, type SimEvent, type SimState } from "../lib/simulator.js";
import { dailyLossAmount, validExitPct, validateNewBuy, type GuardContext } from "../lib/validator.js";
import { currentRules, createRule, editRule, listHistory, scorecards, seedDraftRules, setRuleStatus } from "./rules-store.js";
import type { RuleSide, RuleStatus } from "../lib/rules.js";
import type { SimulatorView, RuleView, RuleHistoryView } from "../lib/api-types.js";
import { decryptString, importTokenKey } from "./crypto.js";
import type { Env } from "./env.js";

const DEFAULT_TOP10 = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "AVGO", "TSLA", "JPM", "LLY"];

interface SettingsRow {
  profit_target_pct: number;
  stop_loss_pct: number;
  max_order_pct: number;
  daily_loss_pct: number;
  pdt_limit: number;
  order_cap?: number;
  mode: "view_only" | "live";
  killed: number;
  day_start_equity: number;
  day_start_date: string;
  cash: number;
  account_number: string;
}

interface PositionRow {
  symbol: string;
  quantity: number;
  avg_cost: number;
  opened_on: string;
  buy_rule_id?: string | null;
  buy_rule_version?: number | null;
  sell_rule_id?: string | null;
  sell_rule_version?: number | null;
}

interface OrderRow {
  id: string;
  ref_id: string;
  symbol: string;
  side: string;
  type: string;
  quantity: number;
  limit_price: number | null;
  stop_price: number | null;
  status: string;
  role: string;
  opened_on: string;
  buy_rule_id?: string | null;
  buy_rule_version?: number | null;
  sell_rule_id?: string | null;
  sell_rule_version?: number | null;
}

export class AccountTrader extends DurableObject<Env> {
  async summary(): Promise<Summary> {
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
    await this.saveSim(state);
    for (const event of events) await this.audit(event.action, event.detail);
    await this.audit("sim_cycle", { session: marketSession(now), quoteSource: book.source, events: events.length });
    return this.buildSimulator(book, events);
  }

  async tickSimulator(): Promise<void> {
    await this.seed();
    const open = await this.env.DB.prepare("SELECT symbol FROM sim_positions LIMIT 1").first();
    if (!open) return;
    await this.cycleSimulator();
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
    await createRule(this.env.DB, input);
    await this.audit("rule_created", { name: input.name, side: input.side });
    return this.ruleViews();
  }

  async editRuleView(id: string, input: { name?: string; body?: string; signals?: string[] }): Promise<RuleView[]> {
    await this.seed();
    const rule = await editRule(this.env.DB, id, input);
    await this.audit("rule_edited", { id, familyId: rule.familyId, version: rule.version, status: rule.status });
    return this.ruleViews();
  }

  async setRuleStatusView(id: string, status: RuleStatus): Promise<RuleView[]> {
    await this.seed();
    const rule = await setRuleStatus(this.env.DB, id, status);
    await this.audit(status === "proven" ? "rule_approved" : "rule_status", { id, familyId: rule.familyId, status, version: rule.version });
    return this.ruleViews();
  }

  async ruleHistoryView(familyId: string): Promise<RuleHistoryView[]> {
    await this.seed();
    return (await listHistory(this.env.DB, familyId)).map((row) => ({
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

  async saveSettings(input: { profitTargetPct: number; stopLossPct: number; dailyLossPct: number; orderCap: number }): Promise<Summary> {
    await this.seed();
    const { profitTargetPct, stopLossPct, dailyLossPct, orderCap } = input;
    if (!validExitPct(profitTargetPct)) throw new Error("Profit target must be a positive percent no greater than 100.");
    if (!validExitPct(stopLossPct)) throw new Error("Stop-loss must be a positive percent no greater than 100.");
    if (dailyLossPct < 0.1 || dailyLossPct > 5) throw new Error("Daily loss stop must be between 0.1% and 5%.");
    if (orderCap < 1 || orderCap > 1000) throw new Error("Order cap must be between 1 and 1000 orders per day.");
    await this.env.DB.prepare("UPDATE app_settings SET profit_target_pct = ?, stop_loss_pct = ?, daily_loss_pct = ?, order_cap = ? WHERE id = 1").bind(profitTargetPct, stopLossPct, dailyLossPct, orderCap).run();
    await this.audit("settings", input);
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
    await this.saveSim(state);
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
    const existing = await this.env.DB.prepare("SELECT id FROM app_settings WHERE id = 1").first();
    if (!existing) {
      const today = etParts(new Date()).date;
      await this.env.DB.prepare(`INSERT INTO app_settings
        (id, profit_target_pct, stop_loss_pct, max_order_pct, daily_loss_pct, pdt_limit, order_cap, mode, killed, day_start_equity, day_start_date, cash, account_number)
        VALUES (1, 1, 1, 10, 1, 3, 100, 'view_only', 0, 10000, ?, 10000, 'SIM0000999')`).bind(today).run();
      await this.env.DB.batch(DEFAULT_TOP10.map((symbol, index) => this.env.DB.prepare("INSERT INTO top10 (rank, symbol) VALUES (?, ?)").bind(index + 1, symbol)));
    }
    await seedDraftRules(this.env.DB);
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
    const symbols = (await this.env.DB.prepare("SELECT symbol FROM top10 ORDER BY rank").all<{ symbol: string }>()).results.map((row) => row.symbol);
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
    const settings = await this.settings();
    const top10 = (await this.env.DB.prepare("SELECT symbol FROM top10 ORDER BY rank").all<{ symbol: string }>()).results.map((row) => row.symbol);
    const positions = (await this.env.DB.prepare("SELECT symbol, quantity, avg_cost, opened_on, buy_rule_id, buy_rule_version, sell_rule_id, sell_rule_version FROM sim_positions").all<PositionRow>()).results;
    const orders = (await this.env.DB.prepare("SELECT id, ref_id, symbol, side, type, quantity, limit_price, stop_price, status, role, opened_on, created_at FROM sim_orders").all<OrderRow & { created_at: number }>()).results;
    const dayTrades = (await this.env.DB.prepare("SELECT symbol, day FROM day_trades").all<{ symbol: string; day: string }>()).results;
    const proposals = (await this.env.DB.prepare("SELECT id, ref_id, symbol, verdict, message, payload, created_at FROM proposals").all<{ id: string; ref_id: string; symbol: string; verdict: string; message: string; payload: string; created_at: number }>()).results;
    const trades = (await this.env.DB.prepare("SELECT id, symbol, quantity, entry_price, exit_price, pnl, opened_on, closed_at, buy_rule_id, buy_rule_version, sell_rule_id, sell_rule_version, signals, reason FROM sim_trades").all<{
      id: string; symbol: string; quantity: number; entry_price: number; exit_price: number; pnl: number; opened_on: string; closed_at: number; buy_rule_id: string | null; buy_rule_version: number | null; sell_rule_id: string | null; sell_rule_version: number | null; signals: string; reason: string;
    }>()).results;
    const barsRows = (await this.env.DB.prepare("SELECT symbol, ts, price, volume FROM quote_bars").all<{ symbol: string; ts: number; price: number; volume: number }>()).results;
    const bars: SimState["bars"] = {};
    for (const row of barsRows) {
      (bars[row.symbol] ??= []).push({ ts: row.ts, price: row.price, volume: row.volume });
    }
    const rules = await currentRules(this.env.DB);
    const selected = (await this.env.DB.prepare("SELECT rule_id FROM sim_selected_rules").all<{ rule_id: string }>()).results.map((row) => row.rule_id);
    return {
      cash: settings.cash,
      dayStartEquity: settings.day_start_equity,
      dayStartDate: settings.day_start_date,
      mode: settings.mode,
      killed: settings.killed === 1,
      profitTargetPct: settings.profit_target_pct,
      stopLossPct: settings.stop_loss_pct,
      dailyLossPct: settings.daily_loss_pct,
      orderCap: settings.order_cap ?? 100,
      top10,
      positions: positions.map((row) => ({
        symbol: row.symbol,
        quantity: row.quantity,
        avgCost: row.avg_cost,
        openedOn: row.opened_on,
        buyRuleId: row.buy_rule_id ?? undefined,
        buyRuleVersion: row.buy_rule_version ?? undefined,
        sellRuleId: row.sell_rule_id ?? undefined,
        sellRuleVersion: row.sell_rule_version ?? undefined,
      })),
      orders: orders.map((row) => ({ id: row.id, refId: row.ref_id, symbol: row.symbol, side: row.side, type: row.type, quantity: row.quantity, limit: row.limit_price, stop: row.stop_price, status: row.status, role: row.role, openedOn: row.opened_on, createdAt: row.created_at })),
      dayTrades,
      proposals: proposals.map((row) => ({ id: row.id, refId: row.ref_id, symbol: row.symbol, verdict: row.verdict, message: row.message, payload: row.payload, createdAt: row.created_at })),
      trades: trades.map((row) => ({
        id: row.id,
        symbol: row.symbol,
        quantity: row.quantity,
        entryPrice: row.entry_price,
        exitPrice: row.exit_price,
        pnl: row.pnl,
        openedOn: row.opened_on,
        closedAt: row.closed_at,
        buyRuleId: row.buy_rule_id ?? undefined,
        buyRuleVersion: row.buy_rule_version ?? undefined,
        sellRuleId: row.sell_rule_id ?? undefined,
        sellRuleVersion: row.sell_rule_version ?? undefined,
        signals: JSON.parse(row.signals),
        reason: row.reason,
      })),
      usedRefIds: proposals.map((row) => row.ref_id),
      rules,
      selectedRuleIds: selected,
      bars,
      spyBars: bars.SPY ?? [],
      spyLast: bars.SPY?.at(-1)?.price,
    };
  }

  private async saveSim(state: SimState): Promise<void> {
    await this.env.DB.prepare("UPDATE app_settings SET cash = ?, day_start_equity = ?, day_start_date = ?, killed = ? WHERE id = 1").bind(state.cash, state.dayStartEquity, state.dayStartDate, state.killed ? 1 : 0).run();
    await this.env.DB.prepare("DELETE FROM sim_positions").run();
    await this.env.DB.prepare("DELETE FROM sim_orders").run();
    await this.env.DB.prepare("DELETE FROM day_trades").run();
    await this.env.DB.prepare("DELETE FROM proposals").run();
    await this.env.DB.prepare("DELETE FROM sim_trades").run();
    await this.env.DB.prepare("DELETE FROM quote_bars").run();
    const barRows = Object.entries(state.bars).flatMap(([symbol, bars]) => bars.map((bar) => ({ symbol, ...bar })));
    const statements = [
      ...state.positions.map((position) => this.env.DB.prepare("INSERT INTO sim_positions (symbol, quantity, avg_cost, opened_on, buy_rule_id, buy_rule_version, sell_rule_id, sell_rule_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(position.symbol, position.quantity, position.avgCost, position.openedOn, position.buyRuleId ?? null, position.buyRuleVersion ?? null, position.sellRuleId ?? null, position.sellRuleVersion ?? null)),
      ...state.orders.map((order) => this.env.DB.prepare("INSERT INTO sim_orders (id, ref_id, symbol, side, type, quantity, limit_price, stop_price, status, role, opened_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(order.id, order.refId, order.symbol, order.side, order.type, order.quantity, order.limit, order.stop, order.status, order.role, order.openedOn, order.createdAt)),
      ...state.dayTrades.map((trade) => this.env.DB.prepare("INSERT INTO day_trades (id, symbol, day) VALUES (?, ?, ?)").bind(crypto.randomUUID(), trade.symbol, trade.day)),
      ...state.proposals.map((proposal) => this.env.DB.prepare("INSERT INTO proposals (id, ref_id, symbol, verdict, message, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(proposal.id, proposal.refId, proposal.symbol, proposal.verdict, proposal.message, proposal.payload, proposal.createdAt)),
      ...(state.trades ?? []).map((trade) => this.env.DB.prepare("INSERT INTO sim_trades (id, symbol, quantity, entry_price, exit_price, pnl, opened_on, closed_at, buy_rule_id, buy_rule_version, sell_rule_id, sell_rule_version, signals, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(trade.id, trade.symbol, trade.quantity, trade.entryPrice, trade.exitPrice, trade.pnl, trade.openedOn, trade.closedAt, trade.buyRuleId ?? null, trade.buyRuleVersion ?? null, trade.sellRuleId ?? null, trade.sellRuleVersion ?? null, JSON.stringify(trade.signals), trade.reason)),
      ...barRows.map((bar) => this.env.DB.prepare("INSERT INTO quote_bars (symbol, ts, price, volume) VALUES (?, ?, ?, ?)").bind(bar.symbol, bar.ts, bar.price, bar.volume)),
    ];
    if (statements.length > 0) await this.env.DB.batch(statements);
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
    const rules = await currentRules(this.env.DB);
    const hasProvenBuyRule = rules.some((rule) => rule.side === "buy" && rule.status === "proven");
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
        await submitGatedTool({ allowLive: this.env.ALLOW_LIVE_TRADING, tool: "place_equity_order", args: bundle.entry, send: (tool, args) => this.mcpCall(token, tool, args) });
        await submitGatedTool({ allowLive: this.env.ALLOW_LIVE_TRADING, tool: "place_equity_order", args: bundle.stop, send: (tool, args) => this.mcpCall(token, tool, args) });
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
      },
      top10: top10.map((symbol) => {
        const quote = book.quotes.find((item) => item.symbol === symbol);
        return {
          symbol,
          bid: quote ? formatUsd(quote.bid) : "Unavailable",
          ask: quote ? formatUsd(quote.ask) : "Unavailable",
          last: quote ? formatUsd(quote.last) : "Unavailable",
          tradable: quote?.tradable ?? false,
        };
      }),
    };
  }

  private async buildSimulator(book: { quotes: QuoteView[]; source: "recorded" | "robinhood" }, events: SimEvent[] = []): Promise<SimulatorView> {
    const state = await this.loadSim();
    const now = new Date();
    const parts = etParts(now);
    const equity = equityOf(state, book.quotes);
    const rules = new Map((await currentRules(this.env.DB)).map((rule) => [rule.id, rule]));
    return {
      cash: formatUsd(state.cash),
      equity: formatUsd(equity),
      dailyLoss: formatUsd(dailyLossAmount(equity, state.dayStartEquity)),
      dailyLossCap: formatUsd(roundMoney(state.dayStartEquity * (state.dailyLossPct / 100))),
      ordersToday: ordersToday(state, now),
      orderCap: state.orderCap,
      killed: state.killed,
      session: marketSession(now),
      clock: `${parts.date} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")} ET`,
      quoteSource: book.source,
      selectedRuleIds: state.selectedRuleIds,
      positions: state.positions.map((position) => {
        const last = book.quotes.find((quote) => quote.symbol === position.symbol)?.last ?? position.avgCost;
        const pnl = roundMoney((last - position.avgCost) * position.quantity);
        const buy = position.buyRuleId ? rules.get(position.buyRuleId) : undefined;
        const sell = position.sellRuleId ? rules.get(position.sellRuleId) : undefined;
        return {
          symbol: position.symbol,
          quantity: formatShares(position.quantity),
          avgCost: formatUsd(position.avgCost),
          last: formatUsd(last),
          marketValue: formatUsd(roundMoney(last * position.quantity)),
          pnl: formatUsd(pnl),
          buyRule: buy ? `${buy.name} v${position.buyRuleVersion ?? buy.version}` : undefined,
          sellRule: sell ? `${sell.name} v${position.sellRuleVersion ?? sell.version}` : undefined,
        };
      }),
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
      proposals: state.proposals.slice(-12).reverse().map((proposal) => ({ symbol: proposal.symbol, verdict: proposal.verdict, message: proposal.message, at: proposal.createdAt })),
    };
  }

  private async ruleViews(): Promise<RuleView[]> {
    const rules = await currentRules(this.env.DB);
    const cards = await scorecards(this.env.DB, rules);
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
      scorecard: cards.get(rule.familyId) ?? { tradeCount: 0, winRate: null, avgProfit: null, worstLoss: null },
    }));
  }

  private robinhoodError: string | undefined;

  async disconnect(): Promise<Summary> {
    await this.env.DB.prepare("DELETE FROM rh_tokens WHERE id = 1").run();
    await this.env.DB.prepare("DELETE FROM oauth_state").run();
    await this.audit("robinhood_disconnected", {});
    return this.summary();
  }

  private async robinhoodSnapshot(): Promise<Summary["robinhood"]> {
    let token: string | undefined;
    try {
      token = await this.accessToken();
    } catch {
      // A saved sign-in that cannot be decrypted (for example after a key change) must not break the summary.
      this.robinhoodError = "The saved Robinhood sign-in could not be read. Disconnect and connect again.";
      await this.audit("robinhood_token_unreadable", {});
      return null;
    }
    if (!token) return null;
    try {
      assertOutgoing("get_accounts", {});
      const accountsPayload = await this.mcpCall(token, "get_accounts", {});
      const account = selectAgentic(parseAccounts(accountsPayload));
      if (!account) {
        this.robinhoodError = "Robinhood is connected, but no agent trading account was found.";
        return null;
      }
      assertOutgoing("get_portfolio", { account_number: account.accountNumber });
      const portfolio = parsePortfolio(await this.mcpCall(token, "get_portfolio", { account_number: account.accountNumber }));
      assertOutgoing("get_realized_pnl", { account_number: account.rhsAccountNumber, span: "day" });
      const pnl = parseRealizedPnl(await this.mcpCall(token, "get_realized_pnl", { account_number: account.rhsAccountNumber, span: "day" }));
      return {
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
    } catch (error) {
      const message = error instanceof Error ? error.message : "read failed";
      this.robinhoodError = `Robinhood is connected, but reading the account failed: ${message.slice(0, 160)}`;
      await this.audit("robinhood_read_failed", { message });
      return null;
    }
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
