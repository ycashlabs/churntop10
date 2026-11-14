import { etParts, marketSession } from "../lib/clock";

export const ET_ZONE = "America/New_York";

export type TimelineSessionId = "overnight" | "pre" | "regular" | "after" | "closed";

export interface TimelineSpan {
  id: TimelineSessionId;
  label: string;
  /** Minutes from local midnight, clipped to the viewer's local day. */
  startMin: number;
  endMin: number;
  startLabel: string;
  endLabel: string;
  current: boolean;
}

export interface TimelineTick {
  min: number;
  label: string;
}

export interface SessionTimelineModel {
  timeZone: string;
  timeZoneName: string;
  dayMinutes: number;
  nowMin: number;
  spans: TimelineSpan[];
  ticks: TimelineTick[];
}

const LABELS: Record<TimelineSessionId, string> = {
  overnight: "Overnight",
  pre: "Pre-market",
  regular: "Regular",
  after: "After-hours",
  closed: "Closed",
};

interface Civil {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function viewerTimeZone(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function zonedParts(date: Date, timeZone: string): Civil {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
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
  const hour = Number(bag.hour);
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: hour === 24 ? 0 : hour,
    minute: Number(bag.minute),
    second: Number(bag.second),
  };
}

/** Minutes to add to UTC to reach this zone's wall clock at `date`. */
export function zoneOffsetMinutes(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/**
 * UTC instant for a wall-clock time in `timeZone`.
 * A spring-forward gap resolves to the later offset. A fall-back fold uses the offset
 * of the corrected instant, which is stable for the session boundaries (none fall in the 2 AM hour).
 */
export function zonedWallTime(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const first = zoneOffsetMinutes(guess, timeZone);
  let utc = new Date(guess.getTime() - first * 60_000);
  const second = zoneOffsetMinutes(utc, timeZone);
  if (second !== first) utc = new Date(guess.getTime() - second * 60_000);
  return utc;
}

export function timeZoneAbbreviation(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" }).formatToParts(date);
  return parts.find((part) => part.type === "timeZoneName")?.value ?? timeZone;
}

function addCivilDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

function weekdayIndex(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function formatClock(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(date);
}

function hourTickLabel(hour: number): string {
  if (hour === 0) return "12a";
  if (hour === 12) return "12p";
  if (hour < 12) return `${hour}a`;
  return `${hour - 12}p`;
}

interface RawSpan {
  id: TimelineSessionId;
  start: Date;
  end: Date;
}

/** ET session pieces for one civil ET date. Display only; `marketSession` is unchanged. */
function etIntervals(year: number, month: number, day: number): RawSpan[] {
  const dow = weekdayIndex(year, month, day);
  const at = (hour: number, minute: number) => zonedWallTime(year, month, day, hour, minute, ET_ZONE);
  const next = addCivilDays(year, month, day, 1);
  const midnightNext = zonedWallTime(next.year, next.month, next.day, 0, 0, ET_ZONE);
  const spans: RawSpan[] = [];
  if (dow >= 1 && dow <= 5) {
    spans.push({ id: "overnight", start: at(0, 0), end: at(7, 0) });
    spans.push({ id: "pre", start: at(7, 0), end: at(9, 30) });
    spans.push({ id: "regular", start: at(9, 30), end: at(16, 0) });
    spans.push({ id: "after", start: at(16, 0), end: at(20, 0) });
  }
  if (dow >= 1 && dow <= 4) spans.push({ id: "overnight", start: at(20, 0), end: midnightNext });
  if (dow === 0) {
    spans.push({ id: "closed", start: at(0, 0), end: at(20, 0) });
    spans.push({ id: "overnight", start: at(20, 0), end: midnightNext });
  }
  if (dow === 5) spans.push({ id: "closed", start: at(20, 0), end: midnightNext });
  if (dow === 6) spans.push({ id: "closed", start: at(0, 0), end: midnightNext });
  return spans;
}

/** Which drawn bar is current. Extended hours split into pre-market and after-hours for display. */
export function displaySessionId(now: Date): TimelineSessionId {
  const session = marketSession(now);
  if (session === "regular" || session === "overnight" || session === "closed") return session;
  const parts = etParts(now);
  return parts.hour * 60 + parts.minute < 12 * 60 ? "pre" : "after";
}

export function sessionTimeline(now: Date, timeZone = viewerTimeZone()): SessionTimelineModel {
  const local = zonedParts(now, timeZone);
  const start = zonedWallTime(local.year, local.month, local.day, 0, 0, timeZone);
  const next = addCivilDays(local.year, local.month, local.day, 1);
  const end = zonedWallTime(next.year, next.month, next.day, 0, 0, timeZone);
  const dayMinutes = Math.max(1, (end.getTime() - start.getTime()) / 60_000);
  const nowMin = Math.min(dayMinutes, Math.max(0, (now.getTime() - start.getTime()) / 60_000));

  const etOfStart = zonedParts(start, ET_ZONE);
  const etOfEnd = zonedParts(new Date(end.getTime() - 1), ET_ZONE);
  const dates = [
    addCivilDays(etOfStart.year, etOfStart.month, etOfStart.day, -1),
    { year: etOfStart.year, month: etOfStart.month, day: etOfStart.day },
    addCivilDays(etOfStart.year, etOfStart.month, etOfStart.day, 1),
    { year: etOfEnd.year, month: etOfEnd.month, day: etOfEnd.day },
  ];
  const seen = new Set<string>();
  const raw: RawSpan[] = [];
  for (const date of dates) {
    const key = `${date.year}-${date.month}-${date.day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    raw.push(...etIntervals(date.year, date.month, date.day));
  }

  const spans: TimelineSpan[] = [];
  for (const span of raw) {
    const from = Math.max(span.start.getTime(), start.getTime());
    const to = Math.min(span.end.getTime(), end.getTime());
    if (to - from < 30_000) continue;
    spans.push({
      id: span.id,
      label: LABELS[span.id],
      startMin: (from - start.getTime()) / 60_000,
      endMin: (to - start.getTime()) / 60_000,
      startLabel: formatClock(new Date(from), timeZone),
      endLabel: formatClock(new Date(to), timeZone),
      current: now.getTime() >= span.start.getTime() && now.getTime() < span.end.getTime(),
    });
  }
  spans.sort((left, right) => left.startMin - right.startMin || left.label.localeCompare(right.label));
  const merged: TimelineSpan[] = [];
  for (const span of spans) {
    const prev = merged[merged.length - 1];
    if (prev && prev.id === span.id && span.startMin - prev.endMin < 1) {
      prev.endMin = span.endMin;
      prev.endLabel = span.endLabel;
      prev.current = prev.current || span.current;
      continue;
    }
    merged.push({ ...span });
  }
  spans.length = 0;
  spans.push(...merged);

  const ticks: TimelineTick[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const instant = zonedWallTime(local.year, local.month, local.day, hour, 0, timeZone);
    const parts = zonedParts(instant, timeZone);
    if (parts.hour !== hour || parts.day !== local.day || parts.month !== local.month) continue;
    const min = (instant.getTime() - start.getTime()) / 60_000;
    if (min < -0.5 || min > dayMinutes + 0.5) continue;
    ticks.push({ min, label: hourTickLabel(hour) });
  }

  return {
    timeZone,
    timeZoneName: timeZoneAbbreviation(now, timeZone),
    dayMinutes,
    nowMin,
    spans,
    ticks,
  };
}
