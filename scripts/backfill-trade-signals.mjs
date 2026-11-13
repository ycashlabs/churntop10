#!/usr/bin/env node
/**
 * Plan or emit SQL to backfill trade_signals from sim_entry / proposal payloads.
 *
 * Does not connect to production. Feed it a JSON dump:
 *   { "trades": [...], "audits": [...], "proposals": [...], "existing": ["trade-id-already-filled"] }
 *
 * Usage:
 *   node scripts/backfill-trade-signals.mjs plan <dump.json>
 *   node scripts/backfill-trade-signals.mjs sql <dump.json>
 *
 * Prod application requires an explicit owner go-ahead. See docs/HANDOVER.md.
 */
import { readFileSync } from "node:fs";
import { defaultThreshold, planBackfill } from "../src/lib/trade-signals.ts";

const [, , command, file] = process.argv;
if (!command || !file || !["plan", "sql"].includes(command)) {
  console.error("Usage: node scripts/backfill-trade-signals.mjs <plan|sql> <dump.json>");
  process.exit(2);
}

const dump = JSON.parse(readFileSync(file, "utf8"));
const rows = planBackfill({
  trades: dump.trades ?? [],
  audits: dump.audits ?? [],
  proposals: dump.proposals ?? [],
  alreadyHasSignals: new Set(dump.existing ?? []),
});

if (command === "plan") {
  console.log(JSON.stringify({ count: rows.length, rows }, null, 2));
  process.exit(0);
}

for (const row of rows) {
  const value = row.value == null ? "NULL" : String(row.value);
  const threshold = row.threshold == null ? "NULL" : String(row.threshold);
  const fired = row.fired ? 1 : 0;
  const tradeId = row.tradeId.replaceAll("'", "''");
  const signalId = row.signalId.replaceAll("'", "''");
  console.log(
    `INSERT INTO trade_signals (trade_id, signal_id, value, passed, threshold) VALUES ('${tradeId}', '${signalId}', ${value}, ${fired}, ${threshold}) ON CONFLICT (trade_id, signal_id) DO UPDATE SET value = excluded.value, passed = excluded.passed, threshold = excluded.threshold;`,
  );
}
void defaultThreshold;
