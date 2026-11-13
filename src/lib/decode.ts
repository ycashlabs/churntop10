export interface Field<T> {
  status: "ok" | "unavailable" | "not_reported";
  value?: T;
}

function ok<T>(value: T): Field<T> {
  return { status: "ok", value };
}

function unavailable<T>(): Field<T> {
  return { status: "unavailable" };
}

function notReported<T>(): Field<T> {
  return { status: "not_reported" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function unwrapJsonString(value: unknown): unknown {
  let current = value;
  for (let i = 0; i < 3; i += 1) {
    if (typeof current !== "string") break;
    const parsed = parseEmbeddedJson(current);
    if (parsed === undefined) break;
    current = parsed;
  }
  return current;
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  const rest = trimmed.startsWith("```json")
    ? trimmed.slice(7)
    : trimmed.startsWith("```JSON")
      ? trimmed.slice(7)
      : trimmed.startsWith("```")
        ? trimmed.slice(3)
        : trimmed;
  return rest.trim().endsWith("```") ? rest.trim().slice(0, -3).trim() : rest.trim();
}

export function parseEmbeddedJson(text: string): unknown | undefined {
  const trimmed = stripFence(text);
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.search(/[{[]/);
    if (start < 0) return undefined;
    const close = trimmed[start] === "{" ? "}" : "]";
    const end = trimmed.lastIndexOf(close);
    if (end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    } catch {
      return undefined;
    }
  }
}

function jsonFromContent(node: unknown): unknown | undefined {
  if (!isRecord(node) || !Array.isArray(node.content)) return undefined;
  let first: unknown;
  for (const item of node.content) {
    if (!isRecord(item) || typeof item.text !== "string") continue;
    const parsed = parseEmbeddedJson(item.text);
    if (parsed === undefined) continue;
    const unwrapped = unwrapJsonString(parsed);
    if (first === undefined) first = unwrapped;
    if (accountItems(unwrapped).length > 0) return unwrapped;
  }
  return first;
}

function unwrapDataEnvelope(value: unknown): unknown {
  const unwrapped = unwrapJsonString(value);
  if (!isRecord(unwrapped) || !("data" in unwrapped)) return unwrapped;
  const data = unwrapped.data;
  if (!isRecord(data) && !Array.isArray(data)) return unwrapped;
  const keys = Object.keys(unwrapped);
  if (keys.every((key) => key === "data" || key === "guide")) return data;
  return unwrapped;
}

/** Pull the tool payload out of an MCP result. `{data, guide}` returns `data`. */
export function decodeToolPayload(value: unknown): unknown {
  const root = isRecord(value) && "result" in value ? value.result : value;
  let picked: unknown;
  if (isRecord(root) && "structuredContent" in root) {
    const structured = unwrapJsonString(root.structuredContent);
    const useful = Array.isArray(structured) || (isRecord(structured) && Object.keys(structured).length > 0);
    if (useful) {
      const fromText = jsonFromContent(root);
      if (accountItems(structured).length === 0 && fromText && accountItems(fromText).length > 0) {
        picked = fromText;
      } else {
        picked = structured;
      }
    } else {
      picked = jsonFromContent(root) ?? structured;
    }
  } else {
    picked = jsonFromContent(root) ?? unwrapJsonString(root);
  }
  return unwrapDataEnvelope(picked);
}

function looksLikeAccount(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const number = value.account_number ?? value.accountNumber ?? value.rhs_account_number;
  return typeof number === "string" && number.length > 0;
}

function accountItems(value: unknown): Record<string, unknown>[] {
  const unwrapped = unwrapJsonString(value);
  const direct = listOfAccounts(unwrapped);
  if (direct.length > 0) return direct;
  if (isRecord(unwrapped)) {
    for (const child of Object.values(unwrapped)) {
      const found = listOfAccounts(unwrapJsonString(child));
      if (found.length > 0) return found;
    }
  }
  return [];
}

function listOfAccounts(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(looksLikeAccount) as Record<string, unknown>[];
  if (!isRecord(value)) return [];
  for (const key of ["accounts", "results", "data"]) {
    const child = value[key];
    if (Array.isArray(child)) {
      const items = child.filter(looksLikeAccount) as Record<string, unknown>[];
      if (items.length > 0) return items;
    }
  }
  return looksLikeAccount(value) ? [value] : [];
}

function looseBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return undefined;
}

export interface RhAccount {
  accountNumber: string;
  rhsAccountNumber: string;
  brokerageAccountType: string;
  tradingType: string;
  nickname: Field<string>;
  optionLevel: Field<string>;
  agenticAllowed: boolean;
  unsettledFunds: Field<number>;
  isDefault: boolean;
}

export function parseAccounts(payload: unknown): RhAccount[] {
  const data = decodeToolPayload(payload);
  return accountItems(data).map((item) => {
    const accountNumber = String(item.account_number ?? item.accountNumber);
    const rhs = typeof item.rhs_account_number === "string" && item.rhs_account_number ? item.rhs_account_number : accountNumber;
    const unsettled = parseAmountField(item.unsettled_funds, true);
    return {
      accountNumber,
      rhsAccountNumber: rhs,
      brokerageAccountType: typeof item.brokerage_account_type === "string" ? item.brokerage_account_type : typeof item.type === "string" ? item.type : "",
      tradingType: typeof item.type === "string" ? item.type : "",
      nickname: typeof item.nickname === "string" && item.nickname ? ok(item.nickname) : notReported(),
      optionLevel: typeof item.option_level === "string" && item.option_level ? ok(item.option_level) : notReported(),
      agenticAllowed: looseBool(item.agentic_allowed ?? item.agenticAllowed) ?? false,
      unsettledFunds: unsettled,
      isDefault: item.is_default === true,
    };
  });
}

export function selectAgentic(accounts: RhAccount[]): RhAccount | undefined {
  return accounts.find((account) => account.agenticAllowed);
}

function parseAmountField(value: unknown, required: boolean): Field<number> {
  if (value === undefined || value === null || value === "") return required ? unavailable() : notReported();
  if (typeof value === "number" && Number.isFinite(value)) return ok(value);
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return ok(Number(value));
  return unavailable();
}

export interface PortfolioView {
  totalValue: Field<number>;
  cash: Field<number>;
  buyingPower: Field<number>;
  unleveragedBuyingPower: Field<number>;
  pendingDeposits: Field<number>;
  cryptoBuyingPower: Field<number>;
  equityValue: Field<number>;
  optionsValue: Field<number>;
  cryptoValue: Field<number>;
}

export function parsePortfolio(payload: unknown): PortfolioView {
  const data = decodeToolPayload(payload);
  const root = isRecord(data) && isRecord(data.portfolio) ? data.portfolio : isRecord(data) ? data : {};
  const buying = isRecord(root.buying_power) ? root.buying_power : {};
  const crypto = root.crypto_buying_power;
  return {
    totalValue: parseAmountField(root.total_value, true),
    cash: parseAmountField(root.cash, true),
    buyingPower: parseAmountField(buying.buying_power, true),
    unleveragedBuyingPower: parseAmountField(buying.unleveraged_buying_power, true),
    pendingDeposits: parseAmountField(root.pending_deposits, true),
    cryptoBuyingPower: crypto === undefined ? notReported() : parseAmountField(isRecord(crypto) ? crypto.buying_power : undefined, false),
    equityValue: parseAmountField(root.equity_value, true),
    optionsValue: parseAmountField(root.options_value, true),
    cryptoValue: parseAmountField(root.crypto_value, true),
  };
}

export interface PositionView {
  symbol: string;
  quantity: number;
  averageBuyPrice: Field<number>;
}

export function parsePositions(payload: unknown): { positions: PositionView[]; violated: boolean } {
  const data = decodeToolPayload(payload);
  const list = isRecord(data) && Array.isArray(data.positions) ? data.positions : [];
  let violated = false;
  const positions: PositionView[] = [];
  for (const item of list) {
    if (!isRecord(item) || typeof item.symbol !== "string") {
      violated = true;
      continue;
    }
    const quantity = parseAmountField(item.quantity, true);
    if (quantity.status !== "ok" || quantity.value === undefined || quantity.value <= 0) {
      violated = true;
      continue;
    }
    const average = item.average_buy_price === undefined ? notReported<number>() : parseAmountField(item.average_buy_price, false);
    positions.push({ symbol: item.symbol.toUpperCase(), quantity: quantity.value, averageBuyPrice: average });
  }
  return { positions, violated };
}

export interface QuoteView {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  asOf: string;
  tradable: boolean;
  hasBidAsk: boolean;
  previousClose: Field<number>;
}

function laterPrice(a: { price: number; time: string } | undefined, b: { price: number; time: string } | undefined): { price: number; time: string } | undefined {
  if (!a) return b;
  if (!b) return a;
  return a.time >= b.time ? a : b;
}

export function parseQuotes(payload: unknown): QuoteView[] {
  const data = decodeToolPayload(payload);
  const list = isRecord(data) && Array.isArray(data.results) ? data.results : Array.isArray(data) ? data : [];
  const quotes: QuoteView[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const quote = isRecord(item.quote) ? item.quote : item;
    if (typeof quote.symbol !== "string") continue;
    const lastTrade = parseAmountField(quote.last_trade_price, false);
    const lastExt = parseAmountField(quote.last_non_reg_trade_price, false);
    const chosen = laterPrice(
      lastTrade.status === "ok" && lastTrade.value !== undefined && typeof quote.venue_last_trade_time === "string"
        ? { price: lastTrade.value, time: quote.venue_last_trade_time }
        : lastTrade.status === "ok" && lastTrade.value !== undefined
          ? { price: lastTrade.value, time: "" }
          : undefined,
      lastExt.status === "ok" && lastExt.value !== undefined && typeof quote.venue_last_non_reg_trade_time === "string"
        ? { price: lastExt.value, time: quote.venue_last_non_reg_trade_time }
        : undefined,
    );
    if (!chosen) continue;
    const bidRaw = parseAmountField(quote.bid_price, false);
    const askRaw = parseAmountField(quote.ask_price, false);
    const hasBidAsk = bidRaw.status === "ok" && !!bidRaw.value && bidRaw.value > 0 && askRaw.status === "ok" && !!askRaw.value && askRaw.value > 0;
    const bid = hasBidAsk && bidRaw.value ? bidRaw.value : chosen.price;
    const ask = hasBidAsk && askRaw.value ? askRaw.value : chosen.price;
    const close = isRecord(item.close) ? parseAmountField(item.close.price, false) : notReported<number>();
    quotes.push({
      symbol: quote.symbol.toUpperCase(),
      bid,
      ask,
      last: chosen.price,
      asOf: chosen.time,
      tradable: quote.has_traded !== false && (quote.state === undefined || quote.state === "active"),
      hasBidAsk,
      previousClose: close.status === "ok" ? close : notReported(),
    });
  }
  return quotes;
}

export interface PnlView {
  totalReturns: Field<number>;
  totalRate: Field<number>;
  bucketGain: Field<number | null>;
}

export function parseRealizedPnl(payload: unknown): PnlView {
  const data = decodeToolPayload(payload);
  const root = isRecord(data) ? data : {};
  const point = Array.isArray(root.data_points) && isRecord(root.data_points[0]) ? root.data_points[0] : undefined;
  let bucket: Field<number | null> = notReported();
  if (point) {
    if (point.realized_gain === null) bucket = ok(null);
    else if (point.realized_gain === undefined) bucket = notReported();
    else bucket = parseAmountField(point.realized_gain, true);
  }
  return {
    totalReturns: parseAmountField(root.total_returns, true),
    totalRate: parseAmountField(root.total_rate_of_return, true),
    bucketGain: bucket,
  };
}

export function displayField(field: Field<number | string | null>, kind: "usd" | "text" | "pct" = "text"): string {
  if (field.status === "not_reported") return "Not reported";
  if (field.status === "unavailable" || field.value === undefined) return "Unavailable";
  if (field.value === null) return "n/a";
  if (typeof field.value === "number") {
    if (kind === "usd") {
      return field.value.toLocaleString("en-US", { style: "currency", currency: "USD" });
    }
    if (kind === "pct") return `${(field.value * 100).toFixed(2)}%`;
  }
  return String(field.value);
}
