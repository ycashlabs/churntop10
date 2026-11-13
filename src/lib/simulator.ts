import { etParts, marketSession, type SessionName } from "./clock.js";
import { nextExitAction, marketableSellLimit } from "./exits.js";
import { dailyLossAmount, validateNewBuy, type GuardContext } from "./validator.js";
import { roundMoney } from "./money.js";
import type { QuoteView } from "./decode.js";
import type { Bar } from "./bars.js";
import { synthesizeBars } from "./bars.js";
import type { RuleRecord } from "./rules.js";
import { allRequiredSignalsFired, computeSignals, signalStrength, type SignalContext, type SignalResult } from "./signals.js";
import { effectiveTradingCapital, openExposure } from "./capital.js";

export interface SimPosition {
  id: string;
  symbol: string;
  quantity: number;
  avgCost: number;
  openedOn: string;
  openedAt: number;
  tradingCapitalSnapshot: number;
  profitTargetPct: number;
  stopLossPct: number;
  buyRuleId?: string;
  buyRuleVersion?: number;
  sellRuleId?: string;
  sellRuleVersion?: number;
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

export interface SimTrade {
  id: string;
  symbol: string;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  openedOn: string;
  closedAt: number;
  buyRuleId?: string;
  buyRuleVersion?: number;
  sellRuleId?: string;
  sellRuleVersion?: number;
  signals: SignalResult[];
  reason: string;
}

export interface SimState {
  cash: number;
  dayStartEquity: number;
  dayStartDate: string;
  mode: "view_only" | "live";
  killed: boolean;
  profitTargetPct: number;
  stopLossPct: number;
  dailyLossPct: number;
  orderCap: number;
  top10: string[];
  positions: SimPosition[];
  orders: SimOrder[];
  dayTrades: { symbol: string; day: string }[];
  proposals: SimProposal[];
  trades: SimTrade[];
  usedRefIds: string[];
  rules: RuleRecord[];
  selectedRuleIds: string[];
  bars: Record<string, Bar[]>;
  spyBars: Bar[];
  spyLast?: number;
  spyPreviousClose?: number;
  tradingCapital: number;
  pendingLegs: SimLeg[];
  closedThisCycle: Array<{ position: SimPosition; exitPrice: number; exitType: string; at: number }>;
}

export interface SimLeg {
  id: string;
  positionId: string;
  ruleVersionId?: string;
  side: "buy" | "sell";
  qty: number;
  limitPrice?: number;
  fillPrice?: number;
  session: string;
  bidAtOrder?: number;
  askAtOrder?: number;
  capitalSnapshot: number;
  sizeReason: string;
  exitReason?: string;
  status: string;
  createdAt: number;
  signals?: SignalResult[];
  symbol: string;
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

export function ordersToday(state: SimState, now: Date): number {
  const today = etParts(now).date;
  return state.orders.filter((item) => item.role === "entry" && item.openedOn === today && item.status === "filled").length;
}

function selected(state: SimState, side: "buy" | "sell"): RuleRecord[] {
  const ids = new Set(state.selectedRuleIds);
  const pool = ids.size === 0 ? state.rules : state.rules.filter((rule) => ids.has(rule.id) || ids.has(rule.familyId));
  return pool.filter((rule) => rule.side === side && rule.status !== "retired");
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
  if (!next.trades) next.trades = [];
  if (!next.rules) next.rules = [];
  if (!next.selectedRuleIds) next.selectedRuleIds = [];
  if (!next.bars) next.bars = {};
  if (!next.spyBars) next.spyBars = [];
  if (!next.pendingLegs) next.pendingLegs = [];
  if (!next.closedThisCycle) next.closedThisCycle = [];
  if (next.tradingCapital == null) next.tradingCapital = 0;
  recordBars(next, quotes, now);
  const events: SimEvent[] = [];
  next = manageSimExits(next, quotes, now, ids, events);
  const exited = new Set(events.filter((event) => event.action.endsWith("_filled") || event.action === "synthetic_stop").map((event) => String(event.detail.symbol ?? "")));
  next = proposeSimEntries(next, quotes, now, ids, quoteSource, events, fillEntries, exited);
  return { state: next, events };
}

export function recordBars(state: SimState, quotes: QuoteView[], now: Date): void {
  for (const quote of quotes) {
    const existing = state.bars[quote.symbol] ?? [];
    if (existing.length < 10) {
      const style = "strength";
      state.bars[quote.symbol] = synthesizeBars({ last: quote.last, now, style, volume: 10_000 });
    } else {
      existing.push({ ts: now.getTime(), price: quote.last, volume: 12_000 });
      state.bars[quote.symbol] = existing.filter((bar) => bar.ts >= now.getTime() - 24 * 60 * 60 * 1000);
    }
  }
  if (state.spyBars.length < 10) {
    const spyLast = state.spyLast ?? 600;
    const prev = state.spyPreviousClose ?? spyLast * 0.995;
    state.spyLast = spyLast;
    state.spyPreviousClose = prev;
    state.spyBars = synthesizeBars({ last: spyLast, now, style: "strength", volume: 50_000 });
  }
}

function signalCtx(state: SimState, symbol: string, quote: QuoteView, now: Date): SignalContext {
  const position = state.positions.find((item) => item.symbol === symbol);
  const bars = state.bars[symbol] ?? [];
  return {
    symbol,
    last: quote.last,
    volume: bars.at(-1)?.volume ?? 12_000,
    now,
    bars,
    spyBars: state.spyBars,
    spyLast: state.spyLast,
    spyPreviousClose: state.spyPreviousClose,
    averageCost: position?.avgCost,
  };
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
  const working = state.orders.filter((item) => (item.status === "working" || item.status === "watching") && item.side === "buy" && (item.role === "entry" || item.role === "")).map((item) => item.symbol);
  const equity = equityOf(state, quotes);
  const buyRules = selected(state, "buy");
  const sellRules = selected(state, "sell");
  const starterRule = buyRules.find((rule) => rule.familyId === "buy-first-strength") ?? buyRules[0];
  const addRules = buyRules.filter((rule) => rule.familyId !== "buy-first-strength");
  const symbols = new Set([...state.top10, ...state.positions.map((position) => position.symbol)]);
  for (const symbol of symbols) {
    if (skipSymbols.has(symbol)) continue;
    const quote = quotes.find((item) => item.symbol === symbol);
    const held = state.positions.find((position) => position.symbol === symbol && position.quantity > 0);
    if (!held && !starterRule) continue;
    const intent = held ? "add" : "starter";
    if (intent === "starter" && !starterRule) continue;
    if (intent === "add" && addRules.length === 0) continue;
    const rule = intent === "starter" ? starterRule : pickAddRule(addRules, state, quote, now);
    if (!rule || !quote) {
      if (!quote && intent === "starter") recordProposal(state, ids, symbol, now, "quote", "No usable quote for this symbol.");
      continue;
    }
    const computed = rule.signals.length ? computeSignals(rule.signals, signalCtx(state, symbol, quote, now)) : [];
    const allFired = allRequiredSignalsFired(computed);
    const strength = intent === "add" ? signalStrength(computed) : 1;
    if (!allFired || (intent === "add" && strength <= 0)) {
      recordProposal(state, ids, symbol, now, "signals", intent === "add" ? "Add signals did not confirm." : "First-buy signals did not confirm.", computed);
      continue;
    }
    const refId = ids();
    const effective = effectiveTradingCapital(state.tradingCapital, equity).capital;
    const snapshot = held?.tradingCapitalSnapshot ?? effective;
    const exposure = openExposure(state.positions.map((position) => {
      const last = quotes.find((item) => item.symbol === position.symbol)?.last;
      return { qty: position.quantity, avgCost: position.avgCost, last };
    }));
    const guard: GuardContext = {
      now,
      mode: "live",
      killed: state.killed,
      top10: state.top10,
      held: state.positions.map((position) => ({ symbol: position.symbol, quantity: position.quantity, openedOn: position.openedOn, notional: roundMoney(position.quantity * position.avgCost) })),
      equity: snapshot,
      accountEquity: equity,
      buyingPower: state.cash,
      dayStartEquity: state.dayStartEquity,
      profitTargetPct: held?.profitTargetPct ?? state.profitTargetPct,
      stopLossPct: held?.stopLossPct ?? state.stopLossPct,
      dailyLossPct: state.dailyLossPct,
      tradingCapital: effective,
      openExposure: exposure,
      orderCap: state.orderCap ?? 100,
      ordersToday: ordersToday(state, now),
      quote: { symbol: quote.symbol, bid: quote.bid, ask: quote.ask, last: quote.last, tradable: quote.tradable, hasBidAsk: quote.hasBidAsk, asOf: quote.asOf },
      quoteSource,
      workingSymbols: working,
      usedRefIds: state.usedRefIds,
      agenticAllowed: true,
      symbol,
      refId,
      intent,
      addStrength: strength,
      audience: "simulator",
    };
    const verdict = validateNewBuy(guard);
    const reason = verdict.sizeReason ?? verdict.message;
    recordProposal(state, ids, symbol, now, verdict.code, `${verdict.message}${reason && reason !== verdict.message ? ` ${reason}` : ""}`, computed);
    if (!verdict.ok || !verdict.bundle || !fillEntries) continue;
    const sellRule = sellRules.find((item) => item.familyId === "sell-take-profit") ?? sellRules[0];
    const filled = fillSimEntry(state, {
      symbol,
      quantity: verdict.bundle.quantity,
      price: Number(verdict.bundle.entry.limit_price),
      stop: verdict.bundle.stopPrice,
      target: verdict.bundle.targetPrice,
      refId,
      stopKind: verdict.bundle.stopKind,
      now,
      ids,
      buyRule: held ? undefined : rule,
      sellRule: held ? undefined : sellRule,
      signals: computed,
    });
    if (filled) {
      working.push(symbol);
      events.push({
        action: intent === "add" ? "sim_add" : "sim_entry",
        detail: {
          symbol,
          session: marketSession(now),
          stopKind: verdict.bundle.stopKind,
          quantity: verdict.bundle.quantity,
          strength,
          sizeReason: reason,
          rule: rule.name,
          ruleVersion: rule.version,
          signals: computed,
        },
      });
    }
  }
  return state;
}

function pickAddRule(rules: RuleRecord[], state: SimState, quote: QuoteView | undefined, now: Date): RuleRecord | undefined {
  if (!quote) return undefined;
  for (const rule of rules) {
    const computed = computeSignals(rule.signals, signalCtx(state, quote.symbol, quote, now));
    if (allRequiredSignalsFired(computed)) return rule;
  }
  return rules[0];
}

function recordProposal(state: SimState, ids: () => string, symbol: string, now: Date, verdict: string, message: string, signals?: SignalResult[]): void {
  const recent = [...state.proposals].reverse().find((proposal) => proposal.symbol === symbol);
  const duplicate = recent && recent.verdict === verdict && now.getTime() - recent.createdAt < 30 * 60 * 1000;
  if (duplicate) return;
  state.proposals.push({ id: ids(), refId: ids(), symbol, verdict, message, payload: JSON.stringify(signals ?? null), createdAt: now.getTime() });
}

export function fillSimEntry(
  state: SimState,
  input: {
    symbol: string;
    quantity: number;
    price: number;
    stop: number;
    target: number;
    refId: string;
    stopKind: "broker" | "synthetic";
    now: Date;
    ids: () => string;
    buyRule?: RuleRecord;
    sellRule?: RuleRecord;
    signals?: SignalResult[];
  },
): boolean {
  const cost = roundMoney(input.quantity * input.price);
  if (cost > state.cash) return false;
  const today = etParts(input.now).date;
  state.cash = roundMoney(state.cash - cost);
  const existing = state.positions.find((position) => position.symbol === input.symbol);
  let stop = input.stop;
  let target = input.target;
  if (existing) {
    const totalQty = existing.quantity + input.quantity;
    existing.avgCost = roundMoney((existing.quantity * existing.avgCost + cost) / totalQty);
    existing.quantity = totalQty;
    stop = roundMoney(existing.avgCost * (1 - existing.stopLossPct / 100));
    target = roundMoney(existing.avgCost * (1 + existing.profitTargetPct / 100));
    rebaseExits(state, existing, stop, target);
  } else {
    const equity = state.cash + cost;
    const snapshot = effectiveTradingCapital(state.tradingCapital, equity).capital;
    state.positions.push({
      id: input.ids(),
      symbol: input.symbol,
      quantity: input.quantity,
      avgCost: input.price,
      openedOn: today,
      openedAt: input.now.getTime(),
      tradingCapitalSnapshot: snapshot,
      profitTargetPct: state.profitTargetPct,
      stopLossPct: state.stopLossPct,
      buyRuleId: input.buyRule?.id,
      buyRuleVersion: input.buyRule?.version,
      sellRuleId: input.sellRule?.id,
      sellRuleVersion: input.sellRule?.version,
    });
  }
  const at = input.now.getTime();
  state.orders.push(order(input.ids(), input.refId, input.symbol, "buy", "limit", input.quantity, input.price, null, "filled", "entry", today, at));
  if (!existing) {
    state.orders.push(order(
      input.ids(),
      `${input.refId}-stop`,
      input.symbol,
      "sell",
      input.stopKind === "broker" ? "stop_market" : "synthetic",
      input.quantity,
      null,
      stop,
      input.stopKind === "broker" ? "working" : "watching",
      "stop",
      today,
      at,
    ));
    state.orders.push(order(input.ids(), `${input.refId}-target`, input.symbol, "sell", "limit", input.quantity, target, null, "working", "target", today, at));
  }
  state.usedRefIds.push(input.refId);
  const position = state.positions.find((item) => item.symbol === input.symbol);
  if (position) {
    state.pendingLegs = state.pendingLegs ?? [];
    state.pendingLegs.push({
      id: input.ids(),
      positionId: position.id,
      ruleVersionId: input.buyRule?.id ?? position.buyRuleId,
      side: "buy",
      qty: input.quantity,
      limitPrice: input.price,
      fillPrice: input.price,
      session: marketSession(input.now),
      capitalSnapshot: position.tradingCapitalSnapshot,
      sizeReason: existing ? "Add sized from signal strength, using the position Trading capital snapshot." : "Starter buy of 20% of the max position (2% of the position Trading capital snapshot).",
      status: "filled",
      createdAt: at,
      symbol: input.symbol,
      signals: input.signals ?? [],
    });
  }
  return true;
}

function rebaseExits(state: SimState, position: SimPosition, stop: number, target: number): void {
  for (const item of state.orders) {
    if (item.symbol !== position.symbol) continue;
    if (item.status !== "working" && item.status !== "watching") continue;
    if (item.role === "stop") {
      item.stop = stop;
      item.quantity = position.quantity;
    }
    if (item.role === "target") {
      item.limit = target;
      item.quantity = position.quantity;
    }
  }
}

export function manageSimExits(state: SimState, quotes: QuoteView[], now: Date, ids: () => string, events: SimEvent[]): SimState {
  const session = marketSession(now);
  for (const position of [...state.positions]) {
    const quote = quotes.find((item) => item.symbol === position.symbol);
    if (!quote) continue;
    if (tryWeaknessExit(state, position, quote, session, now, ids, events)) continue;
    applyExitsForPosition(state, position, quote, session, now, ids, events);
  }
  return state;
}

function tryWeaknessExit(state: SimState, position: SimPosition, quote: QuoteView, session: SessionName, now: Date, ids: () => string, events: SimEvent[]): boolean {
  if (session === "closed") return false;
  const rule = selected(state, "sell").find((item) => item.familyId === "sell-exit-weakness");
  if (!rule) return false;
  const computed = computeSignals(rule.signals, signalCtx(state, position.symbol, quote, now));
  if (!allRequiredSignalsFired(computed)) return false;
  const price = quote.hasBidAsk ? marketableSellLimit(quote.bid, quote.last) : quote.last;
  closeSimPosition(state, position, price, "weakness", now, ids, computed, `Exit on weakness: ${computed.map((item) => item.reason).join(" ")}`);
  events.push({ action: "weakness_exit_filled", detail: { symbol: position.symbol, price, signals: computed, rule: rule.name, ruleVersion: rule.version } });
  return true;
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
  const stopOrder = state.orders.find((item) => item.symbol === position.symbol && item.role === "stop" && (item.status === "working" || item.status === "watching"));
  const targetOrder = state.orders.find((item) => item.symbol === position.symbol && item.role === "target" && item.status === "working");
  const exitOrder = state.orders.find((item) => item.symbol === position.symbol && item.role === "stop_exit" && item.status === "working");
  const takeProfitArmed = !selected(state, "sell").length || selected(state, "sell").some((rule) => rule.familyId === "sell-take-profit");
  const stopArmed = !selected(state, "sell").length || selected(state, "sell").some((rule) => rule.familyId === "sell-stop-loss");
  const book = {
    session,
    last: quote.last,
    bid: quote.bid,
    hasBid: quote.hasBidAsk,
    stopPrice: stopArmed ? stopOrder?.stop ?? undefined : undefined,
    stopKind: stopOrder ? (stopOrder.type === "synthetic" || stopOrder.status === "watching" ? "synthetic" as const : "broker" as const) : undefined,
    stopExitLimit: exitOrder?.limit ?? undefined,
    targetPrice: takeProfitArmed ? targetOrder?.limit ?? undefined : undefined,
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

export function sellAllSimPositions(state: SimState, quotes: QuoteView[], now: Date, ids: () => string): { state: SimState; events: SimEvent[] } {
  state.pendingLegs = state.pendingLegs ?? [];
  state.closedThisCycle = state.closedThisCycle ?? [];
  const next = structuredClone(state);
  next.killed = true;
  const events: SimEvent[] = [];
  const session = marketSession(now);
  for (const position of [...next.positions]) {
    const quote = quotes.find((item) => item.symbol === position.symbol);
    if (!quote || session === "closed") {
      events.push({ action: "sell_all_deferred", detail: { symbol: position.symbol, session } });
      continue;
    }
    const price = quote.hasBidAsk ? marketableSellLimit(quote.bid, quote.last) : quote.last;
    closeSimPosition(next, position, price, "manual", now, ids, [], "Sell All Positions.");
    events.push({ action: "sell_all_filled", detail: { symbol: position.symbol, price } });
  }
  for (const item of next.orders) {
    if (item.role === "entry" && item.status === "working") item.status = "cancelled";
  }
  return { state: next, events };
}

export function closeSimPosition(state: SimState, position: SimPosition, price: number, role: "stop" | "target" | "stop_exit" | "weakness" | "manual", now: Date, ids: () => string, signals: SignalResult[] = [], reason = ""): void {
  const proceeds = roundMoney(position.quantity * price);
  const pnl = roundMoney(proceeds - position.quantity * position.avgCost);
  state.cash = roundMoney(state.cash + proceeds);
  state.positions = state.positions.filter((item) => item.symbol !== position.symbol);
  let marked = false;
  for (const item of state.orders) {
    if (item.symbol !== position.symbol) continue;
    if (item.status !== "working" && item.status !== "watching") continue;
    if (item.role !== "stop" && item.role !== "target" && item.role !== "stop_exit") continue;
    if (item.role === role || (role === "weakness" || role === "manual")) {
      if (item.role === role) {
        item.status = "filled";
        if (role !== "stop") item.limit = price;
        marked = true;
      } else {
        item.status = "cancelled";
      }
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
  if (!state.trades) state.trades = [];
  state.trades.push({
    id: ids(),
    symbol: position.symbol,
    quantity: position.quantity,
    entryPrice: position.avgCost,
    exitPrice: price,
    pnl,
    openedOn: position.openedOn,
    closedAt: now.getTime(),
    buyRuleId: position.buyRuleId,
    buyRuleVersion: position.buyRuleVersion,
    sellRuleId: position.sellRuleId,
    sellRuleVersion: position.sellRuleVersion,
    signals,
    reason: reason || `${role} exit`,
  });
  state.pendingLegs = state.pendingLegs ?? [];
  state.closedThisCycle = state.closedThisCycle ?? [];
  state.pendingLegs.push({
    id: ids(),
    positionId: position.id,
    ruleVersionId: position.sellRuleId,
    side: "sell",
    qty: position.quantity,
    limitPrice: price,
    fillPrice: price,
    session: marketSession(now),
    capitalSnapshot: position.tradingCapitalSnapshot,
    sizeReason: "Full exit. Sells have no dollar limit.",
    exitReason: reason || `${role} exit`,
    status: "filled",
    createdAt: now.getTime(),
    signals,
    symbol: position.symbol,
  });
  state.closedThisCycle.push({ position, exitPrice: price, exitType: role, at: now.getTime() });
}

function order(id: string, refId: string, symbol: string, side: string, type: string, quantity: number, limit: number | null, stop: number | null, status: string, role: string, openedOn: string, createdAt: number): SimOrder {
  return { id, refId, symbol, side, type, quantity, limit, stop, status, role, openedOn, createdAt };
}

export { dailyLossAmount };
