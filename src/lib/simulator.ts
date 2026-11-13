import { etParts, marketSession, type SessionName } from "./clock.js";
import { nextExitAction } from "./exits.js";
import { dailyLossAmount, dayTradeCount, validateNewBuy, type GuardContext } from "./validator.js";
import { roundMoney } from "./money.js";
import type { QuoteView } from "./decode.js";

export interface SimPosition {
  symbol: string;
  quantity: number;
  avgCost: number;
  openedOn: string;
}

export interface SimOrder {
  id: string;
  refId: string;
  symbol: string;
  side: string;
  type: string;
  quantity: number;
  limit: number | null;
  stop: number | null;
  status: string;
  role: string;
  openedOn: string;
  createdAt: number;
}

export interface SimProposal {
  id: string;
  refId: string;
  symbol: string;
  verdict: string;
  message: string;
  payload: string;
  createdAt: number;
}

export interface SimState {
  cash: number;
  dayStartEquity: number;
  dayStartDate: string;
  mode: "view_only" | "live";
  killed: boolean;
  profitTargetPct: number;
  stopLossPct: number;
  maxOrderPct: number;
  dailyLossPct: number;
  pdtLimit: number;
  top10: string[];
  positions: SimPosition[];
  orders: SimOrder[];
  dayTrades: { symbol: string; day: string }[];
  proposals: SimProposal[];
  usedRefIds: string[];
}

export interface SimEvent {
  action: string;
  detail: Record<string, unknown>;
}

export function rollSimDay(state: SimState, quotes: QuoteView[], now: Date): SimState {
  const today = etParts(now).date;
  if (state.dayStartDate === today) return state;
  return { ...state, dayStartEquity: equityOf(state, quotes), dayStartDate: today };
}

export function equityOf(state: SimState, quotes: QuoteView[]): number {
  const market = state.positions.reduce((sum, position) => {
    const quote = quotes.find((item) => item.symbol === position.symbol);
    return sum + position.quantity * (quote?.last ?? position.avgCost);
  }, 0);
  return roundMoney(state.cash + market);
}

export function runSimulatorCycle(
  state: SimState,
  quotes: QuoteView[],
  now: Date,
  ids: () => string,
  quoteSource: "recorded" | "robinhood" = "recorded",
  fillEntries = true,
): { state: SimState; events: SimEvent[] } {
  let next = rollSimDay(structuredClone(state), quotes, now);
  const events: SimEvent[] = [];
  next = manageSimExits(next, quotes, now, ids, events);
  const exited = new Set(events.filter((event) => event.action.endsWith("_filled") || event.action === "synthetic_stop").map((event) => String(event.detail.symbol ?? "")));
  next = proposeSimEntries(next, quotes, now, ids, quoteSource, events, fillEntries, exited);
  return { state: next, events };
}

export function proposeSimEntries(
  state: SimState,
  quotes: QuoteView[],
  now: Date,
  ids: () => string,
  quoteSource: "recorded" | "robinhood",
  events: SimEvent[],
  fillEntries = true,
  skipSymbols: Set<string> = new Set(),
): SimState {
  const working = state.orders.filter((order) => order.status === "working" || order.status === "watching").map((order) => order.symbol);
  const equity = equityOf(state, quotes);
  for (const symbol of state.top10) {
    if (skipSymbols.has(symbol)) continue;
    if (state.positions.some((position) => position.symbol === symbol && position.quantity > 0)) continue;
    const refId = ids();
    const quote = quotes.find((item) => item.symbol === symbol);
    const guard: GuardContext = {
      now,
      mode: state.mode,
      killed: state.killed,
      top10: state.top10,
      held: state.positions.map((position) => ({ symbol: position.symbol, quantity: position.quantity, openedOn: position.openedOn })),
      equity,
      buyingPower: state.cash,
      dayStartEquity: state.dayStartEquity,
      profitTargetPct: state.profitTargetPct,
      stopLossPct: state.stopLossPct,
      maxOrderPct: state.maxOrderPct,
      dailyLossPct: state.dailyLossPct,
      dayTrades: state.dayTrades,
      pdtLimit: state.pdtLimit,
      quote: quote
        ? { symbol: quote.symbol, bid: quote.bid, ask: quote.ask, last: quote.last, tradable: quote.tradable, hasBidAsk: quote.hasBidAsk, asOf: quote.asOf }
        : undefined,
      quoteSource,
      workingSymbols: working,
      usedRefIds: state.usedRefIds,
      agenticAllowed: true,
      symbol,
      refId,
    };
    const verdict = validateNewBuy(guard);
    const recent = [...state.proposals].reverse().find((proposal) => proposal.symbol === symbol);
    const duplicate = recent && recent.verdict === verdict.code && now.getTime() - recent.createdAt < 30 * 60 * 1000;
    if (!duplicate) {
      state.proposals.push({ id: ids(), refId, symbol, verdict: verdict.code, message: verdict.message, payload: JSON.stringify(verdict.bundle?.entry ?? null), createdAt: now.getTime() });
    }
    if (!verdict.ok || !verdict.bundle || !fillEntries) continue;
    const filled = fillSimEntry(state, symbol, verdict.bundle.quantity, Number(verdict.bundle.entry.limit_price), verdict.bundle.stopPrice, Number(verdict.bundle.takeProfit.limit_price), refId, verdict.bundle.stopKind, now, ids);
    if (filled) {
      working.push(symbol);
      events.push({ action: "sim_entry", detail: { symbol, session: marketSession(now), stopKind: verdict.bundle.stopKind, quantity: verdict.bundle.quantity } });
    }
  }
  return state;
}

