import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { MiniDb } from "../src/worker/storage/minidb.js";
import { migrateV2Data } from "../src/worker/storage/migrate.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function applyFile(db: DatabaseSync, name: string): void {
  const sql = readFileSync(join(root, "migrations", name), "utf8");
  for (const part of sql.split(";")) {
    const statement = part.trim();
    if (statement) db.exec(statement);
  }
}

function sqliteMini(db: DatabaseSync): MiniDb {
  return {
    async exec(sql: string, params: unknown[] = []) {
      db.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
    async first<T>(sql: string, params: unknown[] = []) {
      const row = db.prepare(sql).get(...(params as never[]));
      return (row as T | undefined) ?? undefined;
    },
  };
}

describe("migrations", () => {
  it("applies a fresh 0001–0007 database and backfills the signal catalog", async () => {
    const db = new DatabaseSync(":memory:");
    applyFile(db, "0001_init.sql");
    applyFile(db, "0002_v2.sql");
    applyFile(db, "0003_v3.sql");
    applyFile(db, "0004_live_sync.sql");
    applyFile(db, "0005_trade_signals_threshold.sql");
    applyFile(db, "0006_trade_signals_name_reason.sql");
    applyFile(db, "0007_auth_totp.sql");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>;
    const names = tables.map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining([
      "app_settings", "positions", "trades", "trade_signals", "signals",
      "trading_rules", "rule_versions", "rule_signals", "price_marks",
      "position_reviews", "position_capital_history", "position_exit_settings_history",
      "rule_score_snapshots", "signal_score_snapshots",
      "totp", "totp_backup_codes",
    ]));
    const sessionCols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    expect(sessionCols.map((col) => col.name)).toEqual(expect.arrayContaining(["auth_method", "stepup_method"]));
    const result = await migrateV2Data(sqliteMini(db), 1_700_000_000_000);
    expect(result.rules).toBe(0);
    const signals = db.prepare("SELECT COUNT(*) AS n FROM signals").get() as { n: number };
    expect(signals.n).toBeGreaterThanOrEqual(8);
    const cols = db.prepare("PRAGMA table_info(app_settings)").all() as Array<{ name: string }>;
    expect(cols.map((col) => col.name)).toContain("trading_capital");
    const positionCols = db.prepare("PRAGMA table_info(positions)").all() as Array<{ name: string }>;
    expect(positionCols.map((col) => col.name)).toContain("source");
    const tradeCols = db.prepare("PRAGMA table_info(trades)").all() as Array<{ name: string }>;
    expect(tradeCols.map((col) => col.name)).toContain("source");
    const signalCols = db.prepare("PRAGMA table_info(trade_signals)").all() as Array<{ name: string }>;
    expect(signalCols.map((col) => col.name)).toEqual(expect.arrayContaining(["threshold", "name", "reason"]));
  });

  it("upgrades a v2 database, moving rules, open positions, and closed trades", async () => {
    const db = new DatabaseSync(":memory:");
    applyFile(db, "0001_init.sql");
    applyFile(db, "0002_v2.sql");
    const now = 1_700_000_000_000;
    db.prepare(`INSERT INTO app_settings (id, profit_target_pct, stop_loss_pct, max_order_pct, daily_loss_pct, pdt_limit, order_cap, mode, killed, day_start_equity, day_start_date, cash, account_number)
      VALUES (1, 1, 1, 10, 1, 3, 100, 'view_only', 0, 10000, '2026-11-13', 10000, 'SIM0000999')`).run();
    db.prepare("INSERT INTO rules (id, family_id, name, side, body, signals, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'experimenting', 1, ?, ?)").run(
      "ver-1", "buy-first-strength", "First buy on strength", "buy", "Starter", '["price_above_20m_avg","spy_up"]', now, now,
    );
    db.prepare("INSERT INTO sim_positions (symbol, quantity, avg_cost, opened_on, buy_rule_id, buy_rule_version, sell_rule_id, sell_rule_version) VALUES ('NVDA', 1, 167.96, '2026-11-13', 'ver-1', 1, NULL, NULL)").run();
    db.prepare(`INSERT INTO sim_trades (id, symbol, quantity, entry_price, exit_price, pnl, opened_on, closed_at, buy_rule_id, buy_rule_version, sell_rule_id, sell_rule_version, signals, reason)
      VALUES ('tr-1', 'MSFT', 1, 521, 530, 9, '2026-11-12', ?, 'ver-1', 1, NULL, NULL, '[]', 'target')`).run(now);
    applyFile(db, "0003_v3.sql");
    applyFile(db, "0004_live_sync.sql");
    const result = await migrateV2Data(sqliteMini(db), now);
    expect(result.rules).toBe(1);
    expect(result.positions).toBeGreaterThanOrEqual(2);
    const rule = db.prepare("SELECT name, status FROM trading_rules WHERE id = 'buy-first-strength'").get() as { name: string; status: string };
    expect(rule.name).toBe("First buy on strength");
    const version = db.prepare("SELECT rule_id, version FROM rule_versions WHERE id = 'ver-1'").get() as { rule_id: string; version: number };
    expect(version.rule_id).toBe("buy-first-strength");
    const links = db.prepare("SELECT signal_id FROM rule_signals WHERE rule_version_id = 'ver-1' ORDER BY signal_id").all() as Array<{ signal_id: string }>;
    expect(links.map((row) => row.signal_id)).toEqual(["price_above_20m_avg", "spy_up"]);
    const open = db.prepare("SELECT symbol, qty, trading_capital_snapshot, status FROM positions WHERE status = 'open'").get() as { symbol: string; qty: number; trading_capital_snapshot: number; status: string };
    expect(open.symbol).toBe("NVDA");
    expect(open.trading_capital_snapshot).toBe(10000);
    const closed = db.prepare("SELECT status FROM positions WHERE id = 'tr-1'").get() as { status: string };
    expect(closed.status).toBe("closed");
    const trades = db.prepare("SELECT side FROM trades WHERE position_id = 'tr-1' ORDER BY side").all() as Array<{ side: string }>;
    expect(trades.map((row) => row.side)).toEqual(["buy", "sell"]);
    const settings = db.prepare("SELECT trading_capital FROM app_settings WHERE id = 1").get() as { trading_capital: number };
    expect(settings.trading_capital).toBe(10000);
  });
});
