export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function roundShares(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function parseAmount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function formatUsd(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function formatShares(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

export function moneyString(value: number): string {
  return roundMoney(value).toFixed(2);
}

export function shareString(value: number): string {
  const rounded = roundShares(value);
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}
