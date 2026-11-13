import { averagePrice, averageVolume, barsInWindow, lowPrice, type Bar } from "./bars.js";

export interface SignalContext {
  symbol: string;
  last: number;
  volume: number;
  now: Date;
  bars: Bar[];
  spyBars: Bar[];
  spyLast?: number;
  spyPreviousClose?: number;
  averageCost?: number;
}

export interface SignalResult {
  id: string;
  name: string;
  fired: boolean;
  value: number | null;
  /** Decision cutoff in the same units as `value`. Null when the signal could not be computed. */
  threshold?: number | null;
  reason: string;
}

export interface SignalType {
  id: string;
  name: string;
  compute: (ctx: SignalContext) => SignalResult;
}

const registry = new Map<string, SignalType>();

export function registerSignal(signal: SignalType): void {
  registry.set(signal.id, signal);
}

export function listSignalTypes(): SignalType[] {
  return [...registry.values()];
}

export function getSignal(id: string): SignalType | undefined {
  return registry.get(id);
}

export function computeSignals(ids: string[], ctx: SignalContext): SignalResult[] {
  return ids.map((id) => {
    const signal = registry.get(id);
    if (!signal) return { id, name: id, fired: false, value: null, threshold: null, reason: "This signal type is not implemented yet." };
    return signal.compute(ctx);
  });
}

/** 0–1 strength from how many of the required signals fired, plus a small boost from their values when present. */
export function signalStrength(results: SignalResult[]): number {
  if (results.length === 0) return 0;
  const fired = results.filter((item) => item.fired);
  if (fired.length === 0) return 0;
  return Math.min(1, fired.length / results.length);
}

/** Empty list (settings-only rules) is allowed; otherwise every required signal must have fired. */
export function allRequiredSignalsFired(results: SignalResult[]): boolean {
  return results.length === 0 || results.every((item) => item.fired);
}

function result(id: string, name: string, fired: boolean, value: number | null, reason: string, threshold: number | null = null): SignalResult {
  return { id, name, fired, value, threshold, reason };
}

function window20(ctx: SignalContext): Bar[] {
  return barsInWindow(ctx.bars, ctx.now, 20);
}

registerSignal({
  id: "price_above_20m_avg",
  name: "Price above 20-minute average",
  compute(ctx) {
    const avg = averagePrice(window20(ctx));
    if (avg === undefined) return result("price_above_20m_avg", "Price above 20-minute average", false, null, "Not enough 20-minute price history.");
    const fired = ctx.last > avg;
    return result("price_above_20m_avg", "Price above 20-minute average", fired, round4(ctx.last - avg), fired ? `Last ${ctx.last} is above the 20-minute average ${round4(avg)}.` : `Last ${ctx.last} is not above the 20-minute average ${round4(avg)}.`, 0);
  },
});

registerSignal({
  id: "volume_above_recent",
  name: "Volume above recent normal",
  compute(ctx) {
    const avg = averageVolume(window20(ctx));
    if (avg === undefined || avg <= 0) return result("volume_above_recent", "Volume above recent normal", false, null, "Not enough 20-minute volume history.");
    const fired = ctx.volume > avg;
    return result("volume_above_recent", "Volume above recent normal", fired, round4(ctx.volume / avg), fired ? `Volume ${ctx.volume} is above recent normal ${round4(avg)}.` : `Volume ${ctx.volume} is not above recent normal ${round4(avg)}.`, 1);
  },
});

registerSignal({
  id: "spy_up",
  name: "SPY is up",
  compute(ctx) {
    const change = spyDayChange(ctx);
    if (change === undefined) return result("spy_up", "SPY is up", false, null, "No SPY day change is available.");
    const fired = change > 0;
    return result("spy_up", "SPY is up", fired, change, fired ? `SPY is up ${change}%.` : `SPY is not up (${change}%).`, 0);
  },
});

registerSignal({
  id: "spy_falling",
  name: "SPY is falling",
  compute(ctx) {
    const change = spyDayChange(ctx);
    if (change === undefined) return result("spy_falling", "SPY is falling", false, null, "No SPY day change is available.");
    const fired = change < 0;
    return result("spy_falling", "SPY is falling", fired, change, fired ? `SPY is down ${change}%.` : `SPY is not falling (${change}%).`, 0);
  },
});

registerSignal({
  id: "spy_not_falling_hard",
  name: "SPY is not falling hard",
  compute(ctx) {
    const change = spyDayChange(ctx);
    if (change === undefined) return result("spy_not_falling_hard", "SPY is not falling hard", false, null, "No SPY day change is available.");
    const fired = change > -0.5;
    return result("spy_not_falling_hard", "SPY is not falling hard", fired, change, fired ? `SPY day change is ${change}%, not a hard fall.` : `SPY is falling hard (${change}%).`, -0.5);
  },
});

