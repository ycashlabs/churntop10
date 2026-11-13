import { DRAFT_RULES } from "../../lib/rules.js";
import { signalCatalog } from "../../lib/signals.js";
import type { MiniDb } from "./minidb.js";

function tableExists(tables: Set<string>, name: string): boolean {
  return tables.has(name);
}

export async function listTableNames(db: MiniDb): Promise<Set<string>> {
  const rows = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
  return new Set(rows.map((row) => row.name));
}

export async function migrateV2Data(db: MiniDb, now = Date.now()): Promise<{ rules: number; positions: number; trades: number }> {
  const tables = await listTableNames(db);
  await seedSignals(db, now);

  let rules = 0;
  if (tableExists(tables, "rules") && tableExists(tables, "trading_rules")) {
    const existing = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM trading_rules");
    if (!existing || existing.n === 0) {
      rules = await copyRules(db);
    }
  }

  let positions = 0;
  let trades = 0;
  if (tableExists(tables, "positions")) {
    const existing = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM positions");
    if (!existing || existing.n === 0) {
      const copied = await copySimRecords(db, now);
      positions = copied.positions;
      trades = copied.trades;
    }
  }

  if (tableExists(tables, "app_settings")) {
    const settings = await db.first<{ trading_capital: number; cash: number; profit_target_pct: number; stop_loss_pct: number }>(
      "SELECT trading_capital, cash, profit_target_pct, stop_loss_pct FROM app_settings WHERE id = 1",
    );
    if (settings && (!(settings.trading_capital > 0)) && settings.cash > 0) {
      await db.exec("UPDATE app_settings SET trading_capital = ? WHERE id = 1", [settings.cash]);
    }
  }

  return { rules, positions, trades };
}

export async function seedSignals(db: MiniDb, now = Date.now()): Promise<void> {
  for (const signal of signalCatalog()) {
    await db.exec(
      "INSERT INTO signals (id, name, description, status, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
      [signal.id, signal.name, signal.description, signal.status, now],
    );
  }
}

async function copyRules(db: MiniDb): Promise<number> {
  const rows = await db.all<{
    id: string; family_id: string; name: string; side: string; body: string; signals: string; status: string; version: number; created_at: number; updated_at: number;
  }>("SELECT * FROM rules ORDER BY family_id, version");
  const latest = new Map<string, typeof rows[number]>();
  for (const row of rows) latest.set(row.family_id, row);
  for (const row of latest.values()) {
    await db.exec(
      "INSERT INTO trading_rules (id, side, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
      [row.family_id, row.side, row.name, row.status, row.created_at, row.updated_at],
    );
  }
  const signalRows = await db.all<{ id: string }>("SELECT id FROM signals");
  const known = new Set(signalRows.map((row) => row.id));
  for (const row of rows) {
    await db.exec(
      "INSERT INTO rule_versions (id, rule_id, version, name, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
      [row.id, row.family_id, row.version, row.name, row.body, row.status, row.created_at, row.updated_at],
    );
    let signals: string[] = [];
    try { signals = JSON.parse(row.signals) as string[]; } catch { signals = []; }
    for (const id of signals) {
      if (!known.has(id)) continue;
      await db.exec(
        "INSERT INTO rule_signals (rule_version_id, signal_id, params) VALUES (?, ?, ?) ON CONFLICT (rule_version_id, signal_id) DO NOTHING",
        [row.id, id, "{}"],
      );
    }
  }
  return latest.size;
}

