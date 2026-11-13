import { marketSession } from "./clock.js";
import { roundMoney } from "./money.js";
import type { PositionRecord, PositionReview, PriceMark, TradeRecord } from "./storage.js";

export function buildPositionReview(input: {
  position: PositionRecord;
  trades: TradeRecord[];
  marks: PriceMark[];
  exitType: string;
  exitPrice: number;
  now: number;
  spyChangeAtEntry?: number;
  sessionAtEntry?: string;
}): PositionReview {
  const { position, trades, marks, exitType, exitPrice, now } = input;
  const buys = trades.filter((trade) => trade.side === "buy" && trade.fillPrice && trade.status === "filled");
  const proceeds = roundMoney(position.qty * exitPrice);
  const spreadCost = roundMoney(buys.reduce((sum, trade) => {
    if (trade.askAtOrder == null || trade.bidAtOrder == null) return sum;
    return sum + ((trade.askAtOrder - trade.bidAtOrder) / 2) * trade.qty;
  }, 0));
  const pnlDollars = roundMoney(proceeds - (position.qty * position.avgCost));
  const basis = position.qty * position.avgCost;
  const pnlPct = basis > 0 ? roundMoney((pnlDollars / basis) * 100) : 0;
  const holdMinutes = Math.max(0, Math.round((now - position.openedAt) / 60000));
  const prices = [...marks.map((mark) => mark.price), exitPrice, ...buys.map((trade) => trade.fillPrice ?? 0)].filter((price) => price > 0);
  const bestPrice = prices.length ? Math.max(...prices) : exitPrice;
  const worstPrice = prices.length ? Math.min(...prices) : exitPrice;
  const addsCount = Math.max(0, buys.length - 1);
  const starter = buys[0];
  let addsHelped: boolean | undefined;
  if (starter && addsCount > 0) {
    const starterQty = starter.qty;
    const starterPnl = roundMoney(starterQty * (exitPrice - (starter.fillPrice ?? position.avgCost)));
    addsHelped = pnlDollars > starterPnl;
  }
  const sessionAtEntry = input.sessionAtEntry ?? (starter ? starter.session : marketSession(new Date(position.openedAt)));
  const botNote = botNoteText({
    symbol: position.symbol,
    holdMinutes,
    pnlDollars,
    pnlPct,
    exitType,
    addsCount,
    addsHelped,
    bestPrice,
    worstPrice,
    spyChangeAtEntry: input.spyChangeAtEntry,
    sessionAtEntry,
    spreadCost,
  });
  return {
    positionId: position.id,
    pnlDollars,
    pnlPct,
    holdMinutes,
    exitType,
    bestPrice,
    worstPrice,
    spyChangeAtEntry: input.spyChangeAtEntry,
    sessionAtEntry,
    spreadCost,
    addsCount,
    addsHelped,
    botNote,
    createdAt: now,
  };
}

export function botNoteText(input: {
  symbol: string;
  holdMinutes: number;
  pnlDollars: number;
  pnlPct: number;
  exitType: string;
  addsCount: number;
  addsHelped?: boolean;
  bestPrice: number;
  worstPrice: number;
  spyChangeAtEntry?: number;
  sessionAtEntry?: string;
  spreadCost?: number;
}): string {
  const pnl = `${input.pnlDollars >= 0 ? "+" : ""}${input.pnlDollars.toFixed(2)} (${input.pnlPct >= 0 ? "+" : ""}${input.pnlPct.toFixed(2)}%)`;
  const add = input.addsCount === 0
    ? "No adds."
    : `${input.addsCount} add${input.addsCount === 1 ? "" : "s"}${input.addsHelped == null ? "" : input.addsHelped ? " (helped)" : " (did not help)"}.`;
  const spy = input.spyChangeAtEntry == null ? "" : ` SPY at entry ${input.spyChangeAtEntry >= 0 ? "+" : ""}${input.spyChangeAtEntry.toFixed(2)}%.`;
  const spread = input.spreadCost && input.spreadCost > 0 ? ` Spread cost about $${input.spreadCost.toFixed(2)}.` : "";
  return `Held ${input.holdMinutes} minute${input.holdMinutes === 1 ? "" : "s"} in ${input.sessionAtEntry ?? "the session"}. Exited by ${input.exitType}. P&L ${pnl}. Best $${input.bestPrice.toFixed(2)}, worst $${input.worstPrice.toFixed(2)}. ${add}${spy}${spread}`.trim();
}
