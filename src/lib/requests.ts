import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import getAccounts from "../../docs/contracts/robinhood/schemas/get_accounts.json" with { type: "json" };
import getPortfolio from "../../docs/contracts/robinhood/schemas/get_portfolio.json" with { type: "json" };
import getPositions from "../../docs/contracts/robinhood/schemas/get_equity_positions.json" with { type: "json" };
import getQuotes from "../../docs/contracts/robinhood/schemas/get_equity_quotes.json" with { type: "json" };
import getOrders from "../../docs/contracts/robinhood/schemas/get_equity_orders.json" with { type: "json" };
import getTradability from "../../docs/contracts/robinhood/schemas/get_equity_tradability.json" with { type: "json" };
import getPnl from "../../docs/contracts/robinhood/schemas/get_realized_pnl.json" with { type: "json" };
import getTrades from "../../docs/contracts/robinhood/schemas/get_pnl_trade_history.json" with { type: "json" };
import reviewOrder from "../../docs/contracts/robinhood/schemas/review_equity_order.json" with { type: "json" };
import placeOrder from "../../docs/contracts/robinhood/schemas/place_equity_order.json" with { type: "json" };
import cancelOrder from "../../docs/contracts/robinhood/schemas/cancel_equity_order.json" with { type: "json" };

const SCHEMAS: Record<string, object> = {
  get_accounts: getAccounts,
  get_portfolio: getPortfolio,
  get_equity_positions: getPositions,
  get_equity_quotes: getQuotes,
  get_equity_orders: getOrders,
  get_equity_tradability: getTradability,
  get_realized_pnl: getPnl,
  get_pnl_trade_history: getTrades,
  review_equity_order: reviewOrder,
  place_equity_order: placeOrder,
  cancel_equity_order: cancelOrder,
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new Map<string, ValidateFunction>();

function validatorFor(tool: string): ValidateFunction {
  const existing = validators.get(tool);
  if (existing) return existing;
  const schema = SCHEMAS[tool];
  if (!schema) throw new Error(`no schema for ${tool}`);
  const compiled = ajv.compile(schema);
  validators.set(tool, compiled);
  return compiled;
}

export function knownTools(): string[] {
  return Object.keys(SCHEMAS);
}

export function validateOutgoing(tool: string, args: unknown): { ok: true } | { ok: false; errors: string } {
  if (!SCHEMAS[tool]) return { ok: false, errors: `unknown tool ${tool}` };
  const validate = validatorFor(tool);
  if (validate(args)) return { ok: true };
  return { ok: false, errors: formatErrors(validate.errors) };
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return "invalid request";
  return errors.map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`).join("; ");
}

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

export function assertOutgoing(tool: string, args: unknown): void {
  const result = validateOutgoing(tool, args);
  if (!result.ok) throw new ContractError(`${tool} ${result.errors}`);
}
