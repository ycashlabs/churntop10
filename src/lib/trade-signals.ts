import { getSignal, type SignalResult } from "./signals.js";

/** Decision cutoffs in the same units as SignalResult.value. */
export const SIGNAL_THRESHOLDS: Record<string, number> = {
  price_above_20m_avg: 0,
  volume_above_recent: 1,
  spy_up: 0,
  spy_falling: 0,
  spy_not_falling_hard: -0.5,
  below_avg_cost: 0,
  above_20m_low: 0,
  no_sell_volume_spike: 1.5,
  below_20m_avg: 0,
  rising_volume: 1,
};

export function defaultThreshold(signalId: string): number | null {
  const value = SIGNAL_THRESHOLDS[signalId];
  return value === undefined ? null : value;
}

/** Exact trades-table line from DESIGN §6: name, Fired/Not fired, optional value/threshold, reason. */
export function formatTradeSignalLine(signal: Pick<SignalResult, "name" | "fired" | "value" | "threshold" | "reason">): string {
  const flag = signal.fired ? "Fired" : "Not fired";
  const parts = [`${signal.name}: ${flag}.`];
  if (signal.value != null && Number.isFinite(signal.value)) {
    if (signal.threshold != null && Number.isFinite(signal.threshold)) {
      parts.push(`Value ${signal.value}, threshold ${signal.threshold}.`);
    } else {
      parts.push(`Value ${signal.value}.`);
    }
  }
  const reason = signal.reason?.trim();
  if (reason) parts.push(reason);
  return parts.join(" ");
}


/** Rebuild a SignalResult from a trade_signals row. Missing name falls back to the catalog. */
export function signalResultFromRow(item: Record<string, unknown>): SignalResult {
  const id = String(item.signal_id ?? item.id ?? "");
  const storedName = typeof item.name === "string" && item.name ? item.name : undefined;
  const fired = item.fired === true || item.passed === 1 || item.passed === true;
  return {
    id,
    name: storedName ?? getSignal(id)?.name ?? id,
    fired,
    value: item.value == null ? null : Number(item.value),
    threshold: item.threshold == null ? null : Number(item.threshold),
    reason: typeof item.reason === "string" ? item.reason : "",
  };
}

export interface TradeSignalRow {
  tradeId: string;
  signalId: string;
  value: number | null;
  threshold: number | null;
  fired: boolean;
  name?: string;
  reason?: string;
}

export interface BackfillTrade {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  createdAt: number;
}

export interface BackfillAudit {
  action: string;
  at: number;
  detail: string | Record<string, unknown>;
}

export interface BackfillProposal {
  symbol: string;
  createdAt: number;
  payload: string | unknown;
}

const BUY_ACTIONS = new Set(["sim_entry", "sim_add", "live_order"]);
const SELL_ACTIONS = new Set(["weakness_exit_filled", "stop_exit_filled", "broker_stop_filled", "target_filled", "sell_all_filled"]);
const MATCH_WINDOW_MS = 120_000;

export function parseSignalsPayload(payload: unknown): SignalResult[] {
  let value = payload;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const rows: SignalResult[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== "string") continue;
    const fired = rec.fired === true || rec.passed === 1 || rec.passed === true;
    const rawValue = rec.value;
    const rawThreshold = rec.threshold;
    rows.push({
      id: rec.id,
      name: typeof rec.name === "string" ? rec.name : rec.id,
      fired,
      value: typeof rawValue === "number" ? rawValue : null,
      threshold: typeof rawThreshold === "number" ? rawThreshold : defaultThreshold(rec.id),
      reason: typeof rec.reason === "string" ? rec.reason : "",
    });
  }
  return rows;
}

export function rowsFromSignalResults(tradeId: string, signals: SignalResult[]): TradeSignalRow[] {
  return signals.map((signal) => ({
    tradeId,
    signalId: signal.id,
    value: signal.value,
    threshold: signal.threshold ?? defaultThreshold(signal.id),
    fired: signal.fired,
    name: signal.name,
    reason: signal.reason,
  }));
}

function parseDetail(detail: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof detail === "string") {
    try {
      const parsed = JSON.parse(detail);
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return detail ?? {};
}

/** Pair a trade with signals from a same-timestamp proposal, or the nearest audit event. */
export function planBackfill(input: {
  trades: BackfillTrade[];
  audits?: BackfillAudit[];
  proposals?: BackfillProposal[];
  alreadyHasSignals?: Set<string>;
}): TradeSignalRow[] {
  const out: TradeSignalRow[] = [];
  const seen = new Set<string>();
  for (const trade of input.trades) {
    if (input.alreadyHasSignals?.has(trade.id)) continue;
    const proposal = (input.proposals ?? []).find((item) => item.symbol === trade.symbol && item.createdAt === trade.createdAt);
    let signals = proposal ? parseSignalsPayload(proposal.payload) : [];
    if (signals.length === 0) {
      const allowed = trade.side === "buy" ? BUY_ACTIONS : SELL_ACTIONS;
      const matches = (input.audits ?? [])
        .map((audit) => {
          const detail = parseDetail(audit.detail);
          return { audit, detail, symbol: typeof detail.symbol === "string" ? detail.symbol : "" };
        })
        .filter((item) => item.symbol === trade.symbol && allowed.has(item.audit.action))
        .filter((item) => Math.abs(item.audit.at - trade.createdAt) <= MATCH_WINDOW_MS)
        .sort((a, b) => Math.abs(a.audit.at - trade.createdAt) - Math.abs(b.audit.at - trade.createdAt));
      const best = matches[0];
      if (best) signals = parseSignalsPayload(best.detail.signals);
    }
    for (const row of rowsFromSignalResults(trade.id, signals)) {
      const key = `${row.tradeId}:${row.signalId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  }
  return out;
}
