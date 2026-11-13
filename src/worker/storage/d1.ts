import { DRAFT_RULES, scorecardFromTrades, type RuleHistoryRow, type RuleRecord, type RuleSide, type RuleStatus, type Scorecard } from "../../lib/rules.js";
import type {
  PositionMode,
  PositionRecord,
  PositionReview,
  PriceMark,
  ReviewListItem,
  RuleScoreSnapshot,
  SignalScoreSnapshot,
  Storage,
  TradeRecord,
} from "../../lib/storage.js";
import { signalResultFromRow } from "../../lib/trade-signals.js";
import { d1Mini, type MiniDb } from "./minidb.js";
import { migrateV2Data, seedSignals as seedSignalRows } from "./migrate.js";

function asPosition(row: Record<string, unknown>): PositionRecord {
  return {
    id: String(row.id),
    mode: row.mode as PositionRecord["mode"],
    symbol: String(row.symbol),
    status: row.status as PositionRecord["status"],
    tradingCapitalSnapshot: Number(row.trading_capital_snapshot),
    profitTargetPct: Number(row.profit_target_pct),
    stopLossPct: Number(row.stop_loss_pct),
    buyRuleVersionId: (row.buy_rule_version_id as string | null) ?? undefined,
    sellRuleVersionId: (row.sell_rule_version_id as string | null) ?? undefined,
    avgCost: Number(row.avg_cost),
    qty: Number(row.qty),
    openedAt: Number(row.opened_at),
    closedAt: row.closed_at == null ? undefined : Number(row.closed_at),
    source: row.source === "imported" ? "imported" : "app",
  };
}

function asTrade(row: Record<string, unknown>): TradeRecord {
  return {
    id: String(row.id),
    positionId: String(row.position_id),
    ruleVersionId: (row.rule_version_id as string | null) ?? undefined,
    side: row.side as TradeRecord["side"],
    qty: Number(row.qty),
    limitPrice: row.limit_price == null ? undefined : Number(row.limit_price),
    fillPrice: row.fill_price == null ? undefined : Number(row.fill_price),
    session: String(row.session),
    bidAtOrder: row.bid_at_order == null ? undefined : Number(row.bid_at_order),
    askAtOrder: row.ask_at_order == null ? undefined : Number(row.ask_at_order),
    capitalSnapshot: Number(row.capital_snapshot),
    sizeReason: String(row.size_reason),
    exitReason: (row.exit_reason as string | null) ?? undefined,
    brokerOrderId: (row.broker_order_id as string | null) ?? undefined,
    status: String(row.status),
    createdAt: Number(row.created_at),
    source: (row.source as TradeRecord["source"] | null) ?? "app",
  };
}

