import { Hono } from "hono";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Summary } from "../lib/api-types.js";
import { securityHeaders } from "../lib/headers.js";
import { recoveryPublicBody } from "../lib/rate.js";
import {
  authorizationMetadataUrls,
  authorizationUrl,
  generatePkce,
  protectedResourceUrls,
  registrationBody,
  resourceMetadataFromHeader,
  tokenSetFromJson,
  tradingMcpUrl,
} from "../lib/oauth.js";
import { redactJson } from "../lib/mask.js";
import { base64ToBytes, bytesToBase64, encryptString, importTokenKey, randomToken, sha256Hex } from "./crypto.js";
import type { Env } from "./env.js";
import { allowHost, clearCookie, csrfOk, enforceAccess, issueCsrf, rateLimit, readCookie, rpFromUrl, sessionToken, startSession, trader, type AppContext } from "./http.js";
import { AccountTrader } from "./trader.js";

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (!allowHost(c.env, url.hostname)) return c.json({ error: "Unknown host." }, 404);
  await next();
  for (const [key, value] of Object.entries(securityHeaders())) c.header(key, value);
  c.header("strict-transport-security", "max-age=31536000; includeSubDomains");
});

app.use("/api/*", async (c, next) => {
  const denied = await enforceAccess(c);
  if (denied) return denied;
  if (c.req.method === "POST" && !csrfOk(c)) {
    const minted = await issueCsrf(c);
    if (c.req.path === "/api/csrf") return c.json({ csrfToken: minted });
    return c.json({ error: "Refresh the page and try again." }, 403);
  }
  await next();
});

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/csrf", async (c) => c.json({ csrfToken: await issueCsrf(c) }));

app.get("/api/session", async (c) => {
  const limited = await rateLimit(c, "session", 60);
  if (limited) return limited;
  await issueCsrf(c);
  const registered = await c.env.DB.prepare("SELECT id FROM credentials LIMIT 1").first();
  const session = await sessionToken(c);
  if (!session) return c.json({ authenticated: false, registered: !!registered });
  return c.json({
    authenticated: true,
    registered: true,
    email: c.env.OWNER_EMAIL,
    recovery: session.recovery,
    stepUp: session.stepupUntil > Date.now(),
  });
});