registerSignal({
  id: "below_avg_cost",
  name: "Price below average cost",
  compute(ctx) {
    if (!(ctx.averageCost && ctx.averageCost > 0)) return result("below_avg_cost", "Price below average cost", false, null, "No average cost for this position.");
    const fired = ctx.last < ctx.averageCost;
    return result("below_avg_cost", "Price below average cost", fired, round4(ctx.last - ctx.averageCost), fired ? `Last ${ctx.last} is below average cost ${ctx.averageCost}.` : `Last ${ctx.last} is not below average cost ${ctx.averageCost}.`, 0);
  },
});

registerSignal({
  id: "above_20m_low",
  name: "Price above the 20-minute low",
  compute(ctx) {
    const low = lowPrice(window20(ctx));
    if (low === undefined) return result("above_20m_low", "Price above the 20-minute low", false, null, "Not enough 20-minute price history.");
    const fired = ctx.last > low;
    return result("above_20m_low", "Price above the 20-minute low", fired, round4(ctx.last - low), fired ? `Last ${ctx.last} is above the 20-minute low ${low}.` : `Last ${ctx.last} is not above the 20-minute low ${low}.`, 0);
  },
});

registerSignal({
  id: "no_sell_volume_spike",
  name: "No volume spike on the selling",
  compute(ctx) {
    const avg = averageVolume(window20(ctx));
    if (avg === undefined || avg <= 0) return result("no_sell_volume_spike", "No volume spike on the selling", false, null, "Not enough 20-minute volume history.");
    const fired = ctx.volume <= avg * 1.5;
    return result("no_sell_volume_spike", "No volume spike on the selling", fired, round4(ctx.volume / avg), fired ? "Volume is not spiking on this dip." : "Volume is spiking on the selling.", 1.5);
  },
});

registerSignal({
  id: "below_20m_avg",
  name: "Price below 20-minute average",
  compute(ctx) {
    const avg = averagePrice(window20(ctx));
    if (avg === undefined) return result("below_20m_avg", "Price below 20-minute average", false, null, "Not enough 20-minute price history.");
    const fired = ctx.last < avg;
    return result("below_20m_avg", "Price below 20-minute average", fired, round4(ctx.last - avg), fired ? `Last ${ctx.last} is below the 20-minute average ${round4(avg)}.` : `Last ${ctx.last} is not below the 20-minute average ${round4(avg)}.`, 0);
  },
});

registerSignal({
  id: "rising_volume",
  name: "Rising volume",
  compute(ctx) {
    const window = window20(ctx);
    if (window.length < 2) return result("rising_volume", "Rising volume", false, null, "Not enough 20-minute volume history.");
    const first = averageVolume(window.slice(0, Math.max(1, Math.floor(window.length / 2))));
    const last = averageVolume(window.slice(Math.floor(window.length / 2)));
    if (first === undefined || last === undefined || first <= 0) return result("rising_volume", "Rising volume", false, null, "Not enough 20-minute volume history.");
    const fired = last > first;
    return result("rising_volume", "Rising volume", fired, round4(last / first), fired ? "Volume is rising in the 20-minute window." : "Volume is not rising.", 1);
  },
});

function spyDayChange(ctx: SignalContext): number | undefined {
  if (ctx.spyLast !== undefined && ctx.spyPreviousClose && ctx.spyPreviousClose > 0) {
    return round4(((ctx.spyLast - ctx.spyPreviousClose) / ctx.spyPreviousClose) * 100);
  }
  const spy = barsInWindow(ctx.spyBars, ctx.now, 24 * 60);
  const firstBar = spy[0];
  const lastBar = spy[spy.length - 1];
  if (!firstBar || !lastBar) return undefined;
  const first = firstBar.price;
  const last = ctx.spyLast ?? lastBar.price;
  if (!(first > 0)) return undefined;
  return round4(((last - first) / first) * 100);
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export const FIRST_BUY_SIGNALS = ["price_above_20m_avg", "volume_above_recent", "spy_up"];
export const ADD_STRENGTH_SIGNALS = ["price_above_20m_avg", "volume_above_recent", "spy_up"];
export const ADD_DIP_SIGNALS = ["below_avg_cost", "above_20m_low", "no_sell_volume_spike", "spy_not_falling_hard"];
export const EXIT_WEAKNESS_SIGNALS = ["below_20m_avg", "rising_volume", "spy_falling"];


export interface SignalCatalogEntry {
  id: string;
  name: string;
  description: string;
  status: "candidate" | "active" | "retired";
}

/** Built-in signals seeded as active in the signals table. */
export function signalCatalog(): SignalCatalogEntry[] {
  return listSignalTypes().map((signal) => ({
    id: signal.id,
    name: signal.name,
    description: signal.name,
    status: "active" as const,
  }));
}