export function fillSimEntry(
  state: SimState,
  symbol: string,
  quantity: number,
  price: number,
  stop: number,
  target: number,
  refId: string,
  stopKind: "broker" | "synthetic",
  now: Date,
  ids: () => string,
): boolean {
  const cost = roundMoney(quantity * price);
  if (cost > state.cash) return false;
  const today = etParts(now).date;
  state.cash = roundMoney(state.cash - cost);
  const existing = state.positions.find((position) => position.symbol === symbol);
  if (existing) {
    const totalQty = existing.quantity + quantity;
    existing.avgCost = roundMoney((existing.quantity * existing.avgCost + cost) / totalQty);
    existing.quantity = totalQty;
  } else {
    state.positions.push({ symbol, quantity, avgCost: price, openedOn: today });
  }
  const at = now.getTime();
  state.orders.push(order(ids(), refId, symbol, "buy", "limit", quantity, price, null, "filled", "entry", today, at));
  state.orders.push(order(
    ids(),
    `${refId}-stop`,
    symbol,
    "sell",
    stopKind === "broker" ? "stop_market" : "synthetic",
    quantity,
    null,
    stop,
    stopKind === "broker" ? "working" : "watching",
    "stop",
    today,
    at,
  ));
  state.orders.push(order(ids(), `${refId}-target`, symbol, "sell", "limit", quantity, target, null, "working", "target", today, at));
  state.usedRefIds.push(refId);
  return true;
}

export function manageSimExits(state: SimState, quotes: QuoteView[], now: Date, ids: () => string, events: SimEvent[]): SimState {
  const session = marketSession(now);
  for (const position of [...state.positions]) {
    const quote = quotes.find((item) => item.symbol === position.symbol);
    if (!quote) continue;
    applyExitsForPosition(state, position, quote, session, now, ids, events);
  }
  return state;
}