app.post("/api/auth/register/options", async (c) => {
  const limited = await rateLimit(c, "auth", 10);
  if (limited) return limited;
  const existing = await c.env.DB.prepare("SELECT id FROM credentials LIMIT 1").first();
  const session = await sessionToken(c);
  if (existing && !session?.recovery) return c.json({ error: "A passkey is already registered. Use recovery to replace it." }, 403);
  const { rpID } = rpFromUrl(new URL(c.req.url));
  const ownerId = session?.ownerId ?? crypto.randomUUID();
  const options = await generateRegistrationOptions({
    rpName: "Churn Top 10",
    rpID,
    userName: c.env.OWNER_EMAIL,
    userID: new TextEncoder().encode(ownerId),
    userDisplayName: "Owner",
    attestationType: "none",
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  await c.env.DB.prepare("INSERT INTO challenges (id, kind, challenge, expires_at) VALUES (?, 'register', ?, ?) ON CONFLICT(id) DO UPDATE SET challenge = excluded.challenge, expires_at = excluded.expires_at, kind = 'register'").bind(ownerId, options.challenge, Date.now() + 5 * 60 * 1000).run();
  return c.json({ options, ownerId });
});

app.post("/api/auth/register/verify", async (c) => {
  const limited = await rateLimit(c, "auth", 10);
  if (limited) return limited;
  const body = await c.req.json<{ ownerId?: string; response?: RegistrationResponseJSON }>();
  if (!body.ownerId || !body.response) return c.json({ error: "Missing passkey response." }, 400);
  const challenge = await c.env.DB.prepare("SELECT challenge, expires_at FROM challenges WHERE id = ? AND kind = 'register'").bind(body.ownerId).first<{ challenge: string; expires_at: number }>();
  if (!challenge || challenge.expires_at < Date.now()) return c.json({ error: "Registration expired. Start again." }, 400);
  const { origin, rpID } = rpFromUrl(new URL(c.req.url));
  let verified;
  try {
    verified = await verifyRegistrationResponse({ response: body.response, expectedChallenge: challenge.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
  } catch {
    return c.json({ error: "Passkey was not accepted." }, 401);
  }
  if (!verified.verified || !verified.registrationInfo) return c.json({ error: "Passkey was not accepted." }, 401);
  const existing = await c.env.DB.prepare("SELECT id FROM credentials LIMIT 1").first();
  const session = await sessionToken(c);
  if (existing && !session?.recovery) return c.json({ error: "A passkey is already registered." }, 403);
  const cred = verified.registrationInfo.credential;
  await c.env.DB.prepare("INSERT INTO owner (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING").bind(body.ownerId, c.env.OWNER_EMAIL, Date.now()).run();
  if (session?.recovery) await c.env.DB.prepare("DELETE FROM credentials").run();
  await c.env.DB.prepare("INSERT INTO credentials (id, owner_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(cred.id, body.ownerId, bytesToBase64(cred.publicKey), cred.counter, (cred.transports ?? []).join(","), Date.now()).run();
  await c.env.DB.prepare("DELETE FROM challenges WHERE id = ?").bind(body.ownerId).run();
  if (session) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(readCookie(c.req.header("cookie"), "__Host-session") ?? "")).run();
  await startSession(c, body.ownerId, false);
  return c.json({ ok: true });
});

app.post("/api/auth/login/options", async (c) => {
  const limited = await rateLimit(c, "auth", 10);
  if (limited) return limited;
  const { rpID } = rpFromUrl(new URL(c.req.url));
  const options = await generateAuthenticationOptions({ rpID, userVerification: "required" });
  const id = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO challenges (id, kind, challenge, expires_at) VALUES (?, 'login', ?, ?)").bind(id, options.challenge, Date.now() + 5 * 60 * 1000).run();
  return c.json({ options, challengeId: id });
});

app.post("/api/auth/login/verify", async (c) => {
  const limited = await rateLimit(c, "auth", 10);
  if (limited) return limited;
  const body = await c.req.json<{ challengeId?: string; response?: AuthenticationResponseJSON; stepUp?: boolean }>();
  if (!body.challengeId || !body.response) return c.json({ error: "Missing passkey response." }, 400);
  const challenge = await c.env.DB.prepare("SELECT challenge, expires_at FROM challenges WHERE id = ? AND kind = 'login'").bind(body.challengeId).first<{ challenge: string; expires_at: number }>();
  if (!challenge || challenge.expires_at < Date.now()) return c.json({ error: "Sign-in expired. Start again." }, 400);
  const credential = await c.env.DB.prepare("SELECT id, owner_id, public_key, counter FROM credentials WHERE id = ?").bind(body.response.id).first<{ id: string; owner_id: string; public_key: string; counter: number }>();
  if (!credential) return c.json({ error: "Unknown passkey." }, 401);
  const { origin, rpID } = rpFromUrl(new URL(c.req.url));
  let verified;
  try {
    verified = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: { id: credential.id, publicKey: base64ToBytes(credential.public_key), counter: credential.counter },
    });
  } catch {
    return c.json({ error: "Passkey was not accepted." }, 401);
  }
  if (!verified.verified) return c.json({ error: "Passkey was not accepted." }, 401);
  await c.env.DB.prepare("UPDATE credentials SET counter = ? WHERE id = ?").bind(verified.authenticationInfo.newCounter, credential.id).run();
  await c.env.DB.prepare("DELETE FROM challenges WHERE id = ?").bind(body.challengeId).run();
  if (body.stepUp) {
    const session = await sessionToken(c);
    if (!session || session.ownerId !== credential.owner_id) return c.json({ error: "Sign in first." }, 401);
    const hash = await sha256Hex(readCookie(c.req.header("cookie"), "__Host-session") ?? "");
    await c.env.DB.prepare("UPDATE sessions SET stepup_until = ? WHERE token_hash = ?").bind(Date.now() + 5 * 60 * 1000, hash).run();
    return c.json({ ok: true, stepUp: true });
  }
  await startSession(c, credential.owner_id, false);
  return c.json({ ok: true });
});

app.post("/api/auth/logout", async (c) => {
  const token = readCookie(c.req.header("cookie"), "__Host-session");
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  clearCookie(c, "__Host-session");
  return c.json({ ok: true });
});

app.post("/api/auth/recovery", async (c) => {
  const limited = await rateLimit(c, "auth", 5);
  if (limited) return limited;
  const body = await c.req.json<{ email?: string }>().catch(() => ({ email: "" }));
  const email = (body.email ?? "").trim().toLowerCase();
  if (email === c.env.OWNER_EMAIL.toLowerCase()) {
    const token = randomToken(32);
    await c.env.DB.prepare("INSERT INTO magic_links (token_hash, email, expires_at) VALUES (?, ?, ?)").bind(await sha256Hex(token), email, Date.now() + 15 * 60 * 1000).run();
    const local = new URL(c.req.url).hostname === "localhost";
    if (local) console.log(`dev recovery token ${token}`);
    await c.env.DB.prepare("INSERT INTO audit_index (id, at, action, detail) VALUES (?, ?, 'recovery', ?)").bind(crypto.randomUUID(), Date.now(), redactJson({ email: "owner" })).run();
    return c.json(recoveryPublicBody(local ? "dev" : "prod"));
  }
  return c.json(recoveryPublicBody("prod"));
});

app.get("/api/auth/recovery/consume", async (c) => {
  const token = c.req.query("token") ?? "";
  const row = await c.env.DB.prepare("SELECT email, expires_at, used_at FROM magic_links WHERE token_hash = ?").bind(await sha256Hex(token)).first<{ email: string; expires_at: number; used_at: number | null }>();
  if (!row || row.used_at || row.expires_at < Date.now() || row.email !== c.env.OWNER_EMAIL.toLowerCase()) {
    return c.redirect("/?recovery=invalid");
  }
  await c.env.DB.prepare("UPDATE magic_links SET used_at = ? WHERE token_hash = ?").bind(Date.now(), await sha256Hex(token)).run();
  let owner = await c.env.DB.prepare("SELECT id FROM owner LIMIT 1").first<{ id: string }>();
  if (!owner) {
    const id = crypto.randomUUID();
    await c.env.DB.prepare("INSERT INTO owner (id, email, created_at) VALUES (?, ?, ?)").bind(id, c.env.OWNER_EMAIL, Date.now()).run();
    owner = { id };
  }
  await startSession(c, owner.id, true);
  return c.redirect("/?recovery=1");
});

app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth") || c.req.path === "/api/health" || c.req.path === "/api/csrf" || c.req.path === "/api/session" || c.req.path.startsWith("/api/robinhood/callback")) {
    await next();
    return;
  }
  const session = await sessionToken(c);
  if (!session || session.recovery) return c.json({ error: "Sign in with your passkey." }, 401);
  await next();
});

