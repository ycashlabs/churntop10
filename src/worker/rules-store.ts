import { DRAFT_RULES, scorecardFromTrades, type RuleHistoryRow, type RuleRecord, type RuleSide, type RuleStatus, type Scorecard } from "../lib/rules.js";

export interface RuleStore {
  db: D1Database;
}

function parseRule(row: {
  id: string;
  family_id: string;
  name: string;
  side: string;
  body: string;
  signals: string;
  status: string;
  version: number;
  created_at: number;
  updated_at: number;
}): RuleRecord {
  return {
    id: row.id,
    familyId: row.family_id,
    name: row.name,
    side: row.side as RuleSide,
    body: row.body,
    signals: JSON.parse(row.signals) as string[],
    status: row.status as RuleStatus,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listRules(db: D1Database): Promise<RuleRecord[]> {
  const rows = (await db.prepare("SELECT * FROM rules ORDER BY side, name, version").all<{
    id: string; family_id: string; name: string; side: string; body: string; signals: string; status: string; version: number; created_at: number; updated_at: number;
  }>()).results;
  return rows.map(parseRule);
}

export async function currentRules(db: D1Database): Promise<RuleRecord[]> {
  const all = await listRules(db);
  const latest = new Map<string, RuleRecord>();
  for (const rule of all) {
    const prev = latest.get(rule.familyId);
    if (!prev || rule.version > prev.version) latest.set(rule.familyId, rule);
  }
  return [...latest.values()];
}

export async function seedDraftRules(db: D1Database): Promise<void> {
  const existing = await db.prepare("SELECT id FROM rules LIMIT 1").first();
  if (existing) return;
  const now = Date.now();
  const statements = [];
  for (const seed of DRAFT_RULES) {
    const id = crypto.randomUUID();
    statements.push(db.prepare(
      "INSERT INTO rules (id, family_id, name, side, body, signals, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'experimenting', 1, ?, ?)",
    ).bind(id, seed.familyId, seed.name, seed.side, seed.body, JSON.stringify(seed.signals), now, now));
    statements.push(db.prepare(
      "INSERT INTO rule_history (id, rule_id, family_id, action, from_status, to_status, version, detail, at) VALUES (?, ?, ?, 'created', NULL, 'experimenting', 1, ?, ?)",
    ).bind(crypto.randomUUID(), id, seed.familyId, JSON.stringify({ name: seed.name, seeded: true }), now));
    statements.push(db.prepare("INSERT OR IGNORE INTO sim_selected_rules (rule_id) VALUES (?)").bind(id));
  }
  await db.batch(statements);
}

export async function createRule(db: D1Database, input: { name: string; side: RuleSide; body: string; signals: string[] }): Promise<RuleRecord> {
  const name = input.name.trim();
  if (!name) throw new Error("A rule needs a name.");
  if (input.side !== "buy" && input.side !== "sell") throw new Error("A rule is either a buy rule or a sell rule.");
  const now = Date.now();
  const id = crypto.randomUUID();
  const familyId = crypto.randomUUID();
  await db.prepare(
    "INSERT INTO rules (id, family_id, name, side, body, signals, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'experimenting', 1, ?, ?)",
  ).bind(id, familyId, name, input.side, input.body.trim(), JSON.stringify(input.signals), now, now).run();
  await appendHistory(db, { ruleId: id, familyId, action: "created", toStatus: "experimenting", version: 1, detail: { name, body: input.body, signals: input.signals }, at: now });
  const row = await db.prepare("SELECT * FROM rules WHERE id = ?").bind(id).first();
  if (!row) throw new Error("The rule could not be saved.");
  return parseRule(row as Parameters<typeof parseRule>[0]);
}

export async function editRule(db: D1Database, id: string, input: { name?: string; body?: string; signals?: string[] }): Promise<RuleRecord> {
  const current = await currentById(db, id);
  if (!current) throw new Error("That rule was not found.");
  const name = (input.name ?? current.name).trim();
  const body = (input.body ?? current.body).trim();
  const signals = input.signals ?? current.signals;
  if (!name) throw new Error("A rule needs a name.");
  const now = Date.now();
  if (current.status === "proven") {
    const nextId = crypto.randomUUID();
    const version = current.version + 1;
    await db.prepare(
      "INSERT INTO rules (id, family_id, name, side, body, signals, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'experimenting', ?, ?, ?)",
    ).bind(nextId, current.familyId, name, current.side, body, JSON.stringify(signals), version, now, now).run();
    await appendHistory(db, { ruleId: nextId, familyId: current.familyId, action: "edited", fromStatus: "proven", toStatus: "experimenting", version, detail: { previousId: current.id, name, body, signals }, at: now });
    const row = await db.prepare("SELECT * FROM rules WHERE id = ?").bind(nextId).first();
    if (!row) throw new Error("The new rule version could not be saved.");
    return parseRule(row as Parameters<typeof parseRule>[0]);
  }
  await db.prepare("UPDATE rules SET name = ?, body = ?, signals = ?, updated_at = ? WHERE id = ?").bind(name, body, JSON.stringify(signals), now, current.id).run();
  await appendHistory(db, { ruleId: current.id, familyId: current.familyId, action: "edited", fromStatus: current.status, toStatus: current.status, version: current.version, detail: { name, body, signals }, at: now });
  return { ...current, name, body, signals, updatedAt: now };
}

export async function setRuleStatus(db: D1Database, id: string, status: RuleStatus): Promise<RuleRecord> {
  if (status !== "experimenting" && status !== "proven" && status !== "retired") throw new Error("Status must be Experimenting, Proven, or Retired.");
  const current = await currentById(db, id);
  if (!current) throw new Error("That rule was not found.");
  if (current.status === status) return current;
  const now = Date.now();
  await db.prepare("UPDATE rules SET status = ?, updated_at = ? WHERE id = ?").bind(status, now, current.id).run();
  const action = status === "proven" ? "approved" : "status";
  await appendHistory(db, { ruleId: current.id, familyId: current.familyId, action, fromStatus: current.status, toStatus: status, version: current.version, detail: { from: current.status, to: status }, at: now });
  return { ...current, status, updatedAt: now };
}

export async function listHistory(db: D1Database, familyId: string): Promise<RuleHistoryRow[]> {
  const rows = (await db.prepare("SELECT * FROM rule_history WHERE family_id = ? ORDER BY at DESC").bind(familyId).all<{
    id: string; rule_id: string; family_id: string; action: string; from_status: string | null; to_status: string | null; version: number; detail: string; at: number;
  }>()).results;
  return rows.map((row) => ({
    id: row.id,
    ruleId: row.rule_id,
    familyId: row.family_id,
    action: row.action as RuleHistoryRow["action"],
    fromStatus: (row.from_status ?? undefined) as RuleStatus | undefined,
    toStatus: (row.to_status ?? undefined) as RuleStatus | undefined,
    version: row.version,
    detail: row.detail,
    at: row.at,
  }));
}

export async function scorecards(db: D1Database, rules: RuleRecord[]): Promise<Map<string, Scorecard>> {
  const trades = (await db.prepare("SELECT buy_rule_id, sell_rule_id, pnl FROM sim_trades").all<{ buy_rule_id: string | null; sell_rule_id: string | null; pnl: number }>()).results;
  const byFamily = new Map<string, number[]>();
  const idToFamily = new Map(rules.map((rule) => [rule.id, rule.familyId]));
  // Also map older versions.
  const all = await listRules(db);
  for (const rule of all) idToFamily.set(rule.id, rule.familyId);
  for (const trade of trades) {
    for (const id of [trade.buy_rule_id, trade.sell_rule_id]) {
      if (!id) continue;
      const family = idToFamily.get(id);
      if (!family) continue;
      const list = byFamily.get(family) ?? [];
      list.push(trade.pnl);
      byFamily.set(family, list);
    }
  }
  const out = new Map<string, Scorecard>();
  for (const rule of rules) {
    out.set(rule.familyId, scorecardFromTrades(rule.familyId, byFamily.get(rule.familyId) ?? []));
  }
  return out;
}

async function currentById(db: D1Database, id: string): Promise<RuleRecord | undefined> {
  const row = await db.prepare("SELECT * FROM rules WHERE id = ?").bind(id).first();
  if (row) return parseRule(row as Parameters<typeof parseRule>[0]);
  const family = await db.prepare("SELECT * FROM rules WHERE family_id = ? ORDER BY version DESC LIMIT 1").bind(id).first();
  return family ? parseRule(family as Parameters<typeof parseRule>[0]) : undefined;
}

async function appendHistory(db: D1Database, input: { ruleId: string; familyId: string; action: RuleHistoryRow["action"]; fromStatus?: RuleStatus; toStatus?: RuleStatus; version: number; detail: unknown; at: number }): Promise<void> {
  await db.prepare(
    "INSERT INTO rule_history (id, rule_id, family_id, action, from_status, to_status, version, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), input.ruleId, input.familyId, input.action, input.fromStatus ?? null, input.toStatus ?? null, input.version, JSON.stringify(input.detail), input.at).run();
}
