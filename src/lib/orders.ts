import { sessionMarketHours, type SessionName } from "./clock.js";
import { shareString, moneyString, roundMoney } from "./money.js";

export interface EquityOrderArgs {
  account_number: string;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop_market" | "stop_limit";
  quantity?: string;
  dollar_amount?: string;
  limit_price?: string;
  stop_price?: string;
  time_in_force?: "gfd" | "gtc";
  market_hours?: "regular_hours" | "extended_hours" | "all_day_hours";
  ref_id?: string;
}

export interface EntryBundle {
  entry: EquityOrderArgs;
  stop: EquityOrderArgs;
  takeProfit: EquityOrderArgs;
  quantity: number;
  notional: number;
  stopPrice: number;
  targetPrice: number;
  stopKind: "broker" | "synthetic";
}

export function buildEntryBundle(input: {
  accountNumber: string;
  symbol: string;
  ask: number;
  quantity: number;
  stopLossPct: number;
  profitTargetPct?: number;
  profitTargetDollars?: number;
  refId: string;
  session?: SessionName;
  basis?: number;
}): EntryBundle {
  const session = input.session ?? "regular";
  const hours = sessionMarketHours(session) ?? "regular_hours";
  const stopKind: "broker" | "synthetic" = session === "regular" ? "broker" : "synthetic";
  const quantity = input.quantity;
  const notional = roundMoney(quantity * input.ask);
  const basis = input.basis ?? input.ask;
  const stopPrice = roundMoney(basis * (1 - input.stopLossPct / 100));
  const targetPrice = input.profitTargetPct !== undefined
    ? roundMoney(basis * (1 + input.profitTargetPct / 100))
    : roundMoney(basis + (quantity > 0 && input.profitTargetDollars ? input.profitTargetDollars / quantity : 0));
  const qty = shareString(quantity);
  const entry: EquityOrderArgs = {
    account_number: input.accountNumber,
    symbol: input.symbol,
    side: "buy",
    type: "limit",
    quantity: qty,
    limit_price: moneyString(input.ask),
    time_in_force: "gfd",
    market_hours: hours,
    ref_id: input.refId,
  };
  // Always the regular-hours broker form. Off-hours it is stored locally and attached at the open.
  const stop: EquityOrderArgs = {
    account_number: input.accountNumber,
    symbol: input.symbol,
    side: "sell",
    type: "stop_market",
    quantity: qty,
    stop_price: moneyString(stopPrice),
    time_in_force: "gtc",
    market_hours: "regular_hours",
    ref_id: `${input.refId}-stop`,
  };
  const takeProfit: EquityOrderArgs = {
    account_number: input.accountNumber,
    symbol: input.symbol,
    side: "sell",
    type: "limit",
    quantity: qty,
    limit_price: moneyString(Math.max(targetPrice, roundMoney(input.ask + 0.01))),
    time_in_force: "gtc",
    market_hours: hours,
    ref_id: `${input.refId}-target`,
  };
  return { entry, stop, takeProfit, quantity, notional, stopPrice, targetPrice: Number(takeProfit.limit_price), stopKind };
}

export function buildExitLimit(input: {
  accountNumber: string;
  symbol: string;
  quantity: number;
  limitPrice: number;
  marketHours: "extended_hours" | "all_day_hours";
  refId: string;
}): EquityOrderArgs {
  return {
    account_number: input.accountNumber,
    symbol: input.symbol,
    side: "sell",
    type: "limit",
    quantity: shareString(input.quantity),
    limit_price: moneyString(input.limitPrice),
    time_in_force: "gfd",
    market_hours: input.marketHours,
    ref_id: input.refId,
  };
}
