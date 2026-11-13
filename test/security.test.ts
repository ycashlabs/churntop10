import { describe, expect, it } from "vitest";
import { nextBucket, recoveryPublicBody } from "../src/lib/rate.js";
import { accessDecision, verifyAccessJwt } from "../src/lib/access.js";
import { applySecurityHeaders, CONTENT_SECURITY_POLICY, hostCookie, securityHeaders, withHtmlNoStore } from "../src/lib/headers.js";
import { maskAccountNumber, redactJson } from "../src/lib/mask.js";

async function signedJwt(email: string, overrides: Record<string, unknown> = {}): Promise<{ token: string; jwk: JsonWebKey }> {
  const key = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", key.publicKey);
  const withKid: JsonWebKey & { kid?: string } = { ...jwk, kid: "test", alg: "RS256" };
  const header = b64(JSON.stringify({ alg: "RS256", kid: "test", typ: "JWT" }));
  const payload = b64(JSON.stringify({
    email,
    aud: "aud-1",
    iss: "https://ycashlabs.cloudflareaccess.com",
    exp: Math.floor(Date.now() / 1000) + 600,
    ...overrides,
  }));
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, data);
  let binary = "";
  for (const byte of new Uint8Array(sig)) binary += String.fromCharCode(byte);
  const signature = b64(binary);
  return { token: `${header}.${payload}.${signature}`, jwk: withKid };
}

function b64(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

describe("security headers and cookies", () => {
  it("sends a strict CSP and host-only cookies", async () => {
    const headers = securityHeaders();
    expect(headers["content-security-policy"]).toBe(CONTENT_SECURITY_POLICY);
    expect(headers["content-security-policy"]).not.toContain("unsafe-inline");
    expect(headers["x-frame-options"]).toBe("DENY");
    const response = applySecurityHeaders(new Response("ok", { headers: { "content-type": "text/html; charset=utf-8" } }));
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const cookie = hostCookie("__Host-session", "abc", 3600);
    expect(cookie.startsWith("__Host-session=")).toBe(true);
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie.toLowerCase()).not.toContain("domain=");
  });
});

describe("access", () => {
  it("rejects a missing token when enforcement is on and accepts the owner email", async () => {
    expect(accessDecision({ enforce: true, token: undefined, emailOk: false }).status).toBe(401);
    expect(accessDecision({ enforce: false, token: undefined, emailOk: false }).ok).toBe(true);
    const { token, jwk } = await signedJwt("tom2258@gmail.com");
    const claims = await verifyAccessJwt(token, [jwk], {
      audience: "aud-1",
      issuer: "https://ycashlabs.cloudflareaccess.com",
      email: "tom2258@gmail.com",
    });
    expect(claims.email).toBe("tom2258@gmail.com");
    await expect(verifyAccessJwt(token, [jwk], {
      audience: "aud-1",
      issuer: "https://ycashlabs.cloudflareaccess.com",
      email: "other@example.com",
    })).rejects.toThrow(/email/);
    const expired = await signedJwt("tom2258@gmail.com", { exp: 10 });
    await expect(verifyAccessJwt(expired.token, [expired.jwk], {
      audience: "aud-1",
      issuer: "https://ycashlabs.cloudflareaccess.com",
      email: "tom2258@gmail.com",
    })).rejects.toThrow(/expired/);
  });
});

describe("limits and recovery", () => {
  it("stops the next hit in the same window and never returns a recovery token", () => {
    const first = nextBucket({ hits: 0, windowStart: 0, now: 1_000, limit: 2, windowMs: 60_000 });
    const second = nextBucket({ hits: first.hits, windowStart: first.windowStart, now: 1_100, limit: 2, windowMs: 60_000 });
    const third = nextBucket({ hits: second.hits, windowStart: second.windowStart, now: 1_200, limit: 2, windowMs: 60_000 });
    expect(third.allow).toBe(false);
    const body = recoveryPublicBody("prod");
    expect(JSON.stringify(body)).not.toContain("token");
    expect(body.delivery).toBe("email");
    expect(recoveryPublicBody("dev").delivery).toBe("log");
  });
});

describe("masking", () => {
  it("masks account numbers and tokens in logs", () => {
    expect(maskAccountNumber("544784028")).toBe("••••4028");
    const logged = redactJson({
      account_number: "544784028",
      access_token: "super-secret-token",
      nested: { authorization: "Bearer super-secret-token" },
    });
    expect(logged).toContain("••••4028");
    expect(logged).not.toContain("544784028");
    expect(logged).not.toContain("super-secret-token");
    expect(logged).toContain("[redacted]");
  });
});

describe("html caching", () => {
  it("marks HTML no-store and leaves hashed assets alone", () => {
    const html = withHtmlNoStore(new Response("<!doctype html>", { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate", etag: "\"abc\"" } }));
    expect(html.headers.get("cache-control")).toContain("no-store");
    expect(html.headers.get("etag")).toBeNull();
    const js = withHtmlNoStore(new Response("x", { headers: { "content-type": "application/javascript", "cache-control": "public, max-age=31536000, immutable" } }));
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  });
});
