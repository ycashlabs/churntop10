import { sessionMarketHours, type SessionName } from "./clock.js";
import { moneyString, roundMoney, shareString } from "./money.js";
import type { EquityOrderArgs } from "./orders.js";

/** Skip a new buy when the quoted spread is wider than this fraction of mid. */
export const MAX_SPREAD = 0.01;
/** Live quotes older than this are too stale to enter on. */
export const QUOTE_STALE_MS = 5 * 60 * 1000;
const OFFSET_FLOOR = 0.02;
const OFFSET_PCT = 0.0005;

export function spreadRatio(bid: number, ask: number): number | undefined {
  if (!(bid > 0) || !(ask > 0) || ask < bid) return undefined;
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) return undefined;
  return (ask - bid) / mid;
}

export function quoteIsStale(asOf: string | undefined, now: Date, source: "recorded" | "robinhood"): boolean {
  if (source !== "robinhood") return false;
  if (!asOf) return true;
  const at = Date.parse(asOf);
  if (!Number.isFinite(at)) return true;
  return now.getTime() - at > QUOTE_STALE_MS;
}

export function marketableSellLimit(bid: number, last: number): number {
  const offset = Math.max(OFFSET_FLOOR, roundMoney(last * OFFSET_PCT));
  return roundMoney(Math.max(0.01, bid - offset));
}

export function buildMarketableStopSell(input: {
  accountNumber: string;
  symbol: string;
  quantity: number;
  bid: number;
  last: number;
  session: SessionName;
  refId: string;
}): EquityOrderArgs | undefined {
  const hours = sessionMarketHours(input.session);
  if (!hours || !(input.quantity > 0) || !(input.bid > 0)) return undefined;
  return {
    account_number: input.accountNumber,
    symbol: input.symbol,
    side: "sell",
    type: "limit",
    quantity: shareString(input.quantity),
    limit_price: moneyString(marketableSellLimit(input.bid, input.last)),
    time_in_force: "gfd",
    market_hours: hours,
    ref_id: input.refId,
  };
}

export type ExitAction =
  | { type: "attach_broker_stop" }
  | { type: "fire_synthetic"; limitPrice: number }
  | { type: "fill_stop_exit"; price: number }
  | { type: "reprice_stop_exit"; limitPrice: number }
  | { type: "fill_broker_stop"; price: number }
  | { type: "fill_target"; price: number }
  | { type: "wait" };

export interface ExitBook {
  session: SessionName;
  last: number;
  bid: number;
  hasBid: boolean;
  stopPrice?: number;
  stopKind?: "broker" | "synthetic";
  stopExitLimit?: number;
  targetPrice?: number;
  quantity: number;
}

export function nextExitAction(book: ExitBook): ExitAction {
  if (book.session === "closed" || !(book.quantity > 0)) return { type: "wait" };
  if (book.stopExitLimit !== undefined) {
    if (book.hasBid && book.stopExitLimit <= book.bid) return { type: "fill_stop_exit", price: book.stopExitLimit };
    if (book.hasBid) {
      const next = marketableSellLimit(book.bid, book.last);
      if (next < book.stopExitLimit) return { type: "reprice_stop_exit", limitPrice: next };
    }
    return { type: "wait" };
  }
  if (book.session === "regular" && book.stopKind === "synthetic" && book.stopPrice !== undefined) {
    return { type: "attach_broker_stop" };
  }
  if (book.stopKind === "broker" && book.stopPrice !== undefined && book.last <= book.stopPrice) {
    if (!book.hasBid) return { type: "wait" };
    return { type: "fill_broker_stop", price: book.bid };
  }
  if (book.stopKind === "synthetic" && book.stopPrice !== undefined && book.last <= book.stopPrice) {
    if (!book.hasBid) return { type: "wait" };
    return { type: "fire_synthetic", limitPrice: marketableSellLimit(book.bid, book.last) };
  }
  if (book.targetPrice !== undefined && book.last >= book.targetPrice) {
    return { type: "fill_target", price: book.targetPrice };
  }
  return { type: "wait" };
}
