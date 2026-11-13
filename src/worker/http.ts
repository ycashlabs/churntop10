import type { Context } from "hono";
import { verifyAccessJwt } from "../lib/access.js";
import { applySecurityHeaders, hostCookie } from "../lib/headers.js";
import { nextBucket, takeMemoryBucket } from "../lib/rate.js";
import { randomToken, sha256Hex } from "./crypto.js";
import type { Env } from "./env.js";

export type AppContext = Context<{ Bindings: Env }>;

export function clientIp(c: AppContext): string {
  return c.req.header("cf-connecting-ip") || "local";
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export function allowHost(env: Env, hostname: string): boolean {
  if (env.ENVIRONMENT === "prod") return hostname === "top10.ycashlabs.com";
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "top10-dev.ycashlabs.com";
}

export function rpFromUrl(url: URL): { origin: string; rpID: string } {
  if (url.hostname === "localhost") return { origin: url.origin, rpID: "localhost" };
  return { origin: url.origin, rpID: url.hostname };
}

const jwksCache = new Map<string, { keys: JsonWebKey[]; expires: number }>();

export async function enforceAccess(c: AppContext): Promise<Response | undefined> {
  if (c.env.ACCESS_ENFORCE !== "1") return undefined;
  if (!c.env.ACCESS_TEAM_DOMAIN || !c.env.ACCESS_AUD) {
    return c.json({ error: "Cloudflare Access is not configured." }, 503);
  }
  const token = c.req.header("cf-access-jwt-assertion");
  if (!token) return c.json({ error: "Sign in through Cloudflare Access." }, 401);
  const issuer = `https://${c.env.ACCESS_TEAM_DOMAIN}.cloudflareaccess.com`;
  try {
    const keys = await loadJwks(c.env.ACCESS_TEAM_DOMAIN);
    await verifyAccessJwt(token, keys, { audience: c.env.ACCESS_AUD, issuer, email: c.env.OWNER_EMAIL });
    return undefined;
  } catch {
    return c.json({ error: "Cloudflare Access rejected this request." }, 403);
  }
}

async function loadJwks(team: string): Promise<JsonWebKey[]> {
  const cached = jwksCache.get(team);
  if (cached && cached.expires > Date.now()) return cached.keys;
  const response = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error("jwks");
  const body = await response.json() as { keys?: JsonWebKey[] };
  const keys = body.keys ?? [];
  jwksCache.set(team, { keys, expires: Date.now() + 10 * 60 * 1000 });
  return keys;
}

export async function rateLimit(c: AppContext, bucket: string, limit: number, options?: { persist?: boolean }): Promise<Response | undefined> {
  const key = `${bucket}:${clientIp(c)}`;
  const now = Date.now();
  if (options?.persist === false) {
    const next = takeMemoryBucket(key, now, limit, 60_000);
    if (!next.allow) return c.json({ error: "Too many requests. Wait a minute and try again." }, 429);
    return undefined;
  }
  const row = await c.env.DB.prepare("SELECT hits, window_start FROM rate_limits WHERE key = ?").bind(key).first<{ hits: number; window_start: number }>();
  const next = nextBucket({ hits: row?.hits ?? 0, windowStart: row?.window_start ?? now, now, limit, windowMs: 60_000 });
  await c.env.DB.prepare("INSERT INTO rate_limits (key, hits, window_start) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET hits = excluded.hits, window_start = excluded.window_start").bind(key, next.hits, next.windowStart).run();
  if (!next.allow) return c.json({ error: "Too many requests. Wait a minute and try again." }, 429);
  return undefined;
}

export async function issueCsrf(c: AppContext): Promise<string> {
  const existing = readCookie(c.req.header("cookie"), "__Host-csrf");
  if (existing) return existing;
  const token = randomToken(32);
  setCookie(c, "__Host-csrf", token, 60 * 60 * 12);
  return token;
}

export function csrfOk(c: AppContext): boolean {
  const cookie = readCookie(c.req.header("cookie"), "__Host-csrf");
  const header = c.req.header("x-csrf-token");
  return !!cookie && !!header && cookie === header;
}

export function setCookie(c: AppContext, name: string, value: string, maxAge: number): void {
  c.header("set-cookie", hostCookie(name, encodeURIComponent(value), maxAge), { append: true });
}

export function clearCookie(c: AppContext, name: string): void {
  setCookie(c, name, "", 0);
}

export async function sessionToken(c: AppContext): Promise<{ ownerId: string; stepupUntil: number; recovery: boolean } | undefined> {
  const token = readCookie(c.req.header("cookie"), "__Host-session");
  if (!token) return undefined;
  const hash = await sha256Hex(token);
  const row = await c.env.DB.prepare("SELECT owner_id, expires_at, stepup_until, recovery FROM sessions WHERE token_hash = ?").bind(hash).first<{ owner_id: string; expires_at: number; stepup_until: number; recovery: number }>();
  if (!row || row.expires_at < Date.now()) return undefined;
  return { ownerId: row.owner_id, stepupUntil: row.stepup_until, recovery: row.recovery === 1 };
}

export async function startSession(c: AppContext, ownerId: string, recovery = false): Promise<void> {
  const token = randomToken(32);
  const hash = await sha256Hex(token);
  const expires = Date.now() + 12 * 60 * 60 * 1000;
  await c.env.DB.prepare("INSERT INTO sessions (token_hash, owner_id, expires_at, stepup_until, recovery) VALUES (?, ?, ?, 0, ?)").bind(hash, ownerId, expires, recovery ? 1 : 0).run();
  setCookie(c, "__Host-session", token, 12 * 60 * 60);
}

export function withSecurity(response: Response): Response {
  return applySecurityHeaders(response);
}

export function trader(c: AppContext) {
  const id = c.env.TRADER.idFromName("owner");
  return c.env.TRADER.get(id);
}