async function copySimRecords(db: MiniDb, now: number): Promise<{ positions: number; trades: number }> {
  const settings = await db.first<{ cash: number; profit_target_pct: number; stop_loss_pct: number }>(
    "SELECT cash, profit_target_pct, stop_loss_pct FROM app_settings WHERE id = 1",
  );
  const capital = settings && settings.cash > 0 ? settings.cash : 10000;
  const profit = settings?.profit_target_pct ?? 1;
  const stop = settings?.stop_loss_pct ?? 1;

  const open = await db.all<{
    symbol: string; quantity: number; avg_cost: number; opened_on: string;
    buy_rule_id: string | null; sell_rule_id: string | null;
  }>("SELECT symbol, quantity, avg_cost, opened_on, buy_rule_id, sell_rule_id FROM sim_positions").catch(async () => {
    return db.all<{ symbol: string; quantity: number; avg_cost: number; opened_on: string; buy_rule_id: string | null; sell_rule_id: string | null }>(
      "SELECT symbol, quantity, avg_cost, opened_on, NULL AS buy_rule_id, NULL AS sell_rule_id FROM sim_positions",
    );
  });

  let positions = 0;
  let trades = 0;
  for (const row of open) {
    const id = `sim-open-${row.symbol}`;
    const openedAt = Date.parse(`${row.opened_on}T20:00:00.000Z`) || now;
    await db.exec(
      `INSERT INTO positions (id, mode, symbol, status, trading_capital_snapshot, profit_target_pct, stop_loss_pct, buy_rule_version_id, sell_rule_version_id, avg_cost, qty, opened_at, closed_at)
       VALUES (?, 'sim', ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT (id) DO NOTHING`,
      [id, row.symbol, capital, profit, stop, row.buy_rule_id, row.sell_rule_id, row.avg_cost, row.quantity, openedAt],
    );
    positions += 1;
  }

  const closed = await db.all<{
    id: string; symbol: string; quantity: number; entry_price: number; exit_price: number; pnl: number;
    opened_on: string; closed_at: number; buy_rule_id: string | null; sell_rule_id: string | null; reason: string;
  }>("SELECT id, symbol, quantity, entry_price, exit_price, pnl, opened_on, closed_at, buy_rule_id, sell_rule_id, reason FROM sim_trades").catch(() => []);

  for (const row of closed) {
    const openedAt = Date.parse(`${row.opened_on}T20:00:00.000Z`) || row.closed_at;
    await db.exec(
      `INSERT INTO positions (id, mode, symbol, status, trading_capital_snapshot, profit_target_pct, stop_loss_pct, buy_rule_version_id, sell_rule_version_id, avg_cost, qty, opened_at, closed_at)
       VALUES (?, 'sim', ?, 'closed', ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
      [row.id, row.symbol, capital, profit, stop, row.buy_rule_id, row.sell_rule_id, row.entry_price, row.quantity, openedAt, row.closed_at],
    );
    await db.exec(
      `INSERT INTO trades (id, position_id, rule_version_id, side, qty, limit_price, fill_price, session, bid_at_order, ask_at_order, capital_snapshot, size_reason, exit_reason, broker_order_id, status, created_at)
       VALUES (?, ?, ?, 'buy', ?, ?, ?, 'unknown', NULL, NULL, ?, 'Migrated starter from v2.', NULL, NULL, 'filled', ?) ON CONFLICT (id) DO NOTHING`,
      [`${row.id}-entry`, row.id, row.buy_rule_id, row.quantity, row.entry_price, row.entry_price, capital, openedAt],
    );
    await db.exec(
      `INSERT INTO trades (id, position_id, rule_version_id, side, qty, limit_price, fill_price, session, bid_at_order, ask_at_order, capital_snapshot, size_reason, exit_reason, broker_order_id, status, created_at)
       VALUES (?, ?, ?, 'sell', ?, ?, ?, 'unknown', NULL, NULL, ?, 'Migrated exit from v2.', ?, NULL, 'filled', ?) ON CONFLICT (id) DO NOTHING`,
      [`${row.id}-exit`, row.id, row.sell_rule_id, row.quantity, row.exit_price, row.exit_price, capital, row.reason, row.closed_at],
    );
    positions += 1;
    trades += 2;
  }
  return { positions, trades };
}

/** Used only when a brand-new database has no trading_rules yet. */
export async function hasTradingRules(db: MiniDb): Promise<boolean> {
  const row = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM trading_rules");
  return !!row && row.n > 0;
}

export { DRAFT_RULES };
