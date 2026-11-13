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
  settings: { profitTargetPct: number; stopLossPct: number; dailyLossPct: number; orderCap: number };
  top10: Array<{ symbol: string; bid: string; ask: string; last: string; tradable: boolean }>;
}

export interface SessionView {
  authenticated: boolean;
  registered: boolean;
  email?: string;
  recovery?: boolean;
  stepUp?: boolean;
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
  positions: Array<{ symbol: string; quantity: string; avgCost: string; last: string; marketValue: string; pnl: string; buyRule?: string; sellRule?: string }>;
  orders: Array<{ symbol: string; side: string; type: string; quantity: string; status: string; role: string; price: string }>;
  trades: Array<{ symbol: string; quantity: string; entry: string; exit: string; pnl: string; reason: string; at: number }>;
  events: Array<{ action: string; detail: string; at?: number }>;
  proposals: Array<{ symbol: string; verdict: string; message: string; at: number }>;
}
