import type { RuleRecord, RuleHistoryRow, RuleSide, RuleStatus, Scorecard } from "./rules.js";
import type { SignalResult } from "./signals.js";

export type PositionMode = "live" | "sim";
export type PositionStatus = "open" | "closed";
export type PositionSource = "app" | "imported";
export type TradeSource = "app" | "broker_import" | "broker_qty_change" | "broker_close";
export type SignalStatus = "candidate" | "active" | "retired";

export interface PositionRecord {
  id: string;
  mode: PositionMode;
  symbol: string;
  status: PositionStatus;
  tradingCapitalSnapshot: number;
  profitTargetPct: number;
  stopLossPct: number;
  buyRuleVersionId?: string;
  sellRuleVersionId?: string;
  avgCost: number;
  qty: number;
  openedAt: number;
  closedAt?: number;
  source?: PositionSource;
}

export interface TradeRecord {
  id: string;
  positionId: string;
  ruleVersionId?: string;
  side: "buy" | "sell";
  qty: number;
  limitPrice?: number;
  fillPrice?: number;
  session: string;
  bidAtOrder?: number;
  askAtOrder?: number;
  capitalSnapshot: number;
  sizeReason: string;
  exitReason?: string;
  brokerOrderId?: string;
  status: string;
  createdAt: number;
  signals?: SignalResult[];
  source?: TradeSource;
}

export interface PriceMark {
  id: string;
  positionId: string;
  at: number;
  price: number;
}

export interface PositionReview {
  positionId: string;
  pnlDollars: number;
  pnlPct: number;
  holdMinutes: number;
  exitType: string;
  bestPrice?: number;
  worstPrice?: number;
  spyChangeAtEntry?: number;
  sessionAtEntry?: string;
  spreadCost?: number;
  addsCount: number;
  addsHelped?: boolean;
  botNote: string;
  userNote?: string;
  createdAt: number;
}

export interface ReviewListItem extends PositionReview {
  symbol: string;
  mode: PositionMode;
  qty: number;
  avgCost: number;
  openedAt: number;
  closedAt?: number;
  buyRuleName?: string;
  sellRuleName?: string;
}

export interface CapitalHistoryRow {
  id: string;
  positionId: string;
  oldValue: number;
  newValue: number;
  at: number;
}

export interface ExitSettingsHistoryRow {
  id: string;
  positionId: string;
  field: "profit_target_pct" | "stop_loss_pct";
  oldValue: number;
  newValue: number;
  at: number;
}

export interface RuleScoreSnapshot {
  id: string;
  periodStart: number;
  periodEnd: number;
  mode: PositionMode;
  ruleId?: string;
  ruleVersionId?: string;
  trades: number;
  winRate: number | null;
  avgPnlPct: number | null;
  worstLoss: number | null;
  netAfterCosts: number | null;
  computedAt: number;
}

export interface SignalScoreSnapshot {
  id: string;
  periodStart: number;
  periodEnd: number;
  mode: PositionMode;
  signalId: string;
  winRateTrue: number | null;
  avgPnlTrue: number | null;
  sampleTrue: number;
  winRateFalse: number | null;
  avgPnlFalse: number | null;
  sampleFalse: number;
  computedAt: number;
}

export interface AppSettings {
  profitTargetPct: number;
  stopLossPct: number;
  dailyLossPct: number;
  orderCap: number;
  tradingCapital: number;
  mode: "view_only" | "live";
  killed: boolean;
  dayStartEquity: number;
  dayStartDate: string;
  cash: number;
  accountNumber: string;
}

export interface ReviewFilters {
  ruleId?: string;
  symbol?: string;
  session?: string;
  from?: number;
  to?: number;
  mode?: PositionMode;
}

/**
 * All trading data goes through this interface so a Postgres backend can
 * replace the D1 implementation later by configuration.
 */
export interface Storage {
  getSettings(): Promise<AppSettings | undefined>;
  saveSettings(patch: Partial<AppSettings>): Promise<void>;

  listPositions(mode?: PositionMode, status?: PositionStatus): Promise<PositionRecord[]>;
  getPosition(id: string): Promise<PositionRecord | undefined>;
  upsertPosition(position: PositionRecord): Promise<void>;
  listTrades(positionId: string): Promise<TradeRecord[]>;
  insertTrade(trade: TradeRecord): Promise<void>;
  getTradeByBrokerOrderId(brokerOrderId: string): Promise<TradeRecord | undefined>;

  insertPriceMark(mark: PriceMark): Promise<void>;
  listPriceMarks(positionId: string): Promise<PriceMark[]>;

  insertReview(review: PositionReview): Promise<void>;
  updateReviewNote(positionId: string, userNote: string): Promise<void>;
  getReview(positionId: string): Promise<PositionReview | undefined>;
  listReviews(filters: ReviewFilters): Promise<ReviewListItem[]>;

  insertCapitalHistory(row: CapitalHistoryRow): Promise<void>;
  insertExitSettingsHistory(row: ExitSettingsHistoryRow): Promise<void>;

  seedSignals(): Promise<void>;
  listSignals(): Promise<Array<{ id: string; name: string; description: string; status: SignalStatus; addedAt: number }>>;

  currentRules(): Promise<RuleRecord[]>;
  listRuleVersions(): Promise<RuleRecord[]>;
  seedDraftRules(): Promise<void>;
  createRule(input: { name: string; side: RuleSide; body: string; signals: string[] }): Promise<RuleRecord>;
  editRule(id: string, input: { name?: string; body?: string; signals?: string[] }): Promise<RuleRecord>;
  setRuleStatus(id: string, status: RuleStatus): Promise<RuleRecord>;
  listRuleHistory(familyId: string): Promise<RuleHistoryRow[]>;
  ruleScorecards(rules: RuleRecord[]): Promise<Map<string, Scorecard>>;

  selectedRuleIds(): Promise<string[]>;
  setSelectedRuleIds(ids: string[]): Promise<void>;

  latestRuleScoreSnapshots(mode?: PositionMode): Promise<RuleScoreSnapshot[]>;
  latestSignalScoreSnapshots(mode?: PositionMode): Promise<SignalScoreSnapshot[]>;
  saveRuleScoreSnapshots(rows: RuleScoreSnapshot[]): Promise<void>;
  saveSignalScoreSnapshots(rows: SignalScoreSnapshot[]): Promise<void>;
  lastScoreSnapshotEnd(): Promise<number | undefined>;

  listTop10(): Promise<string[]>;
  saveBars(rows: Array<{ symbol: string; ts: number; price: number; volume: number }>): Promise<void>;
  listBars(): Promise<Array<{ symbol: string; ts: number; price: number; volume: number }>>;
  replaceWorkingOrders(rows: object[]): Promise<void>;
  listWorkingOrders(): Promise<Array<Record<string, unknown>>>;
  replaceProposals(rows: object[]): Promise<void>;
  listProposals(): Promise<Array<Record<string, unknown>>>;
}
