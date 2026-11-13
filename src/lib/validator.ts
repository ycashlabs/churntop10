import { businessDaysAgo, etParts, marketSession, type SessionName } from "./clock.js";
import { quoteIsStale, spreadRatio, MAX_SPREAD } from "./exits.js";
import { buildEntryBundle, type EntryBundle } from "./orders.js";
import { roundMoney } from "./money.js";

export interface HeldPosition {
  symbol: string;
  quantity: number;
  openedOn: string;
}

export interface DayTrade {
  symbol: string;
  day: string;
}

export interface GuardContext {
  now: Date;
  mode: "view_only" | "live";
  killed: boolean;
  top10: string[];
  held: HeldPosition[];
  equity: number;
  buyingPower: number;
  dayStartEquity: number;
  profitTargetPct: number;
  stopLossPct: number;
  maxOrderPct: number;
  dailyLossPct: number;
  dayTrades: DayTrade[];
  pdtLimit: number;
  quote?: { symbol: string; bid: number; ask: number; last: number; tradable: boolean; hasBidAsk?: boolean; asOf?: string; overnightEligible?: boolean };
  quoteSource?: "recorded" | "robinhood";
  workingSymbols: string[];
  usedRefIds: string[];
  agenticAllowed: boolean;
  symbol: string;
  refId: string;
}

export interface Verdict {
  ok: boolean;
  code: string;
  message: string;
  bundle?: EntryBundle;
}

const ORDER: string[] = [
  "kill_switch",
  "agentic_account",
  "symbol",
  "settings",
  "quote",
  "top10",
  "already_working",
  "session",
  "overnight",
  "stale",
  "spread",
  "daily_loss",
  "pdt",
  "cap",
  "stop",
  "duplicate",
  "view_only",
];

export function guardOrder(): readonly string[] {
  return ORDER;
}

function fail(code: string, message: string, bundle?: EntryBundle): Verdict {
  return { ok: false, code, message, bundle };
}

export function dailyLossAmount(equityNow: number, dayStartEquity: number): number {
  return roundMoney(Math.max(0, dayStartEquity - equityNow));
}

export function dayTradeCount(trades: DayTrade[], today: string): number {
  const windowStart = businessDaysAgo(today, 4);
  return trades.filter((trade) => trade.day >= windowStart && trade.day <= today).length;
}

export function sizeEntry(input: { equity: number; ask: number; profitTargetPct: number; stopLossPct: number; maxOrderPct: number; buyingPower: number }): { quantity: number; notional: number; goal: number } | { error: "cap" | "price" } {
  if (!(input.ask > 0) || !(input.equity > 0)) return { error: "price" };
  const goal = roundMoney(input.equity * (input.profitTargetPct / 100));
  const cap = roundMoney(input.equity * (input.maxOrderPct / 100));
  const room = Math.min(cap, input.buyingPower);
  if (room <= 0) return { error: "cap" };
  if (input.ask > room + 0.001) return { error: "cap" };
  const move = input.stopLossPct / 100;
  const desired = move > 0 ? goal / move : room;
  const notional = Math.min(desired, room);
  const quantity = Math.floor(notional / input.ask);
  if (quantity < 1) return { error: "cap" };
  return { quantity, notional: roundMoney(quantity * input.ask), goal };
}

/**
 * New buys only. First failing guard wins, in `guardOrder()` sequence.
 * A passing plan still includes the protective stop and the take-profit.
 * View Only is last so a sound plan can be shown without being sent.
 */