app.get("/api/summary", async (c) => {
  const limited = await rateLimit(c, "read", 120);
  if (limited) return limited;
  return c.json(await callTrader(c, "summary"));
});

app.post("/api/cycle", async (c) => {
  const limited = await rateLimit(c, "trade", 20);
  if (limited) return limited;
  return c.json(await callTrader(c, "cycle"));
});

app.post("/api/kill", async (c) => {
  const limited = await rateLimit(c, "trade", 20);
  if (limited) return limited;
  return c.json(await callTrader(c, "kill"));
});

app.post("/api/resume", async (c) => {
  const limited = await rateLimit(c, "trade", 20);
  if (limited) return limited;
  return c.json(await callTrader(c, "resume"));
});

app.post("/api/mode", async (c) => {
  const body = await c.req.json<{ mode?: "view_only" | "live" }>();
  if (body.mode === "live") {
    const stepped = await requireStepUp(c);
    if (stepped) return stepped;
  }
  if (body.mode !== "view_only" && body.mode !== "live") return c.json({ error: "Unknown mode." }, 400);
  return c.json(await callTrader(c, "setMode", body.mode));
});

app.post("/api/settings", async (c) => {
  const stepped = await requireStepUp(c);
  if (stepped) return stepped;
  const body = await c.req.json<{ profitTargetPct?: number; stopLossPct?: number; maxOrderPct?: number; dailyLossPct?: number }>();
  try {
    return c.json(await callTrader(c, "saveSettings", {
      profitTargetPct: Number(body.profitTargetPct),
      stopLossPct: Number(body.stopLossPct),
      maxOrderPct: Number(body.maxOrderPct),
      dailyLossPct: Number(body.dailyLossPct),
    }));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Could not save settings." }, 400);
  }
});

