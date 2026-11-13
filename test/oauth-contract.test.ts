import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LOOPBACK_REDIRECT_URI,
  authorizationUrl,
  issuerMatches,
  parseAuthServerMetadata,
  parseCallbackInput,
  parseProtectedResource,
  parseRegistration,
  registrationBody,
  tokenForm,
} from "../src/lib/oauth.js";

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../docs/contracts/robinhood/oauth/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;
}

describe("Robinhood OAuth discovery contract (live 2026-11-13)", () => {
  it("maps protected resource metadata", () => {
    const parsed = parseProtectedResource(fixture("protected-resource.json"));
    expect(parsed).toEqual({ issuer: "https://agent.robinhood.com/mcp/trading", resource: "https://agent.robinhood.com/mcp/trading" });
  });

  it("rejects resource metadata without an authorization server or resource", () => {
    expect(() => parseProtectedResource({ resource: "https://agent.robinhood.com/mcp/trading" })).toThrow(/authorization server/);
    expect(() => parseProtectedResource({ authorization_servers: ["https://agent.robinhood.com/mcp/trading"] })).toThrow(/resource/);
  });

  it("maps authorization server metadata", () => {
    const meta = parseAuthServerMetadata(fixture("authorization-server.json"));
    expect(meta).toEqual({
      issuer: "https://agent.robinhood.com/mcp/trading",
      authorizationEndpoint: "https://robinhood.com/oauth",
      tokenEndpoint: "https://api.robinhood.com/oauth2/token/",
      registrationEndpoint: "https://agent.robinhood.com/oauth/trading/register",
      scope: "internal",
      issRequired: true,
    });
  });

  it("treats each required server field as required", () => {
    const base = fixture("authorization-server.json");
    for (const key of ["issuer", "authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
      const copy = { ...base };
      delete copy[key];
      expect(() => parseAuthServerMetadata(copy), key).toThrow(key);
    }
    expect(() => parseAuthServerMetadata({ ...base, code_challenge_methods_supported: ["plain"] })).toThrow(/S256/);
    expect(() => parseAuthServerMetadata({ ...base, token_endpoint: "http://api.robinhood.com/oauth2/token/" })).toThrow(/non-https/);
  });

  it("defaults optional server fields", () => {
    const base = fixture("authorization-server.json");
    const copy = { ...base };
    delete copy.scopes_supported;
    delete copy.authorization_response_iss_parameter_supported;
    const meta = parseAuthServerMetadata(copy);
    expect(meta.scope).toBe("internal");
    expect(meta.issRequired).toBe(false);
  });
});

describe("Robinhood dynamic registration contract", () => {
  it("sends the same body as Churn Capital with the loopback redirect", () => {
    expect(registrationBody(LOOPBACK_REDIRECT_URI)).toEqual({
      client_name: "Churn Top 10",
      redirect_uris: ["http://127.0.0.1:47621/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "internal",
    });
  });

  it("reads client_id and ignores the echoed redirect list", () => {
    expect(parseRegistration(fixture("registration-response.json"))).toEqual({ clientId: "LtLiNmbs9owbYfWgBlC68Z2VujIPuvGoAiSYr8xW" });
    const web = fixture("registration-response-https.json");
    // Robinhood echoes a web callback and returns the same shared client. The echo is not an allow-list entry.
    expect(parseRegistration(web).clientId).toBe(parseRegistration(fixture("registration-response.json")).clientId);
    expect(() => parseRegistration({ client_name: "Robinhood Trading" })).toThrow(/client id/);
  });

  it("uses a loopback redirect, never the web address", () => {
    const url = new URL(LOOPBACK_REDIRECT_URI);
    expect(url.protocol).toBe("http:");
    expect(url.hostname).toBe("127.0.0.1");
    expect(LOOPBACK_REDIRECT_URI).not.toContain("ycashlabs.com");
  });
});

describe("authorize request contract", () => {
  it("builds the authorize URL with PKCE, scope, resource, and the loopback redirect", () => {
    const meta = parseAuthServerMetadata(fixture("authorization-server.json"));
    const resource = parseProtectedResource(fixture("protected-resource.json")).resource;
    const location = new URL(authorizationUrl({
      authorizationEndpoint: meta.authorizationEndpoint,
      clientId: "LtLiNmbs9owbYfWgBlC68Z2VujIPuvGoAiSYr8xW",
      redirectUri: LOOPBACK_REDIRECT_URI,
      challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      resource,
      state: "state-1",
      scope: meta.scope,
    }));
    expect(location.origin + location.pathname).toBe("https://robinhood.com/oauth");
    expect(Object.fromEntries(location.searchParams)).toEqual({
      response_type: "code",
      client_id: "LtLiNmbs9owbYfWgBlC68Z2VujIPuvGoAiSYr8xW",
      redirect_uri: "http://127.0.0.1:47621/callback",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      scope: "internal",
      resource: "https://agent.robinhood.com/mcp/trading",
      state: "state-1",
    });
  });

  it("builds the token exchange with the same redirect and resource", () => {
    const form = new URLSearchParams(tokenForm("authorization_code", { code: "c", redirect_uri: LOOPBACK_REDIRECT_URI, client_id: "id", code_verifier: "v", resource: "https://agent.robinhood.com/mcp/trading" }));
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("redirect_uri")).toBe(LOOPBACK_REDIRECT_URI);
    expect(form.get("resource")).toBe("https://agent.robinhood.com/mcp/trading");
  });
});

describe("pasted callback contract", () => {
  const iss = "https://agent.robinhood.com/mcp/trading";

  it("reads code, state, and iss from the pasted loopback address", () => {
    const pasted = `${LOOPBACK_REDIRECT_URI}?code=abc123&state=s1&iss=${encodeURIComponent(iss)}`;
    expect(parseCallbackInput(`  ${pasted}\n`)).toEqual({ ok: true, code: "abc123", state: "s1", iss });
    expect(parseCallbackInput(`?code=abc123&state=s1`)).toEqual({ ok: true, code: "abc123", state: "s1", iss: undefined });
  });

  it("rejects other hosts, missing codes, and Robinhood errors", () => {
    expect(parseCallbackInput("https://evil.example.com/callback?code=a&state=b").ok).toBe(false);
    expect(parseCallbackInput(`${LOOPBACK_REDIRECT_URI}?state=b`).ok).toBe(false);
    const denied = parseCallbackInput(`${LOOPBACK_REDIRECT_URI}?error=access_denied&state=b`);
    expect(denied).toEqual({ ok: false, error: "Robinhood said: access_denied" });
    expect(parseCallbackInput("").ok).toBe(false);
  });

  it("requires a matching iss when the server says it sends one", () => {
    expect(issuerMatches(iss, iss, true)).toBe(true);
    expect(issuerMatches(`${iss}/`, iss, true)).toBe(true);
    expect(issuerMatches(undefined, iss, true)).toBe(false);
    expect(issuerMatches(undefined, iss, false)).toBe(true);
    expect(issuerMatches("https://evil.example.com", iss, false)).toBe(false);
  });
});
