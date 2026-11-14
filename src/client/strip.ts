import type { PositionView, SimulatorView, Summary } from "../lib/api-types";
import { etDayStart } from "../lib/desk-stats";
import { parseUsd } from "./top10-table";

export type Book = "sim" | "live";

/** Five minutes, matching the cron cadence. This is not a holdings sync. */
export const STRIP_POLL_MS = 5 * 60 * 1000;

export function defaultStripBook(mode: "view_only" | "live"): Book {
  return mode === "live" ? "live" : "sim";
}

export function stripPollPath(book: Book): string {
  return book === "sim" ? "/api/simulator" : "/api/summary?read=1";
}

/** True only for the syncing summary route. The strip must never poll that. */
export function stripPollUsesSummarySync(path: string): boolean {
  const url = new URL(path, "https://desk.local");
  return url.pathname === "/api/summary" && url.searchParams.get("read") !== "1";
}

export interface PollTarget {
  visibilityState?: string;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export function startStripPoll(options: {
  book: () => Book;
  load: (path: string) => void;
  intervalMs?: number;
  target?: PollTarget;
  setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearIntervalFn?: (id: ReturnType<typeof setInterval>) => void;
}): () => void {
  const setTimer = options.setIntervalFn ?? setInterval;
  const clearTimer = options.clearIntervalFn ?? clearInterval;
  const tick = () => {
    const path = stripPollPath(options.book());
    if (stripPollUsesSummarySync(path)) return;
    options.load(path);
  };
  const timer = setTimer(tick, options.intervalMs ?? STRIP_POLL_MS);
  const target = options.target ?? (typeof document === "undefined" ? undefined : document);
  const onVis = () => {
    if (!target || target.visibilityState === "visible" || target.visibilityState === undefined) tick();
  };
  target?.addEventListener("visibilitychange", onVis);
  return () => {
    clearTimer(timer);
    target?.removeEventListener("visibilitychange", onVis);
  };
}

export interface StripTileModel {
  id: string;
  label: string;
  value: string;
  change: string;
  direction: "up" | "down" | "flat" | "muted";
  title: string;
  sample: number | null;
}

export interface StripModel {
  book: Book;
  maskedAccount: string | null;
  connected: boolean;
  tiles: StripTileModel[];
}

const NOT_CONNECTED = "Not connected. Connect from Settings. This screen shows only the real Robinhood account. Fake-money trading lives on the Simulator screen.";

export function formatSignedUsd(value: number): string {
  const abs = Math.abs(value).toLocaleString("en-US", { style: "currency", currency: "USD" });
  if (value > 0) return `+${abs}`;
  if (value < 0) return `−${abs}`;
  return abs;
}

export function formatSignedPct(value: number): string {
  const body = `${Math.abs(value).toFixed(2)}%`;
  if (value > 0) return `+${body}`;
  if (value < 0) return `−${body}`;
  return body;
}

export function formatRate(rate: number | null): string {
  if (rate == null) return "—";
  return `${Math.round(rate * 100)}%`;
}

function directionOf(value: number | null): "up" | "down" | "flat" | "muted" {
  if (value == null || value === 0) return value === 0 ? "flat" : "muted";
  return value > 0 ? "up" : "down";
}

function moneyLine(value: number | null, base: number | null): { text: string; direction: StripTileModel["direction"] } {
  if (value == null) return { text: "—", direction: "muted" };
  const pct = base != null && base !== 0 ? ` ${formatSignedPct((value / base) * 100)}` : "";
  return { text: `${formatSignedUsd(value)}${pct}`, direction: directionOf(value) };
}

interface PnlPoint {
  symbol: string;
  pnl: number;
}

export function bestAndWorst(points: PnlPoint[]): { best: PnlPoint | null; worst: PnlPoint | null } {
  const first = points[0];
  if (!first) return { best: null, worst: null };
  let best = first;
  let worst = first;
  for (const point of points) {
    if (point.pnl > best.pnl) best = point;
    if (point.pnl < worst.pnl) worst = point;
  }
  if (best.symbol === worst.symbol && best.pnl === worst.pnl) {
    if (best.pnl < 0) return { best: null, worst };
    return { best, worst: null };
  }
  return { best, worst };
}

export function countTradesSince(positions: PositionView[], sinceMs: number): number {
  let count = 0;
  for (const position of positions) {
    for (const trade of position.trades) if (trade.at >= sinceMs) count += 1;
  }
  return count;
}

export function sumOpenPnl(positions: PositionView[]): number {
  return positions.reduce((sum, position) => sum + (parseUsd(position.pnl) ?? 0), 0);
}

function positionPoints(positions: PositionView[]): PnlPoint[] {
  return positions.flatMap((position) => {
    const pnl = parseUsd(position.pnl);
    return pnl == null ? [] : [{ symbol: position.symbol, pnl }];
  });
}

function extremes(positions: PositionView[]): { best: StripTileModel; worst: StripTileModel } {
  const { best, worst } = bestAndWorst(positionPoints(positions));
  const title = "Open P&L versus average cost, not a since-midnight mark.";
  const line = (point: PnlPoint | null): StripTileModel => ({
    id: "",
    label: "",
    value: point ? `${point.symbol} ${formatSignedUsd(point.pnl)}` : "—",
    change: "—",
    direction: point ? directionOf(point.pnl) : "muted",
    title,
    sample: point ? point.pnl : null,
  });
  return { best: line(best), worst: line(worst) };
}

export function stripModelFromSimulator(sim: SimulatorView): StripModel {
  const equity = sim.desk?.equityValue ?? parseUsd(sim.equity);
  const dayStart = sim.desk?.dayStartEquity ?? null;
  const dayPnl = sim.desk?.dayPnl ?? (equity != null && dayStart != null ? equity - dayStart : null);
  const cash = parseUsd(sim.cash);
  const exposure = sim.tradingCapital?.exposure ?? null;
  const cap = sim.tradingCapital?.effective ?? null;
  const closed = sim.desk?.closedPnl ?? 0;
  const total = sumOpenPnl(sim.positions) + closed;
  const dayLine = moneyLine(dayPnl, dayStart);
  const ends = extremes(sim.positions);
  const winToday = sim.desk?.winRateToday ?? null;
  const win7 = sim.desk?.winRate7d ?? null;
  const winTitle = winToday == null && win7 == null ? "Not enough closed trades yet." : "Closed simulator trades. Today is the ET calendar day; 7d is that day plus the six before it.";
  return {
    book: "sim",
    maskedAccount: null,
    connected: true,
    tiles: [
      { id: "equity", label: "Account value", value: equity == null ? "—" : formatSignedUsd(equity).replace(/^\+/, ""), change: dayLine.text, direction: dayLine.direction, title: "Simulator equity. Subtitle Sim.", sample: equity },
      { id: "day", label: "Today's P/L", value: dayPnl == null ? "—" : formatSignedUsd(dayPnl), change: dayLine.text, direction: dayLine.direction, title: "Signed equity minus day-start equity.", sample: dayPnl },
      { id: "total", label: "Total P/L", value: formatSignedUsd(total), change: "—", direction: directionOf(total), title: "Open + closed (filtered by mode).", sample: total },
      { id: "cash", label: "Cash", value: cash == null ? "—" : formatSignedUsd(cash).replace(/^\+/, ""), change: "—", direction: "muted", title: "Simulator cash.", sample: cash },
      { id: "open", label: "Open positions", value: String(sim.positions.length), change: "—", direction: "muted", title: "Open simulator positions. Change is versus the first sample kept in this tab today.", sample: sim.positions.length },
      { id: "trades", label: "Today's trades", value: `${sim.ordersToday} / ${sim.orderCap}`, change: `cap ${sim.orderCap}`, direction: "muted", title: "Orders today, from the simulator.", sample: sim.ordersToday },
      { id: "win", label: "Win rate", value: `${formatRate(winToday)} / ${formatRate(win7)}`, change: "today / 7d", direction: "muted", title: winTitle, sample: winToday },
      { id: "deployed", label: "Deployed / cap", value: exposure == null || cap == null ? "—" : `${formatSignedUsd(exposure).replace(/^\+/, "")} / ${formatSignedUsd(cap).replace(/^\+/, "")}`, change: sim.tradingCapital?.paused ? "paused" : sim.tradingCapital?.warn ? "capped at the balance" : "—", direction: sim.tradingCapital?.paused ? "down" : "muted", title: sim.tradingCapital?.paused ? "Open exposure is at or above Trading capital. New buys wait until exposure is back under." : "Open exposure versus effective Trading capital.", sample: exposure },
      { ...ends.best, id: "best", label: "Best position" },
      { ...ends.worst, id: "worst", label: "Worst position" },
    ],
  };
}

export function stripModelFromSummary(summary: Summary, now = Date.now()): StripModel {
  const rh = summary.robinhood;
  const connected = summary.robinhoodStatus === "connected" && !!rh;
  const equity = connected ? parseUsd(rh?.totalValue) : null;
  const buyingPower = connected ? parseUsd(rh?.buyingPower) : null;
  const realized = connected ? parseUsd(rh?.todayPnl) : null;
  const positions = summary.positions ?? [];
  const closed = summary.desk?.closedPnl ?? 0;
  const total = connected || positions.length ? sumOpenPnl(positions) + closed : null;
  const exposure = summary.tradingCapital?.exposure ?? null;
  const cap = summary.tradingCapital?.effective ?? null;
  const tradesToday = countTradesSince(positions, etDayStart(new Date(now)));
  const ends = extremes(positions);
  const winToday = summary.desk?.winRateToday ?? null;
  const win7 = summary.desk?.winRate7d ?? null;
  const winTitle = winToday == null && win7 == null ? "Not enough closed trades yet." : "Closed live trades. Today is the ET calendar day; 7d is that day plus the six before it.";
  const offline = connected ? "" : summary.robinhoodStatus === "error" ? (summary.robinhoodError ?? "Robinhood could not be read.") : NOT_CONNECTED;
  return {
    book: "live",
    maskedAccount: connected ? (rh?.maskedAccount ?? null) : null,
    connected,
    tiles: [
      { id: "equity", label: "Account value", value: connected && equity != null ? formatSignedUsd(equity).replace(/^\+/, "") : "Not connected", change: "—", direction: "muted", title: connected ? "Live portfolio." : offline, sample: equity },
      { id: "day", label: "Today's P/L", value: realized == null ? "—" : formatSignedUsd(realized), change: connected ? "Today realized" : "—", direction: directionOf(realized), title: "Today realized (realized only).", sample: realized },
      { id: "total", label: "Total P/L", value: total == null ? "—" : formatSignedUsd(total), change: "—", direction: directionOf(total), title: "Open + closed (filtered by mode).", sample: total },
      { id: "cash", label: "Buying power", value: buyingPower == null ? "—" : formatSignedUsd(buyingPower).replace(/^\+/, ""), change: "—", direction: "muted", title: connected ? `Buying power. Cash ${rh?.cash ?? "—"}.` : offline, sample: buyingPower },
      { id: "open", label: "Open positions", value: String(positions.length), change: "—", direction: "muted", title: "Open live positions.", sample: positions.length },
      { id: "trades", label: "Today's trades", value: String(tradesToday), change: "open positions", direction: "muted", title: "Trades on open live positions since the ET day started. Closed positions are not in this count.", sample: tradesToday },
      { id: "win", label: "Win rate", value: `${formatRate(winToday)} / ${formatRate(win7)}`, change: "today / 7d", direction: "muted", title: winTitle, sample: winToday },
      { id: "deployed", label: "Deployed / cap", value: exposure == null || cap == null ? "—" : `${formatSignedUsd(exposure).replace(/^\+/, "")} / ${formatSignedUsd(cap).replace(/^\+/, "")}`, change: summary.tradingCapital?.paused ? "paused" : "—", direction: summary.tradingCapital?.paused ? "down" : "muted", title: "Open live exposure versus effective Trading capital.", sample: exposure },
      { ...ends.best, id: "best", label: "Best position" },
      { ...ends.worst, id: "worst", label: "Worst position" },
    ],
  };
}

const samples = new Map<string, { day: string; values: number[] }>();

export function resetStripSamples(): void {
  samples.clear();
}

export function rememberSample(key: string, value: number | null, etDate: string): number[] {
  if (!etDate) return [];
  const current = samples.get(key);
  if (value == null || !Number.isFinite(value)) return current && current.day === etDate ? current.values : [];
  if (!current || current.day !== etDate) {
    const next = { day: etDate, values: [value] };
    samples.set(key, next);
    return next.values;
  }
  if (current.values[current.values.length - 1] !== value) current.values.push(value);
  return current.values;
}

export function etDateFromClock(clock: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(clock.trim());
  return match?.[1] ?? "";
}