app.post("/api/top10", async (c) => {
  const stepped = await requireStepUp(c);
  if (stepped) return stepped;
  const body = await c.req.json<{ symbols?: string[] }>();
  try {
    return c.json(await callTrader(c, "saveTop10", body.symbols ?? []));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Could not save the Top 10." }, 400);
  }
});

app.post("/api/robinhood/connect", async (c) => {
  const stepped = await requireStepUp(c);
  if (stepped) return stepped;
  if (!c.env.TOKEN_KEY) return c.json({ error: "TOKEN_KEY is not configured." }, 503);
  const url = new URL(c.req.url);
  const redirectUri = `${url.origin}/api/robinhood/callback`;
  try {
    const discovered = await discover(tradingMcpUrl());
    const clientId = await registerOrLoad(c, discovered, redirectUri);
    const pkce = await generatePkce();
    const state = randomToken(16);
    await c.env.DB.prepare("INSERT INTO oauth_state (state, verifier, redirect_uri, expires_at) VALUES (?, ?, ?, ?)").bind(state, pkce.verifier, redirectUri, Date.now() + 10 * 60 * 1000).run();
    const location = authorizationUrl({
      authorizationEndpoint: discovered.authorizationEndpoint,
      clientId,
      redirectUri,
      challenge: pkce.challenge,
      resource: tradingMcpUrl(),
      state,
      scope: discovered.scope,
    });
    return c.json({ url: location });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Robinhood sign-in could not start." }, 502);
  }
});

app.get("/api/robinhood/callback", async (c) => {
  const url = new URL(c.req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  if (oauthError || !code || !state) return c.redirect("/?robinhood=failed");
  const saved = await c.env.DB.prepare("SELECT verifier, redirect_uri, expires_at FROM oauth_state WHERE state = ?").bind(state).first<{ verifier: string; redirect_uri: string; expires_at: number }>();
  await c.env.DB.prepare("DELETE FROM oauth_state WHERE state = ?").bind(state).run();
  if (!saved || saved.expires_at < Date.now() || !c.env.TOKEN_KEY) return c.redirect("/?robinhood=failed");
  const client = await c.env.DB.prepare("SELECT client_id, token_endpoint, issuer, resource FROM rh_client WHERE id = 1").first<{ client_id: string; token_endpoint: string; issuer: string; resource: string }>();
  if (!client) return c.redirect("/?robinhood=failed");
  const iss = url.searchParams.get("iss");
  if (iss && iss.replace(/\/+$/, "") !== client.issuer.replace(/\/+$/, "")) return c.redirect("/?robinhood=failed");
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: saved.redirect_uri, client_id: client.client_id, code_verifier: saved.verifier, resource: client.resource });
  const response = await fetch(client.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
  if (!response.ok) return c.redirect("/?robinhood=failed");
  const tokens = tokenSetFromJson(await response.json());
  if (!tokens) return c.redirect("/?robinhood=failed");
  const key = await importTokenKey(c.env.TOKEN_KEY);
  const access = await encryptString(key, tokens.accessToken);
  const refresh = tokens.refreshToken ? await encryptString(key, tokens.refreshToken) : undefined;
  await c.env.DB.prepare("INSERT INTO rh_tokens (id, access_ct, access_iv, refresh_ct, refresh_iv, expires_at, lifetime_secs) VALUES (1, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET access_ct = excluded.access_ct, access_iv = excluded.access_iv, refresh_ct = excluded.refresh_ct, refresh_iv = excluded.refresh_iv, expires_at = excluded.expires_at, lifetime_secs = excluded.lifetime_secs").bind(access.ct, access.iv, refresh?.ct ?? null, refresh?.iv ?? null, tokens.expiresAt ?? null, tokens.lifetimeSecs ?? null).run();
  return c.redirect("/?robinhood=connected");
});

