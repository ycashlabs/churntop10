import type { CompanyProfile, PositionView, SimulatorView, Summary } from "../lib/api-types";
import { displaySecText } from "../lib/sec-credit";

export interface TopRow {
  rank: number;
  symbol: string;
  bid: string;
  ask: string;
  last: string;
  lastNum: number | null;
  bidNum: number | null;
  askNum: number | null;
  change: number | null;
  changePct: number | null;
  position: string;
  positionTitle: string;
  pnl: number | null;
  target: number | null;
  stop: number | null;
  targetTitle: string;
  stopTitle: string;
  rule: string;
  check: string;
  checkTitle: string;
  company: CompanyProfile | null;
  name: string;
  sector: string;
  industry: string;
}

export function parseUsd(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "—" || /^unavailable$/i.test(trimmed)) return null;
  const negative = trimmed.startsWith("-") || trimmed.startsWith("−") || /^\(.*\)$/.test(trimmed);
  const digits = trimmed.replace(/[^0-9.]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

export function exitDistances(last: number, avg: number, targetPct: number, stopPct: number): { target: number; stop: number; targetPrice: number; stopPrice: number } | null {
  if (!(last > 0) || !(avg > 0)) return null;
  const targetPrice = avg * (1 + targetPct / 100);
  const stopPrice = avg * (1 - stopPct / 100);
  return {
    target: ((targetPrice - last) / last) * 100,
    stop: ((stopPrice - last) / last) * 100,
    targetPrice,
    stopPrice,
  };
}

function positionLine(position: PositionView): string {
  const book = position.mode === "live" ? "Live" : "Sim";
  return `${position.quantity} @ ${position.avgCost} · ${book}`;
}

function latestProposal(proposals: SimulatorView["proposals"], symbol: string): SimulatorView["proposals"][number] | undefined {
  return proposals.filter((item) => item.symbol === symbol).sort((a, b) => b.at - a.at)[0];
}

export function buildTopRows(input: {
  top10: Summary["top10"];
  live: PositionView[];
  sim: PositionView[];
  proposals: SimulatorView["proposals"];
}): TopRow[] {
  return input.top10.map((quote, index) => {
    const held = [
      ...input.live.filter((position) => position.symbol === quote.symbol && position.status !== "closed"),
      ...input.sim.filter((position) => position.symbol === quote.symbol && position.status !== "closed"),
    ];
    const primary = held[0];
    const lastNum = parseUsd(quote.last);
    const avg = primary ? parseUsd(primary.avgCost) : null;
    const distances = primary && lastNum != null && avg != null ? exitDistances(lastNum, avg, primary.profitTargetPct, primary.stopLossPct) : null;
    const proposal = latestProposal(input.proposals, quote.symbol);
    const rule = primary ? [primary.buyRule, primary.sellRule].filter(Boolean).join(" · ") : "";
    return {
      rank: index + 1,
      symbol: quote.symbol,
      bid: quote.bid,
      ask: quote.ask,
      last: quote.last,
      lastNum,
      bidNum: parseUsd(quote.bid),
      askNum: parseUsd(quote.ask),
      change: quote.change,
      changePct: quote.changePct,
      position: held.map(positionLine).join(" · ") || "—",
      positionTitle: held.length ? held.map(positionLine).join("; ") : "Not held",
      pnl: primary ? parseUsd(primary.pnl) : null,
      target: distances ? distances.target : null,
      stop: distances ? distances.stop : null,
      targetTitle: distances ? `Target price ${distances.targetPrice.toFixed(2)} is ${distances.target.toFixed(2)}% from last. Settings percent ${primary?.profitTargetPct} of average cost.` : "Not held",
      stopTitle: distances ? `Stop price ${distances.stopPrice.toFixed(2)} is ${distances.stop.toFixed(2)}% from last. Settings percent ${primary?.stopLossPct} of average cost.` : "Not held",
      rule: rule || "—",
      check: proposal ? proposal.verdict : "—",
      checkTitle: proposal ? `${proposal.verdict}. ${proposal.message}` : "",
      company: quote.company ?? null,
      name: quote.company?.name?.trim() ?? "",
      sector: displaySecText(quote.company?.sector),
      industry: displaySecText(quote.company?.industry),
    };
  });
}

export function topSortValue(row: TopRow, key: string): string | number | null {
  if (key === "rank") return row.rank;
  if (key === "symbol") return row.symbol;
  if (key === "last") return row.lastNum;
  if (key === "bid") return row.bidNum;
  if (key === "ask") return row.askNum;
  if (key === "change") return row.change;
  if (key === "changePct") return row.changePct;
  if (key === "position") return row.position === "—" ? null : row.position;
  if (key === "pnl") return row.pnl;
  if (key === "target") return row.target;
  if (key === "stop") return row.stop;
  if (key === "rule") return row.rule === "—" ? null : row.rule;
  if (key === "check") return row.check === "—" ? null : row.check;
  if (key === "name") return row.name || null;
  if (key === "sector") return row.sector === "—" ? null : row.sector;
  if (key === "industry") return row.industry === "—" ? null : row.industry;
  return null;
}

/** 0 is flat. ±1..±5 step at 0.5%, 1%, 2%, and 3%. */
export function heatLevel(changePct: number | null): number {
  if (changePct == null || changePct === 0) return 0;
  const mag = Math.abs(changePct);
  let step = 1;
  if (mag > 0.5) step = 2;
  if (mag > 1) step = 3;
  if (mag > 2) step = 4;
  if (mag > 3) step = 5;
  return changePct > 0 ? step : -step;
}

export function heatMix(changePct: number | null): { background: string; color: string } {
  const level = heatLevel(changePct);
  if (level === 0) return { background: "var(--heat-flat)", color: "var(--heat-flat-ink)" };
  const side = level > 0 ? "pos" : "neg";
  const step = Math.abs(level);
  return { background: `var(--heat-${side}-${step})`, color: `var(--heat-${side}-${step}-ink)` };
}
