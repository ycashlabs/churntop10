import { roundMoney } from "../lib/money";

/** Percent of `balance` represented by `dollars`. Zero when the balance is not positive. */
export function capitalPercent(dollars: number, balance: number): number {
  if (!(balance > 0) || !Number.isFinite(dollars)) return 0;
  return (dollars / balance) * 100;
}

/** Slider thumb, clamped to 0–100 and rounded to the 1% step. */
export function sliderPercent(dollars: number, balance: number): number {
  const pct = capitalPercent(dollars, balance);
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/** Dollar amount for a slider percent of the current balance. */
export function dollarsFromSlider(percent: number, balance: number): number {
  if (!(balance > 0) || !Number.isFinite(percent)) return 0;
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  return roundMoney((balance * pct) / 100);
}
