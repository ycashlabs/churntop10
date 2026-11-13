export type SessionName = "regular" | "extended" | "overnight" | "closed";

export interface EtParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string;
  date: string;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function etParts(now: Date): EtParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const bag: Record<string, string> = {};
  for (const part of fmt.formatToParts(now)) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  const year = Number(bag.year);
  const month = Number(bag.month);
  const day = Number(bag.day);
  return {
    year,
    month,
    day,
    hour: Number(bag.hour),
    minute: Number(bag.minute),
    weekday: bag.weekday ?? "",
    date: `${year.toString().padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

/** Minutes from Sunday 00:00 ET. */
function weekMinutes(parts: EtParts): number {
  const dow = WEEKDAYS.indexOf(parts.weekday);
  return dow * 24 * 60 + parts.hour * 60 + parts.minute;
}

/**
 * Regular 09:30–16:00 ET weekdays.
 * Extended 07:00–09:30 and 16:00–20:00 ET weekdays.
 * 24 Hour Market is Sunday 20:00 ET through Friday 20:00 ET outside those windows.
 * Friday 20:00 through Sunday 20:00 is closed. Exchange holidays are not modeled.
 */
export function marketSession(now: Date): SessionName {
  const parts = etParts(now);
  const mins = weekMinutes(parts);
  const sun8pm = 0 * 24 * 60 + 20 * 60;
  const fri8pm = 5 * 24 * 60 + 20 * 60;
  if (mins < sun8pm || mins >= fri8pm) return "closed";
  const dow = WEEKDAYS.indexOf(parts.weekday);
  if (dow >= 1 && dow <= 5) {
    const hm = parts.hour * 60 + parts.minute;
    if (hm >= 9 * 60 + 30 && hm < 16 * 60) return "regular";
    if ((hm >= 7 * 60 && hm < 9 * 60 + 30) || (hm >= 16 * 60 && hm < 20 * 60)) return "extended";
  }
  return "overnight";
}

export function sessionMarketHours(session: SessionName): "regular_hours" | "extended_hours" | "all_day_hours" | null {
  if (session === "regular") return "regular_hours";
  if (session === "extended") return "extended_hours";
  if (session === "overnight") return "all_day_hours";
  return null;
}

/** Business days strictly before `day` (YYYY-MM-DD), walking back across weekends. */
export function recentBusinessDays(day: string, count: number): string[] {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return [];
  const cursor = new Date(Date.UTC(year, month - 1, date));
  const out: string[] = [];
  while (out.length < count) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      out.push(cursor.toISOString().slice(0, 10));
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return out;
}

export function businessDaysAgo(day: string, days: number): string {
  const found = recentBusinessDays(day, days + 1);
  return found[days] ?? day;
}

export const SESSION_HELP = "Buys run 24/5, Sunday 8:00 PM through Friday 8:00 PM ET. Outside regular hours, entries and exits are limit orders only. The app watches the stop-loss every 5 minutes and sends a limit sell if the price is at or below the stop. That is not a resting broker stop, so a move between checks can go through the stop before a sell is sent.";
