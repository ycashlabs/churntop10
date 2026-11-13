import { roundMoney } from "./money.js";
import { maxPositionNotional } from "./sizing.js";

/** A saved Trading capital figure: a positive dollar amount, not an absurd typo. */
export function validTradingCapital(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= 1_000_000_000;
}

/**
 * Quick-fill steps are 10% through 100% of the current balance.
 * The saved value is always the dollar figure, not the percent.
 */
export function tradingCapitalPresets(balance: number): Array<{ pct: number; dollars: number }> {
  const base = Math.max(0, balance);
  return [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((pct) => ({
    pct,
    dollars: roundMoney(base * (pct / 100)),
  }));
}

/**
 * If the saved Trading capital is above the real balance, warn and use the min
 * for new trades. A missing or zero setting falls back to the current balance.
 */
export function effectiveTradingCapital(tradingCapital: number, balance: number): { capital: number; warn: boolean } {
  const bal = Math.max(0, balance);
  if (!validTradingCapital(tradingCapital)) return { capital: bal, warn: false };
  if (tradingCapital > bal && bal > 0) return { capital: bal, warn: true };
  return { capital: tradingCapital, warn: false };
}

export function positionCapFromSnapshot(snapshot: number): number {
  return maxPositionNotional(snapshot);
}

export function openExposure(positions: Array<{ qty: number; last?: number; avgCost: number }>): number {
  return roundMoney(positions.reduce((sum, position) => sum + position.qty * (position.last ?? position.avgCost), 0));
}

/** New buys pause when current exposure is already at or above the current Trading capital. */
export function exposureBlocksNewBuy(capital: number, exposure: number, buyNotional: number): boolean {
  return roundMoney(exposure + buyNotional) > capital + 0.001;
}
