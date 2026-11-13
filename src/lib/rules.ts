import { ADD_DIP_SIGNALS, ADD_STRENGTH_SIGNALS, EXIT_WEAKNESS_SIGNALS, FIRST_BUY_SIGNALS } from "./signals.js";

export type RuleStatus = "experimenting" | "proven" | "retired";
export type RuleSide = "buy" | "sell";

export interface RuleRecord {
  id: string;
  familyId: string;
  name: string;
  side: RuleSide;
  body: string;
  signals: string[];
  status: RuleStatus;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface RuleHistoryRow {
  id: string;
  ruleId: string;
  familyId: string;
  action: "created" | "edited" | "status" | "approved";
  fromStatus?: RuleStatus;
  toStatus?: RuleStatus;
  version: number;
  detail: string;
  at: number;
}

export interface Scorecard {
  familyId: string;
  tradeCount: number;
  winRate: number | null;
  avgProfit: number | null;
  worstLoss: number | null;
}

export interface DraftRuleSeed {
  familyId: string;
  name: string;
  side: RuleSide;
  body: string;
  signals: string[];
}

export const DRAFT_RULES: DraftRuleSeed[] = [
  {
    familyId: "buy-first-strength",
    name: "First buy on strength",
    side: "buy",
    body: "Start a position when price is above the 20-minute average, volume is above recent normal, and SPY is up. Size is the 20% starter (2% of account balance).",
    signals: FIRST_BUY_SIGNALS,
  },
  {
    familyId: "buy-add-strength",
    name: "Add on strength",
    side: "buy",
    body: "Add to an existing position when strength signals confirm. There is no fixed add count or size: stronger signals add more, weak signals add little or nothing, always inside the 10% cap.",
    signals: ADD_STRENGTH_SIGNALS,
  },
  {
    familyId: "buy-add-dip",
    name: "Add on a healthy dip",
    side: "buy",
    body: "Add when price is below average cost but still above the 20-minute low, there is no volume spike on the selling, and SPY is not falling hard.",
    signals: ADD_DIP_SIGNALS,
  },
  {
    familyId: "sell-take-profit",
    name: "Take profit",
    side: "sell",
    body: "Sell when price is the profit-target percent in Settings above average cost. That percent has no fixed 0.1–3 bound; you set any positive value up to 100. May fire before the position is full.",
    signals: [],
  },
  {
    familyId: "sell-stop-loss",
    name: "Stop-loss",
    side: "sell",
    body: "Sell when price is the stop-loss percent below average cost. Off-hours, the app watches the stop every 5 minutes and sends a limit sell. That is not a resting broker stop.",
    signals: [],
  },
  {
    familyId: "sell-exit-weakness",
    name: "Exit on weakness",
    side: "sell",
    body: "Sell when price is below the 20-minute average on rising volume while SPY is falling.",
    signals: EXIT_WEAKNESS_SIGNALS,
  },
];

export function scorecardFromTrades(familyId: string, pnls: number[]): Scorecard {
  if (pnls.length === 0) return { familyId, tradeCount: 0, winRate: null, avgProfit: null, worstLoss: null };
  const wins = pnls.filter((pnl) => pnl > 0).length;
  const losses = pnls.filter((pnl) => pnl < 0);
  const avg = pnls.reduce((sum, pnl) => sum + pnl, 0) / pnls.length;
  return {
    familyId,
    tradeCount: pnls.length,
    winRate: Math.round((wins / pnls.length) * 1000) / 1000,
    avgProfit: Math.round(avg * 100) / 100,
    worstLoss: losses.length === 0 ? 0 : Math.round(Math.min(...losses) * 100) / 100,
  };
}
