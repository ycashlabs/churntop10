import type { OrderView } from "./decode.js";
import type { SignalResult } from "./signals.js";
import type { CapitalHistoryRow, PositionRecord, PositionReview, TradeRecord } from "./storage.js";

export type BrokerHolding = {
  symbol: string;
  quantity: number;
  averageBuyPrice?: number;
};

export type ReconcileContext = {
  now: number;
  session: string;
  tradingCapital: number;
  profitTargetPct: number;
  stopLossPct: number;
  nextId: () => string;
};

export type ReconcileChange = {
  kind: "import" | "qty_change" | "close" | "avg_cost";
  position: PositionRecord;
  trade?: TradeRecord;
  capital?: CapitalHistoryRow;
  review?: PositionReview;
};

const EPS = 1e-6;

export function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= EPS;
}

function asMap(holdings: BrokerHolding[]): Map<string, BrokerHolding> {
  const map = new Map<string, BrokerHolding>();
  for (const holding of holdings) {
    if (holding.quantity <= EPS) continue;
    const symbol = holding.symbol.toUpperCase();
    map.set(symbol, { ...holding, symbol });
  }
  return map;
}

export function openLiveBySymbol(positions: PositionRecord[]): Map<string, PositionRecord> {
  const map = new Map<string, PositionRecord>();
  for (const position of positions) {
    if (position.mode !== "live" || position.status !== "open") continue;
    map.set(position.symbol.toUpperCase(), position);
  }
  return map;
}

export function reconcileLiveHoldings(
  openLive: PositionRecord[],
  holdings: BrokerHolding[],
  ctx: ReconcileContext,
): ReconcileChange[] {
  const existing = openLiveBySymbol(openLive);
  const current = asMap(holdings);
  const changes: ReconcileChange[] = [];

  for (const [symbol, holding] of current) {
    const position = existing.get(symbol);
    if (!position) {
      changes.push(importPosition(holding, ctx));
      continue;
    }
    const sameQty = nearlyEqual(position.qty, holding.quantity);
    const sameCost = holding.averageBuyPrice == null || nearlyEqual(position.avgCost, holding.averageBuyPrice);
    if (sameQty && sameCost) continue;
    if (sameQty && holding.averageBuyPrice != null) {
      changes.push({ kind: "avg_cost", position: { ...position, avgCost: holding.averageBuyPrice } });
      continue;
    }
    const delta = holding.quantity - position.qty;
    const price = holding.averageBuyPrice ?? position.avgCost;
    changes.push({
      kind: "qty_change",
      position: { ...position, qty: holding.quantity, avgCost: price },
      trade: {
        id: ctx.nextId(),
        positionId: position.id,
        side: delta > 0 ? "buy" : "sell",
        qty: Math.abs(delta),
        fillPrice: price,
        session: ctx.session,
        capitalSnapshot: position.tradingCapitalSnapshot,
        sizeReason: "Quantity changed in the Robinhood account outside this app.",
        status: "filled",
        createdAt: ctx.now,
        source: "broker_qty_change",
      },
    });
  }

  for (const [symbol, position] of existing) {
    if (current.has(symbol)) continue;
    changes.push({
      kind: "close",
      position: { ...position, qty: 0, status: "closed", closedAt: ctx.now },
      trade: {
        id: ctx.nextId(),
        positionId: position.id,
        side: "sell",
        qty: position.qty,
        fillPrice: position.avgCost,
        session: ctx.session,
        capitalSnapshot: position.tradingCapitalSnapshot,
        sizeReason: "Position is no longer in the Robinhood account.",
        exitReason: "broker_close",
        status: "filled",
        createdAt: ctx.now,
        source: "broker_close",
      },
      review: {
        positionId: position.id,
        pnlDollars: 0,
        pnlPct: 0,
        holdMinutes: Math.max(0, Math.round((ctx.now - position.openedAt) / 60000)),
        exitType: position.source === "imported" ? "imported_close" : "broker_close",
        sessionAtEntry: ctx.session,
        addsCount: 0,
        botNote: "Closed because the holding is no longer in the Robinhood account. The close was not placed by this app.",
        createdAt: ctx.now,
      },
    });
  }
  return changes;
}