function applyExitsForPosition(
  state: SimState,
  position: SimPosition,
  quote: QuoteView,
  session: SessionName,
  now: Date,
  ids: () => string,
  events: SimEvent[],
): void {
  const stopOrder = state.orders.find((order) => order.symbol === position.symbol && order.role === "stop" && (order.status === "working" || order.status === "watching"));
  const targetOrder = state.orders.find((order) => order.symbol === position.symbol && order.role === "target" && order.status === "working");
  const exitOrder = state.orders.find((order) => order.symbol === position.symbol && order.role === "stop_exit" && order.status === "working");
  const book = {
    session,
    last: quote.last,
    bid: quote.bid,
    hasBid: quote.hasBidAsk,
    stopPrice: stopOrder?.stop ?? undefined,
    stopKind: stopOrder ? (stopOrder.type === "synthetic" || stopOrder.status === "watching" ? "synthetic" as const : "broker" as const) : undefined,
    stopExitLimit: exitOrder?.limit ?? undefined,
    targetPrice: targetOrder?.limit ?? undefined,
    quantity: position.quantity,
  };
  let action = nextExitAction(book);
  if (action.type === "attach_broker_stop" && stopOrder) {
    stopOrder.type = "stop_market";
    stopOrder.status = "working";
    events.push({ action: "broker_stop_attached", detail: { symbol: position.symbol, stop: stopOrder.stop } });
    book.stopKind = "broker";
    action = nextExitAction(book);
  }
  if (action.type === "fire_synthetic") {
    if (targetOrder) targetOrder.status = "cancelled";
    if (stopOrder) stopOrder.status = "cancelled";
    state.orders.push(order(ids(), ids(), position.symbol, "sell", "limit", position.quantity, action.limitPrice, stopOrder?.stop ?? null, "working", "stop_exit", position.openedOn, now.getTime()));
    events.push({ action: "synthetic_stop", detail: { symbol: position.symbol, limit: action.limitPrice, last: quote.last } });
    const opened = state.orders.find((item) => item.symbol === position.symbol && item.role === "stop_exit" && item.status === "working");
    if (opened && opened.limit !== null && quote.hasBidAsk && opened.limit <= quote.bid) {
      closeSimPosition(state, position, opened.limit, "stop_exit", now, ids);
      events.push({ action: "stop_exit_filled", detail: { symbol: position.symbol, price: opened.limit } });
    }
    return;
  }
  if (action.type === "reprice_stop_exit" && exitOrder) {
    exitOrder.limit = action.limitPrice;
    events.push({ action: "stop_exit_reprice", detail: { symbol: position.symbol, limit: action.limitPrice } });
    if (quote.hasBidAsk && action.limitPrice <= quote.bid) {
      closeSimPosition(state, position, action.limitPrice, "stop_exit", now, ids);
      events.push({ action: "stop_exit_filled", detail: { symbol: position.symbol, price: action.limitPrice } });
    }
    return;
  }
  if (action.type === "fill_stop_exit") {
    closeSimPosition(state, position, action.price, "stop_exit", now, ids);
    events.push({ action: "stop_exit_filled", detail: { symbol: position.symbol, price: action.price } });
    return;
  }
  if (action.type === "fill_broker_stop") {
    closeSimPosition(state, position, action.price, "stop", now, ids);
    events.push({ action: "broker_stop_filled", detail: { symbol: position.symbol, price: action.price } });
    return;
  }
  if (action.type === "fill_target") {
    closeSimPosition(state, position, action.price, "target", now, ids);
    events.push({ action: "target_filled", detail: { symbol: position.symbol, price: action.price } });
  }
}

export function closeSimPosition(state: SimState, position: SimPosition, price: number, role: "stop" | "target" | "stop_exit", now: Date, ids: () => string): void {
  const proceeds = roundMoney(position.quantity * price);
  state.cash = roundMoney(state.cash + proceeds);
  state.positions = state.positions.filter((item) => item.symbol !== position.symbol);
  let marked = false;
  for (const item of state.orders) {
    if (item.symbol !== position.symbol) continue;
    if (item.status !== "working" && item.status !== "watching") continue;
    if (item.role !== "stop" && item.role !== "target" && item.role !== "stop_exit") continue;
    if (item.role === role) {
      item.status = "filled";
      if (role !== "stop") item.limit = price;
      marked = true;
    } else {
      item.status = "cancelled";
    }
  }
  if (!marked) {
    const type = role === "stop" ? "stop_market" : "limit";
    state.orders.push(order(ids(), ids(), position.symbol, "sell", type, position.quantity, role === "stop" ? null : price, role === "stop" ? price : null, "filled", role, position.openedOn, now.getTime()));
  }
  if (position.openedOn === etParts(now).date) {
    state.dayTrades.push({ symbol: position.symbol, day: etParts(now).date });
  }
}

function order(id: string, refId: string, symbol: string, side: string, type: string, quantity: number, limit: number | null, stop: number | null, status: string, role: string, openedOn: string, createdAt: number): SimOrder {
  return { id, refId, symbol, side, type, quantity, limit, stop, status, role, openedOn, createdAt };
}

export { dailyLossAmount, dayTradeCount };
