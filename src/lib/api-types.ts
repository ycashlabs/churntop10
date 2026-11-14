export interface Summary {
  mode: "view_only" | "live";
  killed: boolean;
  liveGate: boolean;
  session: string;
  clock: string;
  quoteSource: "recorded" | "robinhood";
  connected: boolean;
  /** not_connected: no saved Robinhood sign-in. connected: account read worked. error: signed in, but the read failed. */
  robinhoodStatus: "not_connected" | "connected" | "error";
  robinhoodError?: string;
  robinhood: null | {
    maskedAccount: string;
    nickname: string;
    brokerageType: string;
    tradingType: string;
    agentic: boolean;
    totalValue: string;
    cash: string;
    buyingPower: string;
    pendingDeposits: string;
    todayPnl: string;
    unsettled: string;
  };
  settings: { profitTargetPct: number; stopLossPct: number; dailyLossPct: number; orderCap: number; tradingCapital: number };
  tradingCapital?: TradingCapitalView;
  positions?: PositionView[];
  top10: Array<{ symbol: string; bid: string; ask: string; last: string; tradable: boolean }>;
}

export type AuthMethod = "passkey" | "totp" | "recovery";

export interface SessionView {
  authenticated: boolean;
  registered: boolean;
  email?: string;
  recovery?: boolean;
  stepUp?: boolean;
  totpEnabled?: boolean;
  authMethod?: AuthMethod;
}

export interface RuleView {
  id: string;
  familyId: string;
  name: string;
  side: "buy" | "sell";
  body: string;
  signals: string[];
  status: "experimenting" | "proven" | "retired";
  version: number;
  createdAt: number;
  updatedAt: number;
  scorecard: { tradeCount: number; winRate: number | null; avgProfit: number | null; worstLoss: number | null };
}

export interface RuleHistoryView {
  id: string;
  action: string;
  fromStatus?: string;
  toStatus?: string;
  version: number;
  detail: string;
  at: number;
}

export interface SimulatorView {
  cash: string;
  equity: string;
  dailyLoss: string;
  dailyLossCap: string;
  ordersToday: number;
  orderCap: number;
  killed: boolean;
  session: string;
  clock: string;
  quoteSource: "recorded" | "robinhood";
  selectedRuleIds: string[];
  tradingCapital?: TradingCapitalView;
  positions: PositionView[];
  orders: Array<{ symbol: string; side: string; type: string; quantity: string; status: string; role: string; price: string }>;
  trades: Array<{ symbol: string; quantity: string; entry: string; exit: string; pnl: string; reason: string; at: number }>;
  events: Array<{ action: string; detail: string; at?: number }>;
  proposals: Array<{ symbol: string; verdict: string; message: string; at: number }>;
}


export interface TradingCapitalView {
  saved: number;
  savedUsd: string;
  balance: number;
  balanceUsd: string;
  effective: number;
  effectiveUsd: string;
  warn: boolean;
  exposure: number;
  exposureUsd: string;
  paused: boolean;
  presets: Array<{ pct: number; dollars: number }>;
}

export interface PositionTradeSignalView {
  id: string;
  name: string;
  value: number | null;
  threshold: number | null;
  fired: boolean;
  reason: string;
}

export interface PositionTradeView {
  id: string;
  side: string;
  quantity: string;
  price: string;
  status: string;
  session: string;
  sizeReason: string;
  exitReason?: string;
  at: number;
  signals?: PositionTradeSignalView[];
}

export interface PositionView {
  id: string;
  symbol: string;
  mode: "live" | "sim";
  status: string;
  quantity: string;
  avgCost: string;
  last: string;
  marketValue: string;
  pnl: string;
  tradingCapital: string;
  profitTargetPct: number;
  stopLossPct: number;
  buyRule?: string;
  sellRule?: string;
  trades: PositionTradeView[];
}

export interface ReviewScreen {
  reviews: Array<{
    positionId: string;
    symbol: string;
    mode: "live" | "sim";
    closedAt: number;
    pnl: string;
    pnlPct: string;
    holdMinutes: number;
    exitType: string;
    session: string;
    addsCount: number;
    addsHelped?: boolean;
    botNote: string;
    userNote: string;
    buyRule?: string;
    sellRule?: string;
  }>;
  ruleScores: Array<{
    rule: string;
    mode: string;
    trades: number;
    winRate: number | null;
    avgPnlPct: number | null;
    worstLoss: number | null;
    netAfterCosts: number | null;
  }>;
  bestSignals: Array<{ name: string; id: string; winRate: number | null; avgPnl: number | null; sample: number }>;
  worstSignals: Array<{ name: string; id: string; winRate: number | null; avgPnl: number | null; sample: number }>;
}
