import { etParts } from "./clock.js";
import { roundMoney } from "./money.js";

const TZ = "America/New_York";

function zoneOffset(date: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const bag: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  let hour = Number(bag.hour);
  let day = Number(bag.day);
  if (hour === 24) {
    hour = 0;
    day += 1;
  }
  const asUtc = Date.UTC(Number(bag.year), Number(bag.month) - 1, day, hour, Number(bag.minute), Number(bag.second));
  return asUtc - date.getTime();
}

/** UTC millis of midnight at the start of the ET calendar day that contains `now`. */
export function etDayStart(now: Date): number {
  const parts = etParts(now);
  const wallMidnightUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);
  let utc = wallMidnightUtc;
  for (let i = 0; i < 3; i++) utc = wallMidnightUtc - zoneOffset(new Date(utc));
  return utc;
}

export function signedDayPnl(equity: number, dayStartEquity: number): number {
  return roundMoney(equity - dayStartEquity);
}

export interface ClosedPnlRow {
  pnl: number;
  closedAt: number | null;
  exitType?: string;
}

function closedInWindow(rows: ClosedPnlRow[], from: number, to: number): ClosedPnlRow[] {
  return rows.filter((row) => row.closedAt != null && row.closedAt >= from && row.closedAt <= to);
}

export function windowWinRate(rows: ClosedPnlRow[], from: number, to: number): { rate: number | null; count: number } {
  const window = closedInWindow(rows, from, to);
  if (window.length === 0) return { rate: null, count: 0 };
  const wins = window.filter((row) => row.pnl > 0).length;
  return { rate: wins / window.length, count: window.length };
}

/** Sum of closed-trade P&L. Open imports (no closedAt) stay out. */
export function closedPnlSum(rows: ClosedPnlRow[]): number {
  return roundMoney(rows.filter((row) => row.closedAt != null).reduce((sum, row) => sum + row.pnl, 0));
}
