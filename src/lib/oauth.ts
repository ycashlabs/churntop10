const MCP_URL = "https://agent.robinhood.com/mcp/trading";

export function tradingMcpUrl(): string {
  return MCP_URL;
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function generatePkce(): Promise<Pkce> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const verifier = bytesToBase64Url(bytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: bytesToBase64Url(new Uint8Array(digest)) };
}

export function metadataUrls(base: string, wellKnown: string): string[] {
  const trimmed = base.replace(/\/+$/, "");
  const scheme = trimmed.indexOf("://");
  if (scheme < 0) return [];
  const slash = trimmed.indexOf("/", scheme + 3);
  if (slash < 0) return [`${trimmed}/.well-known/${wellKnown}`];
  const origin = trimmed.slice(0, slash);
  const path = trimmed.slice(slash + 1);
  const urls: string[] = [];
  if (path) urls.push(`${origin}/.well-known/${wellKnown}/${path}`);
  const root = `${origin}/.well-known/${wellKnown}`;
  if (!urls.includes(root)) urls.push(root);
  return urls;
}

export function protectedResourceUrls(mcpUrl: string): string[] {
  return metadataUrls(mcpUrl, "oauth-protected-resource").slice(0, 1);
}

export function authorizationMetadataUrls(issuer: string): string[] {
  const urls = metadataUrls(issuer, "oauth-authorization-server");
  for (const url of metadataUrls(issuer, "openid-configuration")) {
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

export function resourceMetadataFromHeader(header: string): string | undefined {
  const lower = header.toLowerCase();
  const key = "resource_metadata=";
  const start = lower.indexOf(key);
  if (start < 0) return undefined;
  const rest = header.slice(start + key.length).trim();
  if (rest.startsWith('"')) {
    const end = rest.indexOf('"', 1);
    return end > 1 ? rest.slice(1, end) : undefined;
  }
  const token = rest.split(/[,\s]/)[0]?.trim();
  return token || undefined;
}

/**
 * Robinhood's shared public client only accepts loopback redirects (RFC 8252).
 * Registration echoes any redirect_uris but does not allow-list them, so a web
 * callback such as https://top10-dev.ycashlabs.com/api/robinhood/callback is
 * refused on robinhood.com. Nothing listens on this port: the user pastes the
 * address the browser lands on back into the app.
 */
export const LOOPBACK_REDIRECT_URI = "http://127.0.0.1:47621/callback";

export interface AuthServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  scope: string;
  issRequired: boolean;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Robinhood sign-in metadata is missing ${key}.`);
  return value.trim();
}

function httpsUrl(value: string, key: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Robinhood sign-in metadata has an invalid ${key}.`);
  }
  if (parsed.protocol !== "https:") throw new Error(`Robinhood sign-in metadata has a non-https ${key}.`);
  return value;
}

export function parseProtectedResource(value: unknown): { issuer: string; resource: string } {
  if (!value || typeof value !== "object") throw new Error("Robinhood resource metadata was not an object.");
  const record = value as Record<string, unknown>;
  const servers = record.authorization_servers;
  const first = Array.isArray(servers) && typeof servers[0] === "string" ? servers[0].trim() : "";
  if (!first) throw new Error("Robinhood did not publish an authorization server.");
  return { issuer: httpsUrl(first.replace(/\/+$/, ""), "authorization_servers"), resource: httpsUrl(requiredString(record, "resource"), "resource") };
}

export function parseAuthServerMetadata(value: unknown): AuthServerMetadata {
  if (!value || typeof value !== "object") throw new Error("Robinhood sign-in metadata was not an object.");
  const record = value as Record<string, unknown>;
  const methods = record.code_challenge_methods_supported;
  if (!Array.isArray(methods) || !methods.includes("S256")) throw new Error("Robinhood sign-in does not list PKCE S256.");
  const scopes = Array.isArray(record.scopes_supported) ? record.scopes_supported.filter((item): item is string => typeof item === "string" && !!item) : [];
  return {
    issuer: httpsUrl(requiredString(record, "issuer"), "issuer").replace(/\/+$/, ""),
    authorizationEndpoint: httpsUrl(requiredString(record, "authorization_endpoint"), "authorization_endpoint"),
    tokenEndpoint: httpsUrl(requiredString(record, "token_endpoint"), "token_endpoint"),
    registrationEndpoint: httpsUrl(requiredString(record, "registration_endpoint"), "registration_endpoint"),
    scope: scopes[0] ?? "internal",
    issRequired: record.authorization_response_iss_parameter_supported === true,
  };
}

