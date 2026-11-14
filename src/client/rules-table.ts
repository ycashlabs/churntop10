import type { RuleView } from "../lib/api-types";

export const RULE_FILTERS = [
  "All",
  "Active",
  "Proven",
  "Experimenting",
  "Suggest approval",
  "Suggest retire",
  "Top scorers",
  "Losing money",
  "Recently triggered",
] as const;

export type RuleFilter = (typeof RULE_FILTERS)[number];

/** Points 0–100 are not built. These chips stay visible and do nothing. */
export const DISABLED_RULE_FILTERS: Partial<Record<RuleFilter, string>> = {
  "Suggest approval": "Points 0–100 are not built yet. Suggest approval needs a score above 70 for 2 weeks and at least 30 trades. You still decide; the app never auto-approves.",
  "Suggest retire": "Points 0–100 are not built yet. Suggest retire needs a score under 30. You still decide; the app never auto-retires.",
  "Top scorers": "Points 0–100 are not built yet, so there is no score to rank.",
};

export const POINTS_TITLE = "Points 0–100 are not built yet. Weights would be Profit 40%, Win rate 25%, Risk 20%, Confidence 15%.";
export const TREND_TITLE = "Daily score snapshots are not on this screen yet.";
export const CONFIDENCE_TITLE = "The Confidence points component is not built yet.";
export const RISK_TITLE = "Worst loss, the risk figure available today. The Risk points component is not built yet.";

export function ruleFilterEnabled(filter: RuleFilter): boolean {
  return DISABLED_RULE_FILTERS[filter] == null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function ruleSearchText(rule: RuleView): string {
  const side = rule.side === "buy" ? "buy rule" : "sell rule";
  const signals = rule.signals.length ? rule.signals.join(", ") : "uses settings percentages";
  return `${rule.name} v${rule.version} ${side} ${rule.status} ${signals} ${rule.body}`.toLowerCase();
}

export function filterRules(rules: RuleView[], filter: RuleFilter, query: string, now: number): RuleView[] {
  if (!ruleFilterEnabled(filter)) return rules;
  const needle = query.trim().toLowerCase();
  let rows = rules;
  if (needle) rows = rows.filter((rule) => ruleSearchText(rule).includes(needle));
  if (filter === "Active") return rows.filter((rule) => rule.status === "proven" || rule.status === "experimenting");
  if (filter === "Proven") return rows.filter((rule) => rule.status === "proven");
  if (filter === "Experimenting") return rows.filter((rule) => rule.status === "experimenting");
  if (filter === "Losing money") {
    return rows.filter((rule) => rule.scorecard.tradeCount > 0 && rule.scorecard.avgProfit != null && rule.scorecard.avgProfit < 0);
  }
  if (filter === "Recently triggered") {
    const cutoff = now - DAY_MS;
    return rows.filter((rule) => rule.lastTriggeredAt != null && rule.lastTriggeredAt >= cutoff);
  }
  return rows;
}

export function ruleSortValue(rule: RuleView, key: string): string | number | null {
  if (key === "name") return rule.name;
  if (key === "side") return rule.side === "buy" ? "Buy rule" : "Sell rule";
  if (key === "status") return rule.status;
  if (key === "profit") return rule.scorecard.avgProfit;
  if (key === "win") return rule.scorecard.winRate;
  if (key === "risk") return rule.scorecard.worstLoss;
  if (key === "trades") return rule.scorecard.tradeCount;
  if (key === "last") return rule.lastTriggeredAt;
  if (key === "signals") return rule.signals.join(", ");
  return null;
}
