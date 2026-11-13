import { assertOutgoing } from "./requests.js";
import { isGatedTool } from "./oauth.js";

export class LiveTradingDisabled extends Error {
  readonly code = "live_trading_disabled";
  constructor() {
    super("live_trading_disabled");
    this.name = "LiveTradingDisabled";
  }
}

/**
 * The only order tools this function will forward are review and place.
 * Cancel and modify are not implemented. Kill switch and rollback never call them.
 * `ALLOW_LIVE_TRADING` must be the string "1" or this throws before `send`.
 */
export async function submitGatedTool(input: {
  allowLive: string | undefined;
  tool: string;
  args: unknown;
  send: (tool: string, args: unknown) => Promise<unknown>;
}): Promise<unknown> {
  if (input.tool === "cancel_equity_order" || input.tool.startsWith("cancel_") || input.tool.includes("modify")) {
    throw new LiveTradingDisabled();
  }
  if (input.tool !== "review_equity_order" && input.tool !== "place_equity_order") {
    throw new LiveTradingDisabled();
  }
  if (input.allowLive !== "1") throw new LiveTradingDisabled();
  if (!isGatedTool(input.tool)) throw new LiveTradingDisabled();
  assertOutgoing(input.tool, input.args);
  return input.send(input.tool, input.args);
}
