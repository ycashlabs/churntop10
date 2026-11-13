/** How long simulator quote bars are kept. */
export const BAR_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Stored proposal cap; the Simulator UI already shows only the last 12. */
export const PROPOSAL_CAP = 12;

export type SqlWrite = { sql: string; params?: unknown[] };

export type BarRow = { symbol: string; ts: number; price: number; volume: number };

export type ProposalRow = Record<string, unknown>;

export type OrderRow = Record<string, unknown>;

export function planSaveBars(existing: BarRow[], incoming: BarRow[], now: number): SqlWrite[] {
  const cutoff = now - BAR_RETENTION_MS;
  const keptIncoming = incoming.filter((row) => row.ts >= cutoff);
  const existingKeys = new Set(existing.map((row) => `${row.symbol}:${row.ts}`));
  const writes: SqlWrite[] = [];
  if (existing.some((row) => row.ts < cutoff)) {
    writes.push({ sql: "DELETE FROM quote_bars WHERE ts < ?", params: [cutoff] });
  }
  for (const row of keptIncoming) {
    if (existingKeys.has(`${row.symbol}:${row.ts}`)) continue;
    writes.push({
      sql: "INSERT INTO quote_bars (symbol, ts, price, volume) VALUES (?, ?, ?, ?) ON CONFLICT (symbol, ts) DO NOTHING",
      params: [row.symbol, row.ts, row.price, row.volume],
    });
  }
  return writes;
}

export function planReplaceProposals(existing: ProposalRow[], incoming: ProposalRow[]): SqlWrite[] {
  const kept = [...incoming].sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0)).slice(-PROPOSAL_CAP);
  const existingIds = new Set(existing.map((row) => String(row.id)));
  const keptIds = new Set(kept.map((row) => String(row.id)));
  const writes: SqlWrite[] = [];
  if (existing.some((row) => !keptIds.has(String(row.id)))) {
    if (kept.length === 0) writes.push({ sql: "DELETE FROM proposals", params: [] });
    else writes.push({
      sql: `DELETE FROM proposals WHERE id NOT IN (${kept.map(() => "?").join(", ")})`,
      params: kept.map((row) => row.id),
    });
  }
  for (const row of kept) {
    if (existingIds.has(String(row.id))) continue;
    writes.push({
      sql: "INSERT INTO proposals (id, ref_id, symbol, verdict, message, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
      params: [row.id, row.refId, row.symbol, row.verdict, row.message, row.payload, row.createdAt],
    });
  }
  return writes;
}

function orderId(row: OrderRow): string {
  return String(row.id ?? "");
}

export function normalizeOrder(row: OrderRow): string {
  return JSON.stringify({
    id: orderId(row),
    refId: String(row.refId ?? row.ref_id ?? ""),
    symbol: String(row.symbol ?? ""),
    side: String(row.side ?? ""),
    type: String(row.type ?? ""),
    quantity: Number(row.quantity ?? 0),
    limit: row.limit ?? row.limit_price ?? null,
    stop: row.stop ?? row.stop_price ?? null,
    status: String(row.status ?? ""),
    role: String(row.role ?? ""),
    openedOn: String(row.openedOn ?? row.opened_on ?? ""),
    createdAt: Number(row.createdAt ?? row.created_at ?? 0),
  });
}

function orderInsertParams(row: OrderRow): unknown[] {
  return [
    row.id, row.refId ?? row.ref_id, row.symbol, row.side, row.type, row.quantity,
    row.limit ?? row.limit_price ?? null, row.stop ?? row.stop_price ?? null,
    row.status, row.role, row.openedOn ?? row.opened_on, row.createdAt ?? row.created_at,
  ];
}

