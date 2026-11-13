export interface Summary {
  mode: "view_only" | "live";
  killed: boolean;
  liveGate: boolean;
  session: string;
  clock: string;
  quoteSource: "recorded" | "robinhood";
  connected: boolean;
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
  simulator: {
    maskedAccount: string;
    cash: string;
    equity: string;
    dailyLoss: string;
    dailyLossCap: string;
    dayTrades: number;
    pdtLimit: number;
    positions: Array<{ symbol: string; quantity: string; avgCost: string; last: string; marketValue: string; pnl: string }>;
    orders: Array<{ symbol: string; side: string; type: string; quantity: string; status: string; role: string; price: string }>;
  };
  settings: { profitTargetPct: number; stopLossPct: number; maxOrderPct: number; dailyLossPct: number };
  top10: Array<{ symbol: string; bid: string; ask: string; last: string; tradable: boolean }>;
  proposals: Array<{ symbol: string; verdict: string; message: string; at: number }>;
}

export interface SessionView {
  authenticated: boolean;
  registered: boolean;
  email?: string;
  recovery?: boolean;
  stepUp?: boolean;
}