function importPosition(holding: BrokerHolding, ctx: ReconcileContext): ReconcileChange {
  const id = ctx.nextId();
  const avgCost = holding.averageBuyPrice ?? 0;
  return {
    kind: "import",
    position: {
      id,
      mode: "live",
      symbol: holding.symbol,
      status: "open",
      tradingCapitalSnapshot: ctx.tradingCapital,
      profitTargetPct: ctx.profitTargetPct,
      stopLossPct: ctx.stopLossPct,
      avgCost,
      qty: holding.quantity,
      openedAt: ctx.now,
      source: "imported",
    },
    trade: {
      id: ctx.nextId(),
      positionId: id,
      side: "buy",
      qty: holding.quantity,
      fillPrice: avgCost || undefined,
      session: ctx.session,
      capitalSnapshot: ctx.tradingCapital,
      sizeReason: "Imported from the Robinhood account. Marked imported/manual.",
      status: "filled",
      createdAt: ctx.now,
      source: "broker_import",
    },
    capital: {
      id: ctx.nextId(),
      positionId: id,
      oldValue: 0,
      newValue: ctx.tradingCapital,
      at: ctx.now,
    },
    review: {
      positionId: id,
      pnlDollars: 0,
      pnlPct: 0,
      holdMinutes: 0,
      exitType: "imported",
      sessionAtEntry: ctx.session,
      addsCount: 0,
      botNote: "Imported from the Robinhood account. No buy rule. No automatic sell rule or stop unless you assign a sell rule.",
      createdAt: ctx.now,
    },
  };
}

export type LiveBuyInput = {
  existing?: PositionRecord;
  symbol: string;
  qty: number;
  limitPrice: number;
  fillPrice?: number;
  brokerOrderId: string;
  buyRuleVersionId?: string;
  sellRuleVersionId?: string;
  signals?: SignalResult[];
  session: string;
  bid?: number;
  ask?: number;
  tradingCapital: number;
  profitTargetPct: number;
  stopLossPct: number;
  sizeReason: string;
  status: string;
  now: number;
  nextId: () => string;
};

/** Records for an order the app itself placed on the gated live path. Idempotent by broker order id at the call site. */
export function recordsForPlacedLiveBuy(input: LiveBuyInput): { position: PositionRecord; trade: TradeRecord; capital?: CapitalHistoryRow } {
  const existing = input.existing;
  const positionId = existing?.id ?? input.nextId();
  const qty = (existing?.qty ?? 0) + input.qty;
  const avgCost = existing
    ? (existing.avgCost * existing.qty + (input.fillPrice ?? input.limitPrice) * input.qty) / (qty || 1)
    : (input.fillPrice ?? input.limitPrice);
  const position: PositionRecord = existing
    ? { ...existing, qty, avgCost, sellRuleVersionId: input.sellRuleVersionId ?? existing.sellRuleVersionId }
    : {
        id: positionId,
        mode: "live",
        symbol: input.symbol.toUpperCase(),
        status: "open",
        tradingCapitalSnapshot: input.tradingCapital,
        profitTargetPct: input.profitTargetPct,
        stopLossPct: input.stopLossPct,
        buyRuleVersionId: input.buyRuleVersionId,
        sellRuleVersionId: input.sellRuleVersionId,
        avgCost,
        qty: input.qty,
        openedAt: input.now,
        source: "app",
      };
  const trade: TradeRecord = {
    id: input.nextId(),
    positionId,
    ruleVersionId: input.buyRuleVersionId,
    side: "buy",
    qty: input.qty,
    limitPrice: input.limitPrice,
    fillPrice: input.fillPrice,
    session: input.session,
    bidAtOrder: input.bid,
    askAtOrder: input.ask,
    capitalSnapshot: input.tradingCapital,
    sizeReason: input.sizeReason,
    brokerOrderId: input.brokerOrderId,
    status: input.status,
    createdAt: input.now,
    signals: input.signals,
    source: "app",
  };
  const capital = existing
    ? undefined
    : {
        id: input.nextId(),
        positionId,
        oldValue: 0,
        newValue: input.tradingCapital,
        at: input.now,
      };
  return { position, trade, capital };
}

export function applyOrderFill(trade: TradeRecord, order: OrderView): TradeRecord | undefined {
  if (!trade.brokerOrderId || trade.brokerOrderId !== order.id) return undefined;
  const filled = order.state === "filled" || order.state === "partially_filled";
  if (!filled) {
    if (trade.status === order.state) return undefined;
    return { ...trade, status: order.state };
  }
  const fillPrice = order.averagePrice ?? order.price ?? trade.fillPrice ?? trade.limitPrice;
  if (trade.status === "filled" && (fillPrice == null || (trade.fillPrice != null && nearlyEqual(trade.fillPrice, fillPrice)))) {
    return undefined;
  }
  return {
    ...trade,
    status: "filled",
    fillPrice,
    qty: order.quantity || trade.qty,
  };
}

/** Cron should still cycle the simulator when there are no open sim positions. */
export function shouldTickSimulator(_openCount: number): boolean {
  return true;
}

/** Skip daily score snapshots when there is nothing closed to score. */
export function shouldComputeScores(closedCount: number): boolean {
  return closedCount > 0;
}

export function labelBuyRule(position: Pick<PositionRecord, "source" | "buyRuleVersionId">, ruleName?: string): string | undefined {
  if (ruleName) return ruleName;
  if (position.source === "imported" || !position.buyRuleVersionId) {
    if (position.source === "imported") return "imported/manual";
  }
  return undefined;
}