export function validateNewBuy(ctx: GuardContext): Verdict {
  if (ctx.killed) {
    return fail("kill_switch", "Kill switch is on. New buys are stopped.");
  }
  if (!ctx.agenticAllowed) {
    return fail("agentic_account", "This account is not agent-tradable. New buys stay off.");
  }
  const symbol = ctx.symbol.trim().toUpperCase();
  if (!/^[A-Z]{1,5}$/.test(symbol)) {
    return fail("symbol", "Symbol must be 1 to 5 letters.");
  }
  if (ctx.profitTargetPct < 0.1 || ctx.profitTargetPct > 3 || ctx.stopLossPct < 0.1 || ctx.stopLossPct > 5 || ctx.maxOrderPct < 1 || ctx.maxOrderPct > 25 || ctx.dailyLossPct < 0.1 || ctx.dailyLossPct > 5) {
    return fail("settings", "Profit target, stop, or a cap is outside its allowed range.");
  }
  const quote = ctx.quote;
  if (!quote || quote.symbol.toUpperCase() !== symbol || !quote.tradable || !(quote.ask > 0)) {
    return fail("quote", "No usable quote for this symbol.");
  }
  const held = ctx.held.find((position) => position.symbol.toUpperCase() === symbol && position.quantity > 0);
  if (!held && !ctx.top10.map((item) => item.toUpperCase()).includes(symbol)) {
    return fail("top10", "New buys have to be in the Top 10. Buys that add to a name you already hold, and all sells, are not limited by the list.");
  }
  if (ctx.workingSymbols.map((item) => item.toUpperCase()).includes(symbol)) {
    return fail("already_working", "An order for this symbol is already working.");
  }
  const session: SessionName = marketSession(ctx.now);
  if (session === "closed") {
    return fail("session", "The market is closed from Friday 8:00 PM to Sunday 8:00 PM ET. New buys wait for the next session.");
  }
  if (session === "overnight" && quote.overnightEligible === false) {
    return fail("overnight", "This symbol is not eligible for the 24 Hour Market, so it cannot be bought overnight.");
  }
  if (quoteIsStale(quote.asOf, ctx.now, ctx.quoteSource ?? "recorded")) {
    return fail("stale", "The live quote is older than 5 minutes. New buys wait for a fresh print.");
  }
  if (quote.hasBidAsk === false) {
    return fail("spread", "Bid or ask is missing. New buys need both sides of the quote.");
  }
  const spread = spreadRatio(quote.bid, quote.ask);
  if (spread === undefined || spread > MAX_SPREAD) {
    return fail("spread", "The bid-ask spread is wider than 1%. New buys wait for a tighter market.");
  }
  const loss = dailyLossAmount(ctx.equity, ctx.dayStartEquity);
  const lossCap = roundMoney(ctx.dayStartEquity * (ctx.dailyLossPct / 100));
  if (loss >= lossCap && lossCap > 0) {
    return fail("daily_loss", "Daily loss stop is hit. New buys are paused. Protective sells still run.");
  }
  const today = etParts(ctx.now).date;
  if (dayTradeCount(ctx.dayTrades, today) >= ctx.pdtLimit) {
    return fail("pdt", "Day-trade cap is reached for this 5-business-day window. New buys are paused. Stop-loss sells still run.");
  }
  const sized = sizeEntry({
    equity: ctx.equity,
    ask: quote.ask,
    profitTargetPct: ctx.profitTargetPct,
    stopLossPct: ctx.stopLossPct,
    maxOrderPct: ctx.maxOrderPct,
    buyingPower: ctx.buyingPower,
  });
  if ("error" in sized) {
    return fail("cap", "One share costs more than the order cap or buying power.");
  }
  const bundle = buildEntryBundle({
    accountNumber: "pending",
    symbol,
    ask: quote.ask,
    quantity: sized.quantity,
    stopLossPct: ctx.stopLossPct,
    profitTargetDollars: roundMoney(sized.quantity * quote.ask * (ctx.stopLossPct / 100)),
    refId: ctx.refId,
    session,
  });
  if (!bundle.stop.stop_price || Number(bundle.stop.stop_price) >= quote.ask) {
    return fail("stop", "Every new buy needs a stop below the entry.", bundle);
  }
  if (!bundle.entry.limit_price || bundle.entry.side !== "buy" || bundle.stop.side !== "sell") {
    return fail("stop", "Every new buy needs a paired stop-loss sell.", bundle);
  }
  if (ctx.usedRefIds.includes(ctx.refId)) {
    return fail("duplicate", "This order was already submitted.", bundle);
  }
  if (ctx.mode === "view_only") {
    return fail("view_only", "View Only is on. The order was checked and not sent.", bundle);
  }
  return { ok: true, code: "ok", message: "Checked. Ready for the simulator.", bundle };
}

export interface ExitContext {
  now: Date;
  killed: boolean;
  quantity: number;
  bid: number;
  kind: "stop" | "target" | "manual";
  sessionOverride?: SessionName;
}

export function validateExit(ctx: ExitContext): { ok: boolean; code: string; message: string } {
  const session = ctx.sessionOverride ?? marketSession(ctx.now);
  if (session === "closed") return { ok: false, code: "session", message: "The market is closed. The exit waits for the next session." };
  if (!(ctx.quantity > 0) || !(ctx.bid > 0)) return { ok: false, code: "quote", message: "No position or quote to sell." };
  if (ctx.kind === "manual" && ctx.killed) {
    return { ok: true, code: "kill_exit", message: "Kill switch is flattening this position in the simulator." };
  }
  if (session !== "regular" && ctx.kind !== "stop" && ctx.kind !== "target" && ctx.kind !== "manual") {
    return { ok: false, code: "session", message: "Outside regular hours only limit exits are sent." };
  }
  return { ok: true, code: "ok", message: "Exit allowed. Stop-loss and target sells are not blocked by the Top 10, the day-trade cap, or the daily loss stop." };
}