export function planReplaceWorkingOrders(existing: OrderRow[], incoming: OrderRow[]): SqlWrite[] {
  const existingNorm = [...existing].map(normalizeOrder).sort();
  const incomingNorm = [...incoming].map(normalizeOrder).sort();
  if (existingNorm.length === incomingNorm.length && existingNorm.every((value, index) => value === incomingNorm[index])) {
    return [];
  }
  const writes: SqlWrite[] = [];
  const existingById = new Map(existing.map((row) => [orderId(row), row]));
  const incomingById = new Map(incoming.map((row) => [orderId(row), row]));
  const toDelete = [...existingById.keys()].filter((id) => !incomingById.has(id));
  if (toDelete.length > 0) {
    writes.push({
      sql: `DELETE FROM sim_orders WHERE id IN (${toDelete.map(() => "?").join(", ")})`,
      params: toDelete,
    });
  }
  for (const [id, row] of incomingById) {
    const prev = existingById.get(id);
    if (prev && normalizeOrder(prev) === normalizeOrder(row)) continue;
    if (prev) {
      writes.push({
        sql: "UPDATE sim_orders SET ref_id = ?, symbol = ?, side = ?, type = ?, quantity = ?, limit_price = ?, stop_price = ?, status = ?, role = ?, opened_on = ?, created_at = ? WHERE id = ?",
        params: [
          row.refId ?? row.ref_id, row.symbol, row.side, row.type, row.quantity,
          row.limit ?? row.limit_price ?? null, row.stop ?? row.stop_price ?? null,
          row.status, row.role, row.openedOn ?? row.opened_on, row.createdAt ?? row.created_at, id,
        ],
      });
    } else {
      writes.push({
        sql: "INSERT INTO sim_orders (id, ref_id, symbol, side, type, quantity, limit_price, stop_price, status, role, opened_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params: orderInsertParams(row),
      });
    }
  }
  return writes;
}

export function planSetSelectedRuleIds(existing: string[], ids: string[]): SqlWrite[] {
  const have = [...new Set(existing)].sort();
  const want = [...new Set(ids)].sort();
  if (have.length === want.length && have.every((value, index) => value === want[index])) return [];
  const haveSet = new Set(have);
  const wantSet = new Set(want);
  const writes: SqlWrite[] = [];
  const toDelete = have.filter((id) => !wantSet.has(id));
  if (toDelete.length > 0) {
    writes.push({
      sql: `DELETE FROM sim_selected_rules WHERE rule_id IN (${toDelete.map(() => "?").join(", ")})`,
      params: toDelete,
    });
  }
  for (const id of want) {
    if (haveSet.has(id)) continue;
    writes.push({
      sql: "INSERT INTO sim_selected_rules (rule_id) VALUES (?) ON CONFLICT (rule_id) DO NOTHING",
      params: [id],
    });
  }
  return writes;
}

export function samePosition(
  current: {
    id: string; mode: string; symbol: string; status: string;
    tradingCapitalSnapshot: number; profitTargetPct: number; stopLossPct: number;
    buyRuleVersionId?: string; sellRuleVersionId?: string;
    avgCost: number; qty: number; openedAt: number; closedAt?: number; source?: string;
  },
  next: typeof current,
): boolean {
  return current.id === next.id
    && current.mode === next.mode
    && current.symbol === next.symbol
    && current.status === next.status
    && current.tradingCapitalSnapshot === next.tradingCapitalSnapshot
    && current.profitTargetPct === next.profitTargetPct
    && current.stopLossPct === next.stopLossPct
    && (current.buyRuleVersionId ?? null) === (next.buyRuleVersionId ?? null)
    && (current.sellRuleVersionId ?? null) === (next.sellRuleVersionId ?? null)
    && current.avgCost === next.avgCost
    && current.qty === next.qty
    && current.openedAt === next.openedAt
    && (current.closedAt ?? null) === (next.closedAt ?? null)
    && (current.source ?? "app") === (next.source ?? "app");
}

export function shouldWritePriceMark(lastPrice: number | undefined, price: number): boolean {
  return lastPrice == null || lastPrice !== price;
}

/** Legacy saveSim write-statement count: full DELETE + per-row INSERT, plus upserts and marks. */
export function legacySimTickWriteStatements(input: {
  bars: number; proposals: number; orders: number; selected: number; positions: number; priceMarks: number; settings?: boolean;
}): number {
  const settings = input.settings === false ? 0 : 1;
  return (1 + input.bars) + (1 + input.proposals) + (1 + input.orders) + (1 + input.selected) + input.positions + input.priceMarks + settings;
}