app.all("*", async (c) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.json({ error: "Not found." }, 404);
  const asset = await c.env.ASSETS.fetch(c.req.raw);
  return asset;
});

app.onError((error, c) => {
  console.log(redactJson({ message: error instanceof Error ? error.message : "error" }));
  return c.json({ error: "Something went wrong." }, 500);
});

async function requireStepUp(c: AppContext): Promise<Response | undefined> {
  const session = await sessionToken(c);
  if (!session || session.stepupUntil <= Date.now()) return c.json({ error: "Confirm with your passkey.", stepUp: true }, 403);
  return undefined;
}

async function callTrader(c: AppContext, method: "summary" | "cycle" | "kill" | "resume" | "setMode" | "saveSettings" | "saveTop10", arg?: unknown): Promise<Summary> {
  const stub = trader(c) as unknown as AccountTrader;
  if (method === "summary") return stub.summary();
  if (method === "cycle") return stub.cycle();
  if (method === "kill") return stub.kill();
  if (method === "resume") return stub.resume();
  if (method === "setMode") return stub.setMode(arg as "view_only" | "live");
  if (method === "saveSettings") return stub.saveSettings(arg as { profitTargetPct: number; stopLossPct: number; maxOrderPct: number; dailyLossPct: number });
  return stub.saveTop10(arg as string[]);
}

interface Discovered {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  issuer: string;
  scope: string;
}

async function discover(resource: string): Promise<Discovered> {
  let metadataUrl = protectedResourceUrls(resource)[0] ?? "";
  const probe = await fetch(resource, { method: "POST", headers: { accept: "application/json" } });
  const pointed = resourceMetadataFromHeader(probe.headers.get("www-authenticate") ?? "");
  if (pointed) metadataUrl = pointed;
  const resourceDoc = await (await fetch(metadataUrl, { headers: { accept: "application/json" } })).json() as { authorization_servers?: string[] };
  const issuer = resourceDoc.authorization_servers?.[0];
  if (!issuer) throw new Error("Robinhood did not publish an authorization server.");
  let server: Record<string, unknown> | undefined;
  for (const candidate of authorizationMetadataUrls(issuer)) {
    const response = await fetch(candidate, { headers: { accept: "application/json" } });
    if (!response.ok) continue;
    server = await response.json() as Record<string, unknown>;
    break;
  }
  if (!server) throw new Error("Robinhood sign-in metadata was not found.");
  const scope = Array.isArray(server.scopes_supported) ? String(server.scopes_supported[0] ?? "internal") : "internal";
  return {
    authorizationEndpoint: String(server.authorization_endpoint),
    tokenEndpoint: String(server.token_endpoint),
    registrationEndpoint: String(server.registration_endpoint),
    issuer: String(server.issuer ?? issuer).replace(/\/+$/, ""),
    scope,
  };
}

async function registerOrLoad(c: AppContext, discovered: Discovered, redirectUri: string): Promise<string> {
  const saved = await c.env.DB.prepare("SELECT client_id FROM rh_client WHERE id = 1").first<{ client_id: string }>();
  if (saved?.client_id) return saved.client_id;
  const response = await fetch(discovered.registrationEndpoint, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(registrationBody(redirectUri)) });
  if (!response.ok) throw new Error("Robinhood client registration failed.");
  const body = await response.json() as { client_id?: string };
  if (!body.client_id) throw new Error("Robinhood did not return a client id.");
  await c.env.DB.prepare("INSERT INTO rh_client (id, client_id, token_endpoint, registration_endpoint, issuer, resource) VALUES (1, ?, ?, ?, ?, ?)").bind(body.client_id, discovered.tokenEndpoint, discovered.registrationEndpoint, discovered.issuer, tradingMcpUrl()).run();
  return body.client_id;
}

export { AccountTrader };

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const stub = env.TRADER.get(env.TRADER.idFromName("owner")) as unknown as { cycle: () => Promise<unknown> };
    ctx.waitUntil(stub.cycle());
  },
};
