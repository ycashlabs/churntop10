import { marketSession, type SessionName } from "./clock.js";
import { quoteIsStale, spreadRatio, MAX_SPREAD } from "./exits.js";
import { buildEntryBundle, type EntryBundle } from "./orders.js";
import { roundMoney } from "./money.js";
import { remainingRoom, sizeAdd, sizeStarter } from "./sizing.js";

export interface HeldPosition {
  symbol: string;
  quantity: number;
  openedOn: string;
  notional?: number;
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
  dailyLossPct: number;
  orderCap: number;
  ordersToday: number;
  quote?: { symbol: string; bid: number; ask: number; last: number; tradable: boolean; hasBidAsk?: boolean; asOf?: string; overnightEligible?: boolean };
  quoteSource?: "recorded" | "robinhood";
  workingSymbols: string[];
  usedRefIds: string[];
  agenticAllowed: boolean;
  symbol: string;
  refId: string;
  intent?: "starter" | "add";
  addStrength?: number;
  audience?: "simulator" | "live";
  hasProvenBuyRule?: boolean;
}

export interface Verdict {
  ok: boolean;
  code: string;
  message: string;
  bundle?: EntryBundle;
  sizeReason?: string;
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
  "order_cap",
  "proven",
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

/** Profit target and stop-loss: any positive percent, capped at 100 so a typo cannot invert the order. */
export function validExitPct(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= 100;
}

export function dailyLossAmount(equityNow: number, dayStartEquity: number): number {
  return roundMoney(Math.max(0, dayStartEquity - equityNow));
}

/**
 * New buys and scale-in adds. First failing guard wins, in `guardOrder()` sequence.
 * A passing plan still includes the protective stop and the take-profit.
 * View Only is last so a sound live plan can be shown without being sent.
 * The PDT day-trade cap is removed (FINRA Notice 26-10).
 */
export function validateNewBuy(ctx: GuardContext): Verdict {
  if (ctx.killed) {
    return fail("kill_switch", "Sell All Positions is on. New buys are stopped.");
  }
  if (!ctx.agenticAllowed) {
    return fail("agentic_account", "This account is not agent-tradable. New buys stay off.");
  }
  const symbol = ctx.symbol.trim().toUpperCase();
  if (!/^[A-Z]{1,5}$/.test(symbol)) {
    return fail("symbol", "Symbol must be 1 to 5 letters.");
  }
  if (!validExitPct(ctx.profitTargetPct) || !validExitPct(ctx.stopLossPct) || ctx.dailyLossPct < 0.1 || ctx.dailyLossPct > 5 || ctx.orderCap < 1 || ctx.orderCap > 1000) {
    return fail("settings", "Profit target and stop-loss must be positive percents no greater than 100. Daily loss stop or the order cap is outside its allowed range.");
  }
  const quote = ctx.quote;
  if (!quote || quote.symbol.toUpperCase() !== symbol || !quote.tradable || !(quote.ask > 0)) {
    return fail("quote", "No usable quote for this symbol.");
  }
  const held = ctx.held.find((position) => position.symbol.toUpperCase() === symbol && position.quantity > 0);
  const intent = ctx.intent ?? (held ? "add" : "starter");
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
  if (ctx.ordersToday >= ctx.orderCap) {
    return fail("order_cap", "The daily order cap is reached. New buys wait until tomorrow. Protective sells still run.");
  }
  if (ctx.audience === "live" && ctx.hasProvenBuyRule === false) {
    return fail("proven", "Live new buys stay idle until a buy rule is marked Proven.");
  }
  const positionNotional = held?.notional ?? 0;
  const room = remainingRoom({ balance: ctx.equity, positionNotional, buyingPower: ctx.buyingPower });
  if (session === "overnight" && quote.ask > room && intent === "starter") {
    return fail("cap", "This share price is above the 10% position cap, so it cannot be bought overnight (whole shares only).");
  }
  const sized = intent === "add"
    ? sizeAdd({ balance: ctx.equity, positionNotional, price: quote.ask, buyingPower: ctx.buyingPower, strength: ctx.addStrength ?? 0, now: ctx.now })
    : sizeStarter({ balance: ctx.equity, price: quote.ask, buyingPower: ctx.buyingPower, now: ctx.now });
  if ("error" in sized) {
    if (sized.error === "strength") return fail("cap", "Signals are not strong enough to add.");
    if (session !== "regular") return fail("cap", "A whole share costs more than the starter, the remaining room under the 10% cap, or available buying power.");
    return fail("cap", "This buy does not fit under the 10% position cap or available buying power. The app never borrows.");
  }
  const bundle = buildEntryBundle({
    accountNumber: "pending",
    symbol,
    ask: quote.ask,
    quantity: sized.quantity,
    stopLossPct: ctx.stopLossPct,
    profitTargetPct: ctx.profitTargetPct,
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
  const sizeReason = intent === "add" && "strength" in sized
    ? `Add sized at ${Math.round(Number(sized.strength) * 100)}% of remaining room under the 10% cap.`
    : "Starter buy of 20% of the max position (2% of account balance).";
  if (ctx.audience === "live" && ctx.mode === "view_only") {
    return { ok: false, code: "view_only", message: "View Only is on. The order was checked and not sent.", bundle, sizeReason };
  }
  return { ok: true, code: "ok", message: "Checked. Ready for the simulator.", bundle, sizeReason };
}

export interface ExitContext {
  now: Date;
  killed: boolean;
  quantity: number;
  bid: number;
  kind: "stop" | "target" | "manual" | "weakness";
  sessionOverride?: SessionName;
}

export function validateExit(ctx: ExitContext): { ok: boolean; code: string; message: string } {
  const session = ctx.sessionOverride ?? marketSession(ctx.now);
  if (session === "closed") return { ok: false, code: "session", message: "The market is closed. The exit waits for the next session." };
  if (!(ctx.quantity > 0) || !(ctx.bid > 0)) return { ok: false, code: "quote", message: "No position or quote to sell." };
  if (ctx.kind === "manual" && ctx.killed) {
    return { ok: true, code: "sell_all", message: "Sell All Positions is flattening this position in the simulator." };
  }
  return { ok: true, code: "ok", message: "Exit allowed. Stop-loss and target sells are not blocked by the Top 10, the order cap, or the daily loss stop. Sells have no dollar limit." };
}
