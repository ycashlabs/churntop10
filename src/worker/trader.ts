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
import { runSimulatorCycle, type SimState } from "../lib/simulator.js";
import { dailyLossAmount, dayTradeCount, validateNewBuy, type GuardContext } from "../lib/validator.js";
import { decryptString, importTokenKey } from "./crypto.js";
import type { Env } from "./env.js";

const DEFAULT_TOP10 = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "AVGO", "TSLA", "JPM", "LLY"];

interface SettingsRow {
  profit_target_pct: number;
  stop_loss_pct: number;
  max_order_pct: number;
  daily_loss_pct: number;
  pdt_limit: number;
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
    const fillEntries = this.env.ALLOW_LIVE_TRADING !== "1";
    const { state, events } = runSimulatorCycle(await this.loadSim(), book.quotes, now, () => crypto.randomUUID(), book.source, fillEntries);
    await this.saveSim(state);
    for (const event of events) await this.audit(event.action, event.detail);
    if (this.env.ALLOW_LIVE_TRADING === "1") await this.proposeLiveEntries(book.quotes, now);
    const summary = await this.buildSummary(book);
    await this.audit("cycle", { session: summary.session, mode: summary.mode, killed: summary.killed, quoteSource: summary.quoteSource });
    return summary;
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

  async saveSettings(input: { profitTargetPct: number; stopLossPct: number; maxOrderPct: number; dailyLossPct: number }): Promise<Summary> {
    await this.seed();
    const { profitTargetPct, stopLossPct, maxOrderPct, dailyLossPct } = input;
    if (profitTargetPct < 0.1 || profitTargetPct > 3) throw new Error("Profit target must be between 0.1% and 3% of account balance.");
    if (stopLossPct < 0.1 || stopLossPct > 5) throw new Error("Stop-loss must be between 0.1% and 5%.");
    if (maxOrderPct < 1 || maxOrderPct > 25) throw new Error("Order cap must be between 1% and 25% of equity.");
    if (dailyLossPct < 0.1 || dailyLossPct > 5) throw new Error("Daily loss stop must be between 0.1% and 5%.");
    await this.env.DB.prepare("UPDATE app_settings SET profit_target_pct = ?, stop_loss_pct = ?, max_order_pct = ?, daily_loss_pct = ? WHERE id = 1").bind(profitTargetPct, stopLossPct, maxOrderPct, dailyLossPct).run();
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

  async kill(): Promise<Summary> {
    await this.seed();
    await this.env.DB.prepare("UPDATE app_settings SET killed = 1, mode = 'view_only' WHERE id = 1").run();
    await this.env.DB.prepare("UPDATE sim_orders SET status = 'cancelled' WHERE status = 'working' AND role = 'entry'").run();
    await this.audit("kill", { liveCancel: "suppressed" });
    return this.summary();
  }

  async resume(): Promise<Summary> {
    await this.seed();
    await this.env.DB.prepare("UPDATE app_settings SET killed = 0, mode = 'view_only' WHERE id = 1").run();
    await this.audit("resume", { mode: "view_only" });
    return this.summary();
  }

  private async seed(): Promise<void> {
    const existing = await this.env.DB.prepare("SELECT id FROM app_settings WHERE id = 1").first();
    if (existing) return;
    const today = etParts(new Date()).date;
    await this.env.DB.prepare(`INSERT INTO app_settings
      (id, profit_target_pct, stop_loss_pct, max_order_pct, daily_loss_pct, pdt_limit, mode, killed, day_start_equity, day_start_date, cash, account_number)
      VALUES (1, 1, 1, 10, 1, 3, 'view_only', 0, 10000, ?, 10000, 'SIM0000999')`).bind(today).run();
    await this.env.DB.batch(DEFAULT_TOP10.map((symbol, index) => this.env.DB.prepare("INSERT INTO top10 (rank, symbol) VALUES (?, ?)").bind(index + 1, symbol)));
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
    const positions = (await this.env.DB.prepare("SELECT symbol, quantity, avg_cost, opened_on FROM sim_positions").all<PositionRow>()).results;
    const orders = (await this.env.DB.prepare("SELECT id, ref_id, symbol, side, type, quantity, limit_price, stop_price, status, role, opened_on, created_at FROM sim_orders").all<OrderRow & { created_at: number }>()).results;
    const dayTrades = (await this.env.DB.prepare("SELECT symbol, day FROM day_trades").all<{ symbol: string; day: string }>()).results;
    const proposals = (await this.env.DB.prepare("SELECT id, ref_id, symbol, verdict, message, payload, created_at FROM proposals").all<{ id: string; ref_id: string; symbol: string; verdict: string; message: string; payload: string; created_at: number }>()).results;
    return {
      cash: settings.cash,
      dayStartEquity: settings.day_start_equity,
      dayStartDate: settings.day_start_date,
      mode: settings.mode,
      killed: settings.killed === 1,
      profitTargetPct: settings.profit_target_pct,
      stopLossPct: settings.stop_loss_pct,
      maxOrderPct: settings.max_order_pct,
      dailyLossPct: settings.daily_loss_pct,
      pdtLimit: settings.pdt_limit,
      top10,
      positions: positions.map((row) => ({ symbol: row.symbol, quantity: row.quantity, avgCost: row.avg_cost, openedOn: row.opened_on })),
      orders: orders.map((row) => ({ id: row.id, refId: row.ref_id, symbol: row.symbol, side: row.side, type: row.type, quantity: row.quantity, limit: row.limit_price, stop: row.stop_price, status: row.status, role: row.role, openedOn: row.opened_on, createdAt: row.created_at })),
      dayTrades,
      proposals: proposals.map((row) => ({ id: row.id, refId: row.ref_id, symbol: row.symbol, verdict: row.verdict, message: row.message, payload: row.payload, createdAt: row.created_at })),
      usedRefIds: proposals.map((row) => row.ref_id),
    };
  }

  private async saveSim(state: SimState): Promise<void> {
    await this.env.DB.prepare("UPDATE app_settings SET cash = ?, day_start_equity = ?, day_start_date = ? WHERE id = 1").bind(state.cash, state.dayStartEquity, state.dayStartDate).run();
    await this.env.DB.prepare("DELETE FROM sim_positions").run();
    await this.env.DB.prepare("DELETE FROM sim_orders").run();
    await this.env.DB.prepare("DELETE FROM day_trades").run();
    await this.env.DB.prepare("DELETE FROM proposals").run();
    const statements = [
      ...state.positions.map((position) => this.env.DB.prepare("INSERT INTO sim_positions (symbol, quantity, avg_cost, opened_on) VALUES (?, ?, ?, ?)").bind(position.symbol, position.quantity, position.avgCost, position.openedOn)),
      ...state.orders.map((order) => this.env.DB.prepare("INSERT INTO sim_orders (id, ref_id, symbol, side, type, quantity, limit_price, stop_price, status, role, opened_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(order.id, order.refId, order.symbol, order.side, order.type, order.quantity, order.limit, order.stop, order.status, order.role, order.openedOn, order.createdAt)),
      ...state.dayTrades.map((trade) => this.env.DB.prepare("INSERT INTO day_trades (id, symbol, day) VALUES (?, ?, ?)").bind(crypto.randomUUID(), trade.symbol, trade.day)),
      ...state.proposals.map((proposal) => this.env.DB.prepare("INSERT INTO proposals (id, ref_id, symbol, verdict, message, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(proposal.id, proposal.refId, proposal.symbol, proposal.verdict, proposal.message, proposal.payload, proposal.createdAt)),
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
    const held = (await this.env.DB.prepare("SELECT symbol, quantity, avg_cost, opened_on FROM sim_positions").all<PositionRow>()).results;
    const working = (await this.env.DB.prepare("SELECT symbol FROM sim_orders WHERE status IN ('working', 'watching')").all<{ symbol: string }>()).results.map((row) => row.symbol);
    const trades = (await this.env.DB.prepare("SELECT symbol, day FROM day_trades").all<{ symbol: string; day: string }>()).results;
    const refs = (await this.env.DB.prepare("SELECT ref_id FROM proposals").all<{ ref_id: string }>()).results.map((row) => row.ref_id);
    const equity = this.equity(settings.cash, held, quotes);
    for (const symbol of top10) {
      if (held.some((position) => position.symbol === symbol && position.quantity > 0)) continue;
      const refId = crypto.randomUUID();
      const quote = quotes.find((item) => item.symbol === symbol);
      const guard: GuardContext = {
        now,
        mode: settings.mode,
        killed: settings.killed === 1,
        top10,
        held: held.map((position) => ({ symbol: position.symbol, quantity: position.quantity, openedOn: position.opened_on })),
        equity,
        buyingPower: settings.cash,
        dayStartEquity: settings.day_start_equity,
        profitTargetPct: settings.profit_target_pct,
        stopLossPct: settings.stop_loss_pct,
        maxOrderPct: settings.max_order_pct,
        dailyLossPct: settings.daily_loss_pct,
        dayTrades: trades,
        pdtLimit: settings.pdt_limit,
        quote: quote ? { symbol: quote.symbol, bid: quote.bid, ask: quote.ask, last: quote.last, tradable: quote.tradable, hasBidAsk: quote.hasBidAsk, asOf: quote.asOf } : undefined,
        quoteSource: "robinhood",
        workingSymbols: working,
        usedRefIds: refs,
        agenticAllowed: true,
        symbol,
        refId,
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

  private equity(cash: number, positions: PositionRow[], quotes: QuoteView[]): number {
    const market = positions.reduce((sum, position) => {
      const quote = quotes.find((item) => item.symbol === position.symbol);
      return sum + position.quantity * (quote?.last ?? position.avg_cost);
    }, 0);
    return roundMoney(cash + market);
  }

  private async buildSummary(book: { quotes: QuoteView[]; source: "recorded" | "robinhood" }): Promise<Summary> {
    const settings = await this.settings();
    const top10 = (await this.env.DB.prepare("SELECT symbol FROM top10 ORDER BY rank").all<{ symbol: string }>()).results.map((row) => row.symbol);
    const positions = (await this.env.DB.prepare("SELECT symbol, quantity, avg_cost, opened_on FROM sim_positions").all<PositionRow>()).results;
    const orders = (await this.env.DB.prepare("SELECT id, ref_id, symbol, side, type, quantity, limit_price, stop_price, status, role, opened_on FROM sim_orders ORDER BY created_at DESC LIMIT 12").all<OrderRow>()).results;
    const trades = (await this.env.DB.prepare("SELECT symbol, day FROM day_trades").all<{ symbol: string; day: string }>()).results;
    const proposals = (await this.env.DB.prepare("SELECT symbol, verdict, message, created_at FROM proposals ORDER BY created_at DESC LIMIT 10").all<{ symbol: string; verdict: string; message: string; created_at: number }>()).results;
    const equity = this.equity(settings.cash, positions, book.quotes);
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
      simulator: {
        maskedAccount: maskAccountNumber(settings.account_number),
        cash: formatUsd(settings.cash),
        equity: formatUsd(equity),
        dailyLoss: formatUsd(dailyLossAmount(equity, settings.day_start_equity)),
        dailyLossCap: formatUsd(roundMoney(settings.day_start_equity * (settings.daily_loss_pct / 100))),
        dayTrades: dayTradeCount(trades, parts.date),
        pdtLimit: settings.pdt_limit,
        positions: positions.map((position) => {
          const last = book.quotes.find((quote) => quote.symbol === position.symbol)?.last ?? position.avg_cost;
          const pnl = roundMoney((last - position.avg_cost) * position.quantity);
          return {
            symbol: position.symbol,
            quantity: formatShares(position.quantity),
            avgCost: formatUsd(position.avg_cost),
            last: formatUsd(last),
            marketValue: formatUsd(roundMoney(last * position.quantity)),
            pnl: formatUsd(pnl),
          };
        }),
        orders: orders.map((order) => ({
          symbol: order.symbol,
          side: order.side,
          type: order.type,
          quantity: formatShares(order.quantity),
          status: order.status,
          role: order.role,
          price: formatUsd(order.limit_price ?? order.stop_price ?? 0),
        })),
      },
      settings: {
        profitTargetPct: settings.profit_target_pct,
        stopLossPct: settings.stop_loss_pct,
        maxOrderPct: settings.max_order_pct,
        dailyLossPct: settings.daily_loss_pct,
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
      proposals: proposals.map((proposal) => ({ symbol: proposal.symbol, verdict: proposal.verdict, message: proposal.message, at: proposal.created_at })),
    };
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
