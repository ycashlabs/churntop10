import { marketSession, type SessionName } from "./clock.js";
import { roundMoney, roundShares } from "./money.js";

/** One symbol may not exceed this share of total account balance. */
export const POSITION_CAP_PCT = 10;
/** A new position starts at this share of the max position (2% of balance). */
export const STARTER_PCT_OF_MAX = 20;

export function maxPositionNotional(balance: number): number {
  return roundMoney(Math.max(0, balance) * (POSITION_CAP_PCT / 100));
}

export function starterNotional(balance: number): number {
  return roundMoney(maxPositionNotional(balance) * (STARTER_PCT_OF_MAX / 100));
}

export function remainingRoom(input: { balance: number; positionNotional: number; buyingPower: number }): number {
  const cap = maxPositionNotional(input.balance);
  return roundMoney(Math.max(0, Math.min(cap - input.positionNotional, input.buyingPower)));
}

export function allowsFractional(session: SessionName): boolean {
  return session === "regular";
}

/**
 * Convert a dollar amount into a share quantity for the current session.
 * Regular hours allow fractions. Overnight and extended hours are whole shares only.
 */
export function quantityForNotional(input: { notional: number; price: number; session: SessionName; buyingPower: number }): { quantity: number; notional: number } | { error: "cap" | "price" } {
  if (!(input.price > 0) || !(input.notional > 0)) return { error: "price" };
  const room = Math.min(input.notional, input.buyingPower);
  if (room <= 0) return { error: "cap" };
  if (allowsFractional(input.session)) {
    const quantity = roundShares(room / input.price);
    if (quantity <= 0) return { error: "cap" };
    const notional = roundMoney(quantity * input.price);
    if (notional > input.buyingPower + 0.001) return { error: "cap" };
    return { quantity, notional };
  }
  const quantity = Math.floor(room / input.price + 1e-9);
  if (quantity < 1) return { error: "cap" };
  return { quantity, notional: roundMoney(quantity * input.price) };
}

export function sizeStarter(input: { balance: number; price: number; buyingPower: number; now: Date }): { quantity: number; notional: number } | { error: "cap" | "price" } {
  return quantityForNotional({
    notional: Math.min(starterNotional(input.balance), remainingRoom({ balance: input.balance, positionNotional: 0, buyingPower: input.buyingPower })),
    price: input.price,
    session: marketSession(input.now),
    buyingPower: input.buyingPower,
  });
}

/**
 * Size an add from signal strength in [0, 1]. Strength 0 means no add.
 * Stronger signals take more of the remaining room under the 10% cap, never more than buying power.
 */
export function sizeAdd(input: {
  balance: number;
  positionNotional: number;
  price: number;
  buyingPower: number;
  strength: number;
  now: Date;
}): { quantity: number; notional: number; strength: number } | { error: "cap" | "price" | "strength" } {
  if (!(input.strength > 0)) return { error: "strength" };
  const strength = Math.min(1, input.strength);
  const room = remainingRoom({ balance: input.balance, positionNotional: input.positionNotional, buyingPower: input.buyingPower });
  const sized = quantityForNotional({
    notional: roundMoney(room * strength),
    price: input.price,
    session: marketSession(input.now),
    buyingPower: input.buyingPower,
  });
  if ("error" in sized) return sized;
  return { ...sized, strength };
}