function asRule(row: {
  id: string; rule_id: string; name: string; side: string; body: string; status: string;
  version: number; created_at: number; updated_at: number; signals?: string;
}): RuleRecord {
  let signals: string[] = [];
  if (row.signals) {
    try { signals = JSON.parse(row.signals) as string[]; } catch { signals = []; }
  }
  return {
    id: row.id,
    familyId: row.rule_id,
    name: row.name,
    side: row.side as RuleSide,
    body: row.body,
    signals,
    status: row.status as RuleStatus,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createMiniStorage(mini: MiniDb): Storage {

  async function loadSignals(versionId: string): Promise<string[]> {
    const rows = await mini.all<{ signal_id: string }>("SELECT signal_id FROM rule_signals WHERE rule_version_id = ?", [versionId]);
    return rows.map((row) => row.signal_id);
  }

  async function writeSignals(versionId: string, signals: string[]): Promise<void> {
    await mini.exec("DELETE FROM rule_signals WHERE rule_version_id = ?", [versionId]);
    for (const id of signals) {
      await mini.exec("INSERT INTO rule_signals (rule_version_id, signal_id, params) VALUES (?, ?, ?)", [versionId, id, "{}"]);
    }
  }

  const store: Storage = {
    async getSettings() {
      const row = await mini.first<{
        profit_target_pct: number; stop_loss_pct: number; daily_loss_pct: number; order_cap: number;
        trading_capital: number; mode: "view_only" | "live"; killed: number; day_start_equity: number;
        day_start_date: string; cash: number; account_number: string;
      }>("SELECT * FROM app_settings WHERE id = 1");
      if (!row) return undefined;
      return {
        profitTargetPct: row.profit_target_pct,
        stopLossPct: row.stop_loss_pct,
        dailyLossPct: row.daily_loss_pct,
        orderCap: row.order_cap ?? 100,
        tradingCapital: row.trading_capital ?? 0,
        mode: row.mode,
        killed: row.killed === 1,
        dayStartEquity: row.day_start_equity,
        dayStartDate: row.day_start_date,
        cash: row.cash,
        accountNumber: row.account_number,
      };
    },

    async saveSettings(patch) {
      const current = await store.getSettings();
      if (!current) return;
      const next = { ...current, ...patch };
      await mini.exec(
        "UPDATE app_settings SET profit_target_pct = ?, stop_loss_pct = ?, daily_loss_pct = ?, order_cap = ?, trading_capital = ?, mode = ?, killed = ?, day_start_equity = ?, day_start_date = ?, cash = ? WHERE id = 1",
        [next.profitTargetPct, next.stopLossPct, next.dailyLossPct, next.orderCap, next.tradingCapital, next.mode, next.killed ? 1 : 0, next.dayStartEquity, next.dayStartDate, next.cash],
      );
    },

    async listPositions(mode, status) {
      let sql = "SELECT * FROM positions";
      const params: unknown[] = [];
      if (mode && status) { sql += " WHERE mode = ? AND status = ?"; params.push(mode, status); }
      else if (mode) { sql += " WHERE mode = ?"; params.push(mode); }
      else if (status) { sql += " WHERE status = ?"; params.push(status); }
      sql += " ORDER BY opened_at DESC";
      const rows = await mini.all<Record<string, unknown>>(sql, params);
      return rows.map(asPosition);
    },

    async getPosition(id) {
      const row = await mini.first<Record<string, unknown>>("SELECT * FROM positions WHERE id = ?", [id]);
      return row ? asPosition(row) : undefined;
    },

    async upsertPosition(position) {
      await mini.exec(
        `INSERT INTO positions (id, mode, symbol, status, trading_capital_snapshot, profit_target_pct, stop_loss_pct, buy_rule_version_id, sell_rule_version_id, avg_cost, qty, opened_at, closed_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           status = excluded.status,
           trading_capital_snapshot = excluded.trading_capital_snapshot,
           profit_target_pct = excluded.profit_target_pct,
           stop_loss_pct = excluded.stop_loss_pct,
           buy_rule_version_id = excluded.buy_rule_version_id,
           sell_rule_version_id = excluded.sell_rule_version_id,
           avg_cost = excluded.avg_cost,
           qty = excluded.qty,
           closed_at = excluded.closed_at,
           source = excluded.source`,
        [position.id, position.mode, position.symbol, position.status, position.tradingCapitalSnapshot, position.profitTargetPct, position.stopLossPct, position.buyRuleVersionId ?? null, position.sellRuleVersionId ?? null, position.avgCost, position.qty, position.openedAt, position.closedAt ?? null, position.source ?? "app"],
      );
    },

    async listTrades(positionId) {
      const rows = await mini.all<Record<string, unknown>>("SELECT * FROM trades WHERE position_id = ? ORDER BY created_at", [positionId]);
      const trades = rows.map(asTrade);
      for (const trade of trades) {
        const signals = await mini.all<Record<string, unknown>>("SELECT * FROM trade_signals WHERE trade_id = ?", [trade.id]);
        trade.signals = signals.map((item) => signalResultFromRow(item));
      }
      return trades;
    },

    async insertTrade(trade) {
      await mini.exec(
        `INSERT INTO trades (id, position_id, rule_version_id, side, qty, limit_price, fill_price, session, bid_at_order, ask_at_order, capital_snapshot, size_reason, exit_reason, broker_order_id, status, created_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET status = excluded.status, fill_price = excluded.fill_price, exit_reason = excluded.exit_reason, qty = excluded.qty, source = excluded.source`,
        [trade.id, trade.positionId, trade.ruleVersionId ?? null, trade.side, trade.qty, trade.limitPrice ?? null, trade.fillPrice ?? null, trade.session, trade.bidAtOrder ?? null, trade.askAtOrder ?? null, trade.capitalSnapshot, trade.sizeReason, trade.exitReason ?? null, trade.brokerOrderId ?? null, trade.status, trade.createdAt, trade.source ?? "app"],
      );
      if (trade.signals) {
        for (const signal of trade.signals) {
          await mini.exec(
            "INSERT INTO trade_signals (trade_id, signal_id, value, passed, threshold, name, reason) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (trade_id, signal_id) DO UPDATE SET value = excluded.value, passed = excluded.passed, threshold = excluded.threshold, name = excluded.name, reason = excluded.reason",
            [trade.id, signal.id, signal.value, signal.fired ? 1 : 0, signal.threshold ?? null, signal.name, signal.reason],
          );
        }
      }
    },

    async getTradeByBrokerOrderId(brokerOrderId) {
      if (!brokerOrderId) return undefined;
      const row = await mini.first<Record<string, unknown>>("SELECT * FROM trades WHERE broker_order_id = ? LIMIT 1", [brokerOrderId]);
      return row ? asTrade(row) : undefined;
    },

    async insertPriceMark(mark) {
      await mini.exec("INSERT INTO price_marks (id, position_id, at, price) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING", [mark.id, mark.positionId, mark.at, mark.price]);
    },

    async listPriceMarks(positionId) {
      return mini.all<PriceMark>("SELECT id, position_id AS positionId, at, price FROM price_marks WHERE position_id = ? ORDER BY at", [positionId]);
    },

    async insertReview(review) {
      await mini.exec(
        `INSERT INTO position_reviews (position_id, pnl_dollars, pnl_pct, hold_minutes, exit_type, best_price, worst_price, spy_change_at_entry, session_at_entry, spread_cost, adds_count, adds_helped, bot_note, user_note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (position_id) DO UPDATE SET bot_note = excluded.bot_note, pnl_dollars = excluded.pnl_dollars, pnl_pct = excluded.pnl_pct`,
        [review.positionId, review.pnlDollars, review.pnlPct, review.holdMinutes, review.exitType, review.bestPrice ?? null, review.worstPrice ?? null, review.spyChangeAtEntry ?? null, review.sessionAtEntry ?? null, review.spreadCost ?? null, review.addsCount, review.addsHelped == null ? null : review.addsHelped ? 1 : 0, review.botNote, review.userNote ?? null, review.createdAt],
      );
    },

    async updateReviewNote(positionId, userNote) {
      await mini.exec("UPDATE position_reviews SET user_note = ? WHERE position_id = ?", [userNote, positionId]);
    },

    async getReview(positionId) {
      const row = await mini.first<Record<string, unknown>>("SELECT * FROM position_reviews WHERE position_id = ?", [positionId]);
      return row ? asReview(row) : undefined;
    },

    async listReviews(filters) {
      let sql = `SELECT r.*, p.symbol, p.mode, p.qty, p.avg_cost, p.opened_at, p.closed_at,
        bv.name AS buy_rule_name, sv.name AS sell_rule_name
        FROM position_reviews r
        JOIN positions p ON p.id = r.position_id
        LEFT JOIN rule_versions bv ON bv.id = p.buy_rule_version_id
        LEFT JOIN rule_versions sv ON sv.id = p.sell_rule_version_id
        WHERE 1 = 1`;
      const params: unknown[] = [];
      if (filters.mode) { sql += " AND p.mode = ?"; params.push(filters.mode); }
      if (filters.symbol) { sql += " AND p.symbol = ?"; params.push(filters.symbol.toUpperCase()); }
      if (filters.session) { sql += " AND r.session_at_entry = ?"; params.push(filters.session); }
      if (filters.from) { sql += " AND p.closed_at >= ?"; params.push(filters.from); }
      if (filters.to) { sql += " AND p.closed_at <= ?"; params.push(filters.to); }
      if (filters.ruleId) { sql += " AND (p.buy_rule_version_id = ? OR p.sell_rule_version_id = ? OR bv.rule_id = ? OR sv.rule_id = ?)"; params.push(filters.ruleId, filters.ruleId, filters.ruleId, filters.ruleId); }
      sql += " ORDER BY p.closed_at DESC";
      const rows = await mini.all<Record<string, unknown>>(sql, params);
      return rows.map((row) => ({
        ...asReview(row),
        symbol: String(row.symbol),
        mode: row.mode as PositionMode,
        qty: Number(row.qty),
        avgCost: Number(row.avg_cost),
        openedAt: Number(row.opened_at),
        closedAt: row.closed_at == null ? undefined : Number(row.closed_at),
        buyRuleName: (row.buy_rule_name as string | null) ?? undefined,
        sellRuleName: (row.sell_rule_name as string | null) ?? undefined,
      })) as ReviewListItem[];
    },

    async insertCapitalHistory(row) {
      await mini.exec("INSERT INTO position_capital_history (id, position_id, old_value, new_value, at) VALUES (?, ?, ?, ?, ?)", [row.id, row.positionId, row.oldValue, row.newValue, row.at]);
    },

    async insertExitSettingsHistory(row) {
      await mini.exec("INSERT INTO position_exit_settings_history (id, position_id, field, old_value, new_value, at) VALUES (?, ?, ?, ?, ?, ?)", [row.id, row.positionId, row.field, row.oldValue, row.newValue, row.at]);
    },

    async seedSignals() {
      await seedSignalRows(mini);
    },

    async listSignals() {
      const rows = await mini.all<{ id: string; name: string; description: string; status: "candidate" | "active" | "retired"; added_at: number }>("SELECT * FROM signals ORDER BY name");
      return rows.map((row) => ({ id: row.id, name: row.name, description: row.description, status: row.status, addedAt: row.added_at }));
    },

    async currentRules() {
      const versions = await store.listRuleVersions();
      const latest = new Map<string, RuleRecord>();
      for (const rule of versions) {
        const prev = latest.get(rule.familyId);
        if (!prev || rule.version > prev.version) latest.set(rule.familyId, rule);
      }
      return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name));
    },

    async listRuleVersions() {
      const rows = await mini.all<{
        id: string; rule_id: string; name: string; side: string; body: string; status: string; version: number; created_at: number; updated_at: number;
      }>(`SELECT v.id, v.rule_id, v.name, r.side, v.body, v.status, v.version, v.created_at, v.updated_at
          FROM rule_versions v JOIN trading_rules r ON r.id = v.rule_id
          ORDER BY r.side, v.name, v.version`);
      const out: RuleRecord[] = [];
      for (const row of rows) {
        const rule = asRule(row);
        rule.signals = await loadSignals(row.id);
        out.push(rule);
      }
      return out;
    },

    async seedDraftRules() {
      const existing = await mini.first<{ id: string }>("SELECT id FROM trading_rules LIMIT 1");
      if (existing) return;
      const now = Date.now();
      for (const seed of DRAFT_RULES) {
        const versionId = crypto.randomUUID();
        await mini.exec("INSERT INTO trading_rules (id, side, name, status, created_at, updated_at) VALUES (?, ?, ?, 'experimenting', ?, ?)", [seed.familyId, seed.side, seed.name, now, now]);
        await mini.exec("INSERT INTO rule_versions (id, rule_id, version, name, body, status, created_at, updated_at) VALUES (?, ?, 1, ?, ?, 'experimenting', ?, ?)", [versionId, seed.familyId, seed.name, seed.body, now, now]);
        await writeSignals(versionId, seed.signals);
        await mini.exec("INSERT INTO rule_history (id, rule_id, family_id, action, from_status, to_status, version, detail, at) VALUES (?, ?, ?, 'created', NULL, 'experimenting', 1, ?, ?)", [crypto.randomUUID(), versionId, seed.familyId, JSON.stringify({ name: seed.name, seeded: true }), now]);
        await mini.exec("INSERT INTO sim_selected_rules (rule_id) VALUES (?) ON CONFLICT (rule_id) DO NOTHING", [versionId]);
      }
    },

    async createRule(input) {
      const name = input.name.trim();
      if (!name) throw new Error("A rule needs a name.");
      if (input.side !== "buy" && input.side !== "sell") throw new Error("A rule is either a buy rule or a sell rule.");
      const now = Date.now();
      const familyId = crypto.randomUUID();
      const id = crypto.randomUUID();
      await mini.exec("INSERT INTO trading_rules (id, side, name, status, created_at, updated_at) VALUES (?, ?, ?, 'experimenting', ?, ?)", [familyId, input.side, name, now, now]);
      await mini.exec("INSERT INTO rule_versions (id, rule_id, version, name, body, status, created_at, updated_at) VALUES (?, ?, 1, ?, ?, 'experimenting', ?, ?)", [id, familyId, name, input.body.trim(), now, now]);
      await writeSignals(id, input.signals);
      await mini.exec("INSERT INTO rule_history (id, rule_id, family_id, action, from_status, to_status, version, detail, at) VALUES (?, ?, ?, 'created', NULL, 'experimenting', 1, ?, ?)", [crypto.randomUUID(), id, familyId, JSON.stringify({ name, body: input.body, signals: input.signals }), now]);
      return { id, familyId, name, side: input.side, body: input.body.trim(), signals: input.signals, status: "experimenting", version: 1, createdAt: now, updatedAt: now };
    },

    async editRule(id, input) {
      const current = await currentById(store, id);
      if (!current) throw new Error("That rule was not found.");
      const name = (input.name ?? current.name).trim();
      const body = (input.body ?? current.body).trim();
      const signals = input.signals ?? current.signals;
      if (!name) throw new Error("A rule needs a name.");
      const now = Date.now();
      if (current.status === "proven") {
        const nextId = crypto.randomUUID();
        const version = current.version + 1;
        await mini.exec("INSERT INTO rule_versions (id, rule_id, version, name, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'experimenting', ?, ?)", [nextId, current.familyId, version, name, body, now, now]);
        await mini.exec("UPDATE trading_rules SET name = ?, status = 'experimenting', updated_at = ? WHERE id = ?", [name, now, current.familyId]);
        await writeSignals(nextId, signals);
        await mini.exec("INSERT INTO rule_history (id, rule_id, family_id, action, from_status, to_status, version, detail, at) VALUES (?, ?, ?, 'edited', 'proven', 'experimenting', ?, ?, ?)", [crypto.randomUUID(), nextId, current.familyId, version, JSON.stringify({ previousId: current.id, name, body, signals }), now]);
        return { ...current, id: nextId, name, body, signals, status: "experimenting", version, createdAt: now, updatedAt: now };
      }
      await mini.exec("UPDATE rule_versions SET name = ?, body = ?, updated_at = ? WHERE id = ?", [name, body, now, current.id]);
      await mini.exec("UPDATE trading_rules SET name = ?, updated_at = ? WHERE id = ?", [name, now, current.familyId]);
      await writeSignals(current.id, signals);
      await mini.exec("INSERT INTO rule_history (id, rule_id, family_id, action, from_status, to_status, version, detail, at) VALUES (?, ?, ?, 'edited', ?, ?, ?, ?, ?)", [crypto.randomUUID(), current.id, current.familyId, current.status, current.status, current.version, JSON.stringify({ name, body, signals }), now]);
      return { ...current, name, body, signals, updatedAt: now };
    },

    async setRuleStatus(id, status) {
      if (status !== "experimenting" && status !== "proven" && status !== "retired") throw new Error("Status must be Experimenting, Proven, or Retired.");
      const current = await currentById(store, id);
      if (!current) throw new Error("That rule was not found.");
      if (current.status === status) return current;
      const now = Date.now();
      await mini.exec("UPDATE rule_versions SET status = ?, updated_at = ? WHERE id = ?", [status, now, current.id]);
      await mini.exec("UPDATE trading_rules SET status = ?, updated_at = ? WHERE id = ?", [status, now, current.familyId]);
      const action = status === "proven" ? "approved" : "status";
      await mini.exec("INSERT INTO rule_history (id, rule_id, family_id, action, from_status, to_status, version, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [crypto.randomUUID(), current.id, current.familyId, action, current.status, status, current.version, JSON.stringify({ from: current.status, to: status }), now]);
      return { ...current, status, updatedAt: now };
    },

    async listRuleHistory(familyId) {
      const rows = await mini.all<{
        id: string; rule_id: string; family_id: string; action: string; from_status: string | null; to_status: string | null; version: number; detail: string; at: number;
      }>("SELECT * FROM rule_history WHERE family_id = ? ORDER BY at DESC", [familyId]);
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
    },

    async ruleScorecards(rules) {
      const reviews = await mini.all<{ buy_rule_version_id: string | null; sell_rule_version_id: string | null; pnl_dollars: number }>(
        "SELECT p.buy_rule_version_id, p.sell_rule_version_id, r.pnl_dollars FROM position_reviews r JOIN positions p ON p.id = r.position_id",
      );
      const all = await store.listRuleVersions();
      const idToFamily = new Map(all.map((rule) => [rule.id, rule.familyId]));
      const byFamily = new Map<string, number[]>();
      for (const row of reviews) {
        for (const id of [row.buy_rule_version_id, row.sell_rule_version_id]) {
          if (!id) continue;
          const family = idToFamily.get(id);
          if (!family) continue;
          const list = byFamily.get(family) ?? [];
          list.push(row.pnl_dollars);
          byFamily.set(family, list);
        }
      }
      const out = new Map<string, Scorecard>();
      for (const rule of rules) out.set(rule.familyId, scorecardFromTrades(rule.familyId, byFamily.get(rule.familyId) ?? []));
      return out;
    },

    async selectedRuleIds() {
      const rows = await mini.all<{ rule_id: string }>("SELECT rule_id FROM sim_selected_rules");
      return rows.map((row) => row.rule_id);
    },

    async setSelectedRuleIds(ids) {
      await mini.exec("DELETE FROM sim_selected_rules");
      for (const id of ids) {
        await mini.exec("INSERT INTO sim_selected_rules (rule_id) VALUES (?) ON CONFLICT (rule_id) DO NOTHING", [id]);
      }
    },

    async latestRuleScoreSnapshots(mode) {
      const sql = mode
        ? "SELECT * FROM rule_score_snapshots WHERE mode = ? AND period_end = (SELECT MAX(period_end) FROM rule_score_snapshots WHERE mode = ?) ORDER BY rule_id"
        : "SELECT * FROM rule_score_snapshots WHERE period_end = (SELECT MAX(period_end) FROM rule_score_snapshots) ORDER BY mode, rule_id";
      const rows = await mini.all<Record<string, unknown>>(sql, mode ? [mode, mode] : []);
      return rows.map(asRuleSnap);
    },

    async latestSignalScoreSnapshots(mode) {
      const sql = mode
        ? "SELECT * FROM signal_score_snapshots WHERE mode = ? AND period_end = (SELECT MAX(period_end) FROM signal_score_snapshots WHERE mode = ?) ORDER BY signal_id"
        : "SELECT * FROM signal_score_snapshots WHERE period_end = (SELECT MAX(period_end) FROM signal_score_snapshots) ORDER BY mode, signal_id";
      const rows = await mini.all<Record<string, unknown>>(sql, mode ? [mode, mode] : []);
      return rows.map(asSignalSnap);
    },

    async saveRuleScoreSnapshots(rows) {
      for (const row of rows) {
        await mini.exec(
          `INSERT INTO rule_score_snapshots (id, period_start, period_end, mode, rule_id, rule_version_id, trades, win_rate, avg_pnl_pct, worst_loss, net_after_costs, computed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
          [row.id, row.periodStart, row.periodEnd, row.mode, row.ruleId ?? null, row.ruleVersionId ?? null, row.trades, row.winRate, row.avgPnlPct, row.worstLoss, row.netAfterCosts, row.computedAt],
        );
      }
    },

    async saveSignalScoreSnapshots(rows) {
      for (const row of rows) {
        await mini.exec(
          `INSERT INTO signal_score_snapshots (id, period_start, period_end, mode, signal_id, win_rate_true, avg_pnl_true, sample_true, win_rate_false, avg_pnl_false, sample_false, computed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
          [row.id, row.periodStart, row.periodEnd, row.mode, row.signalId, row.winRateTrue, row.avgPnlTrue, row.sampleTrue, row.winRateFalse, row.avgPnlFalse, row.sampleFalse, row.computedAt],
        );
      }
    },

    async lastScoreSnapshotEnd() {
      const row = await mini.first<{ n: number }>("SELECT MAX(period_end) AS n FROM rule_score_snapshots");
      return row?.n ?? undefined;
    },

    async listTop10() {
      const rows = await mini.all<{ symbol: string }>("SELECT symbol FROM top10 ORDER BY rank");
      return rows.map((row) => row.symbol);
    },

    async saveBars(rows) {
      await mini.exec("DELETE FROM quote_bars");
      for (const row of rows) {
        await mini.exec("INSERT INTO quote_bars (symbol, ts, price, volume) VALUES (?, ?, ?, ?)", [row.symbol, row.ts, row.price, row.volume]);
      }
    },

    async listBars() {
      return mini.all("SELECT symbol, ts, price, volume FROM quote_bars");
    },

    async replaceWorkingOrders(rows) {
      await mini.exec("DELETE FROM sim_orders");
      for (const item of rows) {
        const row = item as Record<string, unknown>;
        await mini.exec(
          "INSERT INTO sim_orders (id, ref_id, symbol, side, type, quantity, limit_price, stop_price, status, role, opened_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [row.id, row.refId, row.symbol, row.side, row.type, row.quantity, row.limit ?? null, row.stop ?? null, row.status, row.role, row.openedOn, row.createdAt],
        );
      }
    },

    async listWorkingOrders() {
      const rows = await mini.all<Record<string, unknown>>("SELECT * FROM sim_orders");
      return rows.map((row) => ({
        id: row.id, refId: row.ref_id, symbol: row.symbol, side: row.side, type: row.type,
        quantity: row.quantity, limit: row.limit_price, stop: row.stop_price, status: row.status,
        role: row.role, openedOn: row.opened_on, createdAt: row.created_at,
      }));
    },

    async replaceProposals(rows) {
      await mini.exec("DELETE FROM proposals");
      for (const item of rows) {
        const row = item as Record<string, unknown>;
        await mini.exec("INSERT INTO proposals (id, ref_id, symbol, verdict, message, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", [row.id, row.refId, row.symbol, row.verdict, row.message, row.payload, row.createdAt]);
      }
    },

    async listProposals() {
      const rows = await mini.all<Record<string, unknown>>("SELECT * FROM proposals");
      return rows.map((row) => ({
        id: row.id, refId: row.ref_id, symbol: row.symbol, verdict: row.verdict, message: row.message, payload: row.payload, createdAt: row.created_at,
      }));
    },
  };

  return store;
}

export function createD1Storage(db: D1Database): Storage {
  return createMiniStorage(d1Mini(db));
}

export async function prepareStorage(db: D1Database): Promise<Storage> {
  const storage = createD1Storage(db);
  await migrateV2Data(d1Mini(db));
  await storage.seedDraftRules();
  return storage;
}

async function currentById(store: Storage, id: string): Promise<RuleRecord | undefined> {
  const all = await store.listRuleVersions();
  return all.find((rule) => rule.id === id) ?? all.filter((rule) => rule.familyId === id).sort((a, b) => b.version - a.version)[0];
}

function asReview(row: Record<string, unknown>): PositionReview {
  return {
    positionId: String(row.position_id ?? row.positionId),
    pnlDollars: Number(row.pnl_dollars ?? row.pnlDollars),
    pnlPct: Number(row.pnl_pct ?? row.pnlPct),
    holdMinutes: Number(row.hold_minutes ?? row.holdMinutes),
    exitType: String(row.exit_type ?? row.exitType),
    bestPrice: row.best_price == null && row.bestPrice == null ? undefined : Number(row.best_price ?? row.bestPrice),
    worstPrice: row.worst_price == null && row.worstPrice == null ? undefined : Number(row.worst_price ?? row.worstPrice),
    spyChangeAtEntry: row.spy_change_at_entry == null && row.spyChangeAtEntry == null ? undefined : Number(row.spy_change_at_entry ?? row.spyChangeAtEntry),
    sessionAtEntry: (row.session_at_entry as string | null | undefined) ?? (row.sessionAtEntry as string | undefined),
    spreadCost: row.spread_cost == null && row.spreadCost == null ? undefined : Number(row.spread_cost ?? row.spreadCost),
    addsCount: Number(row.adds_count ?? row.addsCount),
    addsHelped: row.adds_helped == null && row.addsHelped == null ? undefined : Boolean(row.adds_helped ?? row.addsHelped),
    botNote: String(row.bot_note ?? row.botNote),
    userNote: (row.user_note as string | null | undefined) ?? (row.userNote as string | undefined),
    createdAt: Number(row.created_at ?? row.createdAt),
  };
}

function asRuleSnap(row: Record<string, unknown>): RuleScoreSnapshot {
  return {
    id: String(row.id),
    periodStart: Number(row.period_start),
    periodEnd: Number(row.period_end),
    mode: row.mode as PositionMode,
    ruleId: (row.rule_id as string | null) ?? undefined,
    ruleVersionId: (row.rule_version_id as string | null) ?? undefined,
    trades: Number(row.trades),
    winRate: row.win_rate == null ? null : Number(row.win_rate),
    avgPnlPct: row.avg_pnl_pct == null ? null : Number(row.avg_pnl_pct),
    worstLoss: row.worst_loss == null ? null : Number(row.worst_loss),
    netAfterCosts: row.net_after_costs == null ? null : Number(row.net_after_costs),
    computedAt: Number(row.computed_at),
  };
}

function asSignalSnap(row: Record<string, unknown>): SignalScoreSnapshot {
  return {
    id: String(row.id),
    periodStart: Number(row.period_start),
    periodEnd: Number(row.period_end),
    mode: row.mode as PositionMode,
    signalId: String(row.signal_id),
    winRateTrue: row.win_rate_true == null ? null : Number(row.win_rate_true),
    avgPnlTrue: row.avg_pnl_true == null ? null : Number(row.avg_pnl_true),
    sampleTrue: Number(row.sample_true),
    winRateFalse: row.win_rate_false == null ? null : Number(row.win_rate_false),
    avgPnlFalse: row.avg_pnl_false == null ? null : Number(row.avg_pnl_false),
    sampleFalse: Number(row.sample_false),
    computedAt: Number(row.computed_at),
  };
}