export function parseRegistration(value: unknown): { clientId: string } {
  if (!value || typeof value !== "object") throw new Error("Robinhood registration did not return an object.");
  const clientId = (value as Record<string, unknown>).client_id;
  if (typeof clientId !== "string" || !clientId.trim()) throw new Error("Robinhood did not return a client id.");
  return { clientId: clientId.trim() };
}

export type CallbackInput =
  | { ok: true; code: string; state: string; iss?: string }
  | { ok: false; error: string };

/** Reads the loopback address the user pasted (full URL, or just the query string). */
export function parseCallbackInput(text: string): CallbackInput {
  const trimmed = (text ?? "").trim();
  if (!trimmed || trimmed.length > 4096) return { ok: false, error: "Paste the full address from the page Robinhood sent you to." };
  let params: URLSearchParams;
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return { ok: false, error: "That address could not be read. Copy the whole address bar and try again." };
    }
    const expected = new URL(LOOPBACK_REDIRECT_URI);
    if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
      return { ok: false, error: `That is not the Robinhood return address. It should start with ${LOOPBACK_REDIRECT_URI}.` };
    }
    params = url.searchParams;
  } else {
    params = new URLSearchParams(trimmed.replace(/^[?#]/, ""));
  }
  const error = params.get("error");
  if (error) {
    const detail = params.get("error_description");
    return { ok: false, error: `Robinhood said: ${detail ? `${error} (${detail.slice(0, 200)})` : error}` };
  }
  const code = params.get("code")?.trim();
  const state = params.get("state")?.trim();
  if (!code || !state) return { ok: false, error: "That address has no sign-in code. Approve on Robinhood first, then copy the address." };
  const iss = params.get("iss")?.trim() || undefined;
  return { ok: true, code, state, iss };
}

export function issuerMatches(iss: string | undefined, issuer: string, required: boolean): boolean {
  if (!iss) return !required;
  return iss.replace(/\/+$/, "") === issuer.replace(/\/+$/, "");
}

export function registrationBody(redirectUri: string): Record<string, unknown> {
  return {
    client_name: "Churn Top 10",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    scope: "internal",
  };
}

export function authorizationUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  resource: string;
  state: string;
  scope?: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    scope: input.scope ?? "internal",
    resource: input.resource,
    state: input.state,
  });
  return `${input.authorizationEndpoint}?${params.toString()}`;
}

export function tokenForm(grant: string, fields: Record<string, string>): string {
  const params = new URLSearchParams({ grant_type: grant });
  for (const [key, value] of Object.entries(fields)) params.set(key, value);
  return params.toString();
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  lifetimeSecs?: number;
}

export function tokenSetFromJson(value: unknown, now = Date.now()): TokenSet | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const accessToken = typeof record.access_token === "string" ? record.access_token : "";
  if (!accessToken) return undefined;
  const refresh = typeof record.refresh_token === "string" && record.refresh_token ? record.refresh_token : undefined;
  const lifetime = expiresInSecs(record.expires_in);
  const expiresAt = lifetime ? new Date(now + lifetime * 1000).toISOString() : undefined;
  return { accessToken, refreshToken: refresh, expiresAt, lifetimeSecs: lifetime };
}

function expiresInSecs(value: unknown): number | undefined {
  if (typeof value === "number" && value > 0) return Math.floor(value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (parsed > 0) return Math.floor(parsed);
  }
  return undefined;
}

export function refreshLeadSecs(lifetimeSecs: number): number {
  return Math.min(60, Math.max(1, Math.floor(lifetimeSecs / 10)));
}

export function refreshDue(expiresAt: string | undefined, lifetimeSecs: number | undefined, now = Date.now()): boolean {
  if (!expiresAt) return false;
  const expiry = Date.parse(expiresAt);
  if (Number.isNaN(expiry)) return false;
  const lead = refreshLeadSecs(lifetimeSecs ?? 3600) * 1000;
  return now + lead >= expiry;
}

export function refreshWasRejected(status: number, body: string): boolean {
  const lower = body.toLowerCase();
  return status === 400 || status === 401 || lower.includes("invalid_grant") || lower.includes("invalid_token");
}

export const READ_TOOLS = [
  "get_accounts",
  "get_portfolio",
  "get_equity_positions",
  "get_equity_quotes",
  "get_equity_orders",
  "get_equity_tradability",
  "get_realized_pnl",
  "get_pnl_trade_history",
] as const;

export const GATED_TOOLS = ["review_equity_order", "place_equity_order", "cancel_equity_order"] as const;

export function isGatedTool(name: string): boolean {
  return (GATED_TOOLS as readonly string[]).includes(name);
}
