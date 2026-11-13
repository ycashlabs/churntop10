export interface Bar {
  ts: number;
  price: number;
  volume: number;
}

export function barsInWindow(bars: Bar[], now: Date, minutes: number): Bar[] {
  const start = now.getTime() - minutes * 60_000;
  return bars.filter((bar) => bar.ts > start && bar.ts <= now.getTime()).sort((a, b) => a.ts - b.ts);
}

export function averagePrice(bars: Bar[]): number | undefined {
  if (bars.length === 0) return undefined;
  return bars.reduce((sum, bar) => sum + bar.price, 0) / bars.length;
}

export function lowPrice(bars: Bar[]): number | undefined {
  if (bars.length === 0) return undefined;
  return Math.min(...bars.map((bar) => bar.price));
}

export function averageVolume(bars: Bar[]): number | undefined {
  if (bars.length === 0) return undefined;
  return bars.reduce((sum, bar) => sum + bar.volume, 0) / bars.length;
}

export type BarStyle = "strength" | "weakness" | "dip" | "flat";

/**
 * Build 20 one-minute bars ending at `now`, plus a current print, so signal tests and the
 * recorded-quote simulator have a 20-minute window to read.
 */
export function synthesizeBars(input: { last: number; now: Date; style: BarStyle; volume?: number }): Bar[] {
  const volume = input.volume ?? 10_000;
  const bars: Bar[] = [];
  for (let i = 20; i >= 1; i -= 1) {
    const ts = input.now.getTime() - i * 60_000;
    const t = (20 - i) / 20;
    let price = input.last;
    let vol = volume;
    if (input.style === "strength") {
      price = input.last * (0.994 + t * 0.005);
      vol = volume * 0.85;
    } else if (input.style === "weakness") {
      price = input.last * (1.006 - t * 0.007);
      vol = volume * (0.8 + t * 0.5);
    } else if (input.style === "dip") {
      price = input.last * (0.997 + Math.sin(t * Math.PI) * 0.001);
      vol = volume * 0.9;
    }
    bars.push({ ts, price: Math.round(price * 100) / 100, volume: Math.round(vol) });
  }
  bars.push({ ts: input.now.getTime(), price: input.last, volume: input.style === "weakness" || input.style === "strength" ? Math.round(volume * 1.2) : volume });
  return bars;
}
