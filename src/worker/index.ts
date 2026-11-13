import { Hono } from "hono";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { Summary } from "../lib/api-types.js";
import { securityHeaders, withHtmlNoStore } from "../lib/headers.js";
import { recoveryPublicBody } from "../lib/rate.js";
import {
  LOOPBACK_REDIRECT_URI,
  authorizationMetadataUrls,
  authorizationUrl,
  generatePkce,
  issuerMatches,
  parseAuthServerMetadata,
  parseCallbackInput,
  parseProtectedResource,
  parseRegistration,
  protectedResourceUrls,
  registrationBody,
  resourceMetadataFromHeader,
  tokenExchangeMessage,
  tokenSetFromJson,
  tradingMcpUrl,
  type AuthServerMetadata,
} from "../lib/oauth.js";
import { redactJson } from "../lib/mask.js";
import { base32Decode, base32Encode, generateBackupCodes, generateSecret, normalizeBackupCode, totpStepUpGate, verifyTotp } from "../lib/totp.js";
import { checkTotpCode, consumeBackupCode, ownerOtpauth, sendRecoveryEmail, totpIsEnabled } from "./auth-totp.js";
import { base64ToBytes, bytesToBase64, decryptString, encryptString, importAuthKey, importTokenKey, randomToken, sha256Hex } from "./crypto.js";
import type { Env } from "./env.js";
import { allowHost, clearCookie, csrfOk, enforceAccess, issueCsrf, rateLimit, readCookie, rpFromUrl, sessionToken, startSession, trader, type AppContext } from "./http.js";
import { AccountTrader } from "./trader.js";
import { serveEmbedded } from "./embedded-assets.js";
import type { RuleSide, RuleStatus } from "../lib/rules.js";

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
  const limited = await rateLimit(c, "session", 60, { persist: false });
  if (limited) return limited;
  await issueCsrf(c);
  const registered = await c.env.DB.prepare("SELECT id FROM credentials LIMIT 1").first();
  const totpEnabled = await totpIsEnabled(c.env.DB);
  const session = await sessionToken(c);
  if (!session) return c.json({ authenticated: false, registered: !!registered, totpEnabled });
  return c.json({
    authenticated: true,
    registered: true,
    email: c.env.OWNER_EMAIL,
    recovery: session.recovery,
    stepUp: session.stepupUntil > Date.now(),
    totpEnabled,
    authMethod: session.authMethod,
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
  await startSession(c, body.ownerId, { authMethod: "passkey" });
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
    await markStepUp(c, hash, "passkey");
    return c.json({ ok: true, stepUp: true });
  }
  await startSession(c, credential.owner_id, { authMethod: "passkey" });
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
  if (email !== c.env.OWNER_EMAIL.toLowerCase()) return c.json(recoveryPublicBody());
  const token = randomToken(32);
  await c.env.DB.prepare("INSERT INTO magic_links (token_hash, email, expires_at) VALUES (?, ?, ?)").bind(await sha256Hex(token), email, Date.now() + 15 * 60 * 1000).run();
  const url = new URL(c.req.url);
  const local = url.hostname === "localhost";
  if (local) {
    console.log(`dev recovery token ${token}`);
    await c.env.DB.prepare("INSERT INTO audit_index (id, at, action, detail) VALUES (?, ?, 'recovery', ?)").bind(crypto.randomUUID(), Date.now(), redactJson({ email: "owner" })).run();
    return c.json(recoveryPublicBody("log"));
  }
  const sent = await sendRecoveryEmail(c.env, url, token);
  if (!sent.ok) return c.json({ error: sent.error }, 503);
  await c.env.DB.prepare("INSERT INTO audit_index (id, at, action, detail) VALUES (?, ?, 'recovery', ?)").bind(crypto.randomUUID(), Date.now(), redactJson({ email: "owner" })).run();
  return c.json(recoveryPublicBody("email"));
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
  await startSession(c, owner.id, { recovery: true, authMethod: "recovery" });
  return c.redirect("/?recovery=1");
});


app.post("/api/auth/login/totp", async (c) => {
  const limited = await rateLimit(c, "totp", 5);
  if (limited) return limited;
  const body = await c.req.json<{ code?: string; stepUp?: boolean }>().catch(() => ({} as { code?: string; stepUp?: boolean }));
  const result = await checkTotpCode(c, body.code ?? "");
  if (!result.ok) return c.json({ error: result.error }, result.status);
  if (body.stepUp) {
    const session = await sessionToken(c);
    const gate = totpStepUpGate(session, result.ownerId);
    if (!gate.ok) return c.json({ error: gate.error }, gate.status);
    const hash = await sha256Hex(readCookie(c.req.header("cookie"), "__Host-session") ?? "");
    await markStepUp(c, hash, "totp");
    return c.json({ ok: true, stepUp: true });
  }
  await startSession(c, result.ownerId, { authMethod: "totp" });
  return c.json({ ok: true });
});

app.post("/api/auth/login/backup", async (c) => {
  const limited = await rateLimit(c, "totp", 5);
  if (limited) return limited;
  const body = await c.req.json<{ code?: string; stepUp?: boolean }>().catch(() => ({} as { code?: string; stepUp?: boolean }));
  const result = await consumeBackupCode(c, body.code ?? "");
  if (!result.ok) return c.json({ error: result.error }, result.status);
  if (body.stepUp) {
    const session = await sessionToken(c);
    const gate = totpStepUpGate(session, result.ownerId);
    if (!gate.ok) return c.json({ error: gate.error }, gate.status);
    const hash = await sha256Hex(readCookie(c.req.header("cookie"), "__Host-session") ?? "");
    await markStepUp(c, hash, "totp");
    return c.json({ ok: true, stepUp: true });
  }
  await startSession(c, result.ownerId, { authMethod: "totp" });
  return c.json({ ok: true });
});

app.post("/api/auth/totp/begin", async (c) => {
  const limited = await rateLimit(c, "auth", 10);
  if (limited) return limited;
  const blocked = await requirePasskeyStepUp(c);
  if (blocked) return blocked;
  if (!c.env.AUTH_KEY) return c.json({ error: "AUTH_KEY is not configured." }, 503);
  const session = await sessionToken(c);
  if (!session) return c.json({ error: "Sign in first." }, 401);
  const setupKey = base32Encode(generateSecret());
  const key = await importAuthKey(c.env.AUTH_KEY);
  const packed = await encryptString(key, setupKey);
  await c.env.DB.prepare("INSERT INTO challenges (id, kind, challenge, expires_at) VALUES (?, 'totp_enroll', ?, ?) ON CONFLICT(id) DO UPDATE SET challenge = excluded.challenge, expires_at = excluded.expires_at, kind = 'totp_enroll'").bind(session.ownerId, JSON.stringify(packed), Date.now() + 10 * 60 * 1000).run();
  return c.json({ otpauthUri: ownerOtpauth(c.env.OWNER_EMAIL, setupKey), setupKey });
});

app.post("/api/auth/totp/confirm", async (c) => {
  const limited = await rateLimit(c, "auth", 10);
  if (limited) return limited;
  const blocked = await requirePasskeyStepUp(c);
  if (blocked) return blocked;
  if (!c.env.AUTH_KEY) return c.json({ error: "AUTH_KEY is not configured." }, 503);
  const session = await sessionToken(c);
  if (!session) return c.json({ error: "Sign in first." }, 401);
  const body = await c.req.json<{ code?: string }>().catch(() => ({ code: "" }));
  const row = await c.env.DB.prepare("SELECT challenge, expires_at FROM challenges WHERE id = ? AND kind = 'totp_enroll'").bind(session.ownerId).first<{ challenge: string; expires_at: number }>();
  if (!row || row.expires_at < Date.now()) return c.json({ error: "Setup expired. Start again." }, 400);
  let setupKey: string;
  let packed: { iv: string; ct: string };
  try {
    packed = JSON.parse(row.challenge) as { iv: string; ct: string };
    const key = await importAuthKey(c.env.AUTH_KEY);
    setupKey = await decryptString(key, packed.iv, packed.ct);
  } catch {
    return c.json({ error: "Setup expired. Start again." }, 400);
  }
  const secret = base32Decode(setupKey);
  const verified = await verifyTotp(secret, body.code ?? "", { nowMs: Date.now(), lastStep: -1 });
  if (!verified.ok) return c.json({ error: "That code is not valid." }, 401);
  const backupCodes = generateBackupCodes();
  const hashes = await Promise.all(backupCodes.map((code) => sha256Hex(normalizeBackupCode(code))));
  const statements = [
    c.env.DB.prepare("DELETE FROM totp_backup_codes"),
    c.env.DB.prepare("INSERT INTO totp (id, secret_ct, secret_iv, last_step, enabled, failed_attempts, locked_until, enrolled_at) VALUES (1, ?, ?, ?, 1, 0, 0, ?) ON CONFLICT(id) DO UPDATE SET secret_ct = excluded.secret_ct, secret_iv = excluded.secret_iv, last_step = excluded.last_step, enabled = 1, failed_attempts = 0, locked_until = 0, enrolled_at = excluded.enrolled_at").bind(packed.ct, packed.iv, verified.step, Date.now()),
    c.env.DB.prepare("DELETE FROM challenges WHERE id = ? AND kind = 'totp_enroll'").bind(session.ownerId),
    ...hashes.map((hash) => c.env.DB.prepare("INSERT INTO totp_backup_codes (code_hash, used_at) VALUES (?, NULL)").bind(hash)),
  ];
  await c.env.DB.batch(statements);
  return c.json({ backupCodes });
});

app.post("/api/auth/totp/disable", async (c) => {
  const limited = await rateLimit(c, "auth", 10);
  if (limited) return limited;
  const blocked = await requireStepUp(c);
  if (blocked) return blocked;
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM totp_backup_codes"),
    c.env.DB.prepare("DELETE FROM totp"),
  ]);
  return c.json({ ok: true });
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
  const body = await c.req.json<{ profitTargetPct?: number; stopLossPct?: number; dailyLossPct?: number; orderCap?: number; tradingCapital?: number }>();
  try {
    return c.json(await callTrader(c, "saveSettings", {
      profitTargetPct: Number(body.profitTargetPct),
      stopLossPct: Number(body.stopLossPct),
      dailyLossPct: Number(body.dailyLossPct),
      orderCap: Number(body.orderCap),
      tradingCapital: body.tradingCapital == null ? undefined : Number(body.tradingCapital),
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


app.get("/api/simulator", async (c) => {
  const limited = await rateLimit(c, "read", 120);
  if (limited) return limited;
  const stub = trader(c) as unknown as AccountTrader;
  return c.json(await stub.simulator());
});

app.post("/api/simulator/cycle", async (c) => {
  const limited = await rateLimit(c, "trade", 20);
  if (limited) return limited;
  const body = await c.req.json<{ ruleIds?: string[] }>().catch(() => ({} as { ruleIds?: string[] }));
  const stub = trader(c) as unknown as AccountTrader;
  return c.json(await stub.cycleSimulator(body.ruleIds));
});

app.post("/api/simulator/select", async (c) => {
  const limited = await rateLimit(c, "trade", 20);
  if (limited) return limited;
  const body = await c.req.json<{ ruleIds?: string[] }>();
  const stub = trader(c) as unknown as AccountTrader;
  return c.json(await stub.setSelectedRules(body.ruleIds ?? []));
});

app.post("/api/sell-all", async (c) => {
  const limited = await rateLimit(c, "trade", 20);
  if (limited) return limited;
  const body = await c.req.json<{ confirm?: boolean }>().catch(() => ({} as { confirm?: boolean }));
  if (!body.confirm) return c.json({ error: "Confirm selling every simulated position and stopping new buys." }, 400);
  const stub = trader(c) as unknown as AccountTrader;
  return c.json(await stub.sellAll());
});


app.post("/api/positions/:id/capital", async (c) => {
  const limited = await rateLimit(c, "trade", 20);
  if (limited) return limited;
  const body = await c.req.json<{ amount?: number; confirm?: boolean }>();
  try {
    const stub = trader(c) as unknown as AccountTrader;
    return c.json(await stub.editPositionCapital(c.req.param("id"), Number(body.amount), body.confirm === true));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Could not edit capital." }, 400);
  }
});

app.post("/api/positions/:id/exits", async (c) => {
  const stepped = await requireStepUp(c);
  if (stepped) return stepped;
  const body = await c.req.json<{ profitTargetPct?: number; stopLossPct?: number }>();
  try {
    const stub = trader(c) as unknown as AccountTrader;
    return c.json(await stub.editPositionExits(c.req.param("id"), body));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Could not edit the target or stop." }, 400);
  }
});

app.get("/api/reviews", async (c) => {
  const limited = await rateLimit(c, "read", 120);
  if (limited) return limited;
  const stub = trader(c) as unknown as AccountTrader;
  const url = new URL(c.req.url);
  return c.json(await stub.reviewScreen({
    ruleId: url.searchParams.get("rule") || undefined,
    symbol: url.searchParams.get("symbol") || undefined,
    session: url.searchParams.get("session") || undefined,
    from: url.searchParams.get("from") ? Number(url.searchParams.get("from")) : undefined,
    to: url.searchParams.get("to") ? Number(url.searchParams.get("to")) : undefined,
    mode: (url.searchParams.get("mode") as "live" | "sim" | null) || undefined,
  }));
});

app.post("/api/reviews/:positionId/note", async (c) => {
  const limited = await rateLimit(c, "trade", 20);
  if (limited) return limited;
  const body = await c.req.json<{ userNote?: string }>();
  const stub = trader(c) as unknown as AccountTrader;
  await stub.updateReviewNote(c.req.param("positionId"), body.userNote ?? "");
  return c.json({ ok: true });
});

app.get("/api/rules", async (c) => {
  const limited = await rateLimit(c, "read", 120);
  if (limited) return limited;
  const stub = trader(c) as unknown as AccountTrader;
  return c.json({ rules: await stub.listRuleViews() });
});

app.post("/api/rules", async (c) => {
  const stepped = await requireStepUp(c);
  if (stepped) return stepped;
  const body = await c.req.json<{ name?: string; side?: RuleSide; body?: string; signals?: string[] }>();
  try {
    const stub = trader(c) as unknown as AccountTrader;
    return c.json({ rules: await stub.createRuleView({ name: body.name ?? "", side: body.side ?? "buy", body: body.body ?? "", signals: body.signals ?? [] }) });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Could not create the rule." }, 400);
  }
});

app.post("/api/rules/:id", async (c) => {
  const stepped = await requireStepUp(c);
  if (stepped) return stepped;
  const body = await c.req.json<{ name?: string; body?: string; signals?: string[] }>();
  try {
    const stub = trader(c) as unknown as AccountTrader;
    return c.json({ rules: await stub.editRuleView(c.req.param("id"), body) });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Could not edit the rule." }, 400);
  }
});

app.post("/api/rules/:id/status", async (c) => {
  const stepped = await requireStepUp(c);
  if (stepped) return stepped;
  const body = await c.req.json<{ status?: RuleStatus }>();
  try {
    const stub = trader(c) as unknown as AccountTrader;
    return c.json({ rules: await stub.setRuleStatusView(c.req.param("id"), body.status as RuleStatus) });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Could not change the rule status." }, 400);
  }
});

app.get("/api/rules/:familyId/history", async (c) => {
  const limited = await rateLimit(c, "read", 120);
  if (limited) return limited;
  const stub = trader(c) as unknown as AccountTrader;
  return c.json({ history: await stub.ruleHistoryView(c.req.param("familyId")) });
});

app.post("/api/robinhood/connect", async (c) => {
  const stepped = await requireStepUp(c);
  if (stepped) return stepped;
  if (!c.env.TOKEN_KEY) return c.json({ error: "TOKEN_KEY is not configured." }, 503);
  // Robinhood's shared client only accepts loopback redirects; a web callback is refused on robinhood.com.
  const redirectUri = LOOPBACK_REDIRECT_URI;
  try {
    const discovered = await discover(tradingMcpUrl());
    const clientId = await registerOrLoad(c, discovered, redirectUri);
    const pkce = await generatePkce();
    const state = randomToken(16);
    await c.env.DB.prepare("DELETE FROM oauth_state WHERE expires_at < ?").bind(Date.now()).run();
    await c.env.DB.prepare("INSERT INTO oauth_state (state, verifier, redirect_uri, expires_at) VALUES (?, ?, ?, ?)").bind(state, pkce.verifier, redirectUri, Date.now() + 10 * 60 * 1000).run();
    const location = authorizationUrl({
      authorizationEndpoint: discovered.authorizationEndpoint,
      clientId,
      redirectUri,
      challenge: pkce.challenge,
      resource: discovered.resource,
      state,
      scope: discovered.scope,
    });
    console.log(redactJson({ event: "robinhood_connect_started", redirectUri, authorizationEndpoint: discovered.authorizationEndpoint }));
    return c.json({ url: location, redirectUri, paste: true });
  } catch (error) {
    console.log(redactJson({ event: "robinhood_connect_failed", message: error instanceof Error ? error.message : "error" }));
    return c.json({ error: error instanceof Error ? error.message : "Robinhood sign-in could not start." }, 502);
  }
});

app.get("/api/robinhood/pending", async (c) => {
  const limited = await rateLimit(c, "read", 120);
  if (limited) return limited;
  const row = await c.env.DB.prepare("SELECT expires_at FROM oauth_state WHERE expires_at > ? AND redirect_uri = ? ORDER BY expires_at DESC LIMIT 1").bind(Date.now(), LOOPBACK_REDIRECT_URI).first<{ expires_at: number }>();
  c.header("cache-control", "no-store");
  return c.json(row ? { pending: true, expiresAt: new Date(row.expires_at).toISOString(), redirectUri: LOOPBACK_REDIRECT_URI } : { pending: false, redirectUri: LOOPBACK_REDIRECT_URI });
});

app.post("/api/robinhood/disconnect", async (c) => {
  const stepped = await requireStepUp(c);
  if (stepped) return stepped;
  return c.json(await callTrader(c, "disconnect"));
});

app.post("/api/robinhood/complete", async (c) => {
  const limited = await rateLimit(c, "rh-complete", 10);
  if (limited) return limited;
  const body = await c.req.json<{ callbackUrl?: unknown }>().catch(() => ({} as { callbackUrl?: unknown }));
  const parsed = parseCallbackInput(typeof body.callbackUrl === "string" ? body.callbackUrl : "");
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const result = await finishConnect(c, parsed);
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ connected: true });
});

app.get("/api/robinhood/callback", async (c) => {
  const parsed = parseCallbackInput(new URL(c.req.url).search);
  if (!parsed.ok) return c.redirect("/?robinhood=failed");
  const result = await finishConnect(c, parsed);
  return c.redirect(result.ok ? "/?robinhood=connected" : "/?robinhood=failed");
});

async function finishConnect(c: AppContext, input: { code: string; state: string; iss?: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const saved = await c.env.DB.prepare("SELECT verifier, redirect_uri, expires_at FROM oauth_state WHERE state = ?").bind(input.state).first<{ verifier: string; redirect_uri: string; expires_at: number }>();
  await c.env.DB.prepare("DELETE FROM oauth_state WHERE state = ?").bind(input.state).run();
  if (!saved || saved.expires_at < Date.now()) return { ok: false, error: "That sign-in link expired or was already used. Click Connect Robinhood again." };
  if (!c.env.TOKEN_KEY) return { ok: false, error: "TOKEN_KEY is not configured." };
  const client = await c.env.DB.prepare("SELECT client_id, token_endpoint, issuer, resource FROM rh_client WHERE id = 1").first<{ client_id: string; token_endpoint: string; issuer: string; resource: string }>();
  if (!client) return { ok: false, error: "Robinhood client is not registered. Click Connect Robinhood again." };
  // Robinhood advertises authorization_response_iss_parameter_supported: true, so iss is required (RFC 9207).
  if (!issuerMatches(input.iss, client.issuer, true)) return { ok: false, error: "The address did not come from Robinhood's sign-in. Click Connect Robinhood again." };
  const form = new URLSearchParams({ grant_type: "authorization_code", code: input.code, redirect_uri: saved.redirect_uri, client_id: client.client_id, code_verifier: saved.verifier, resource: client.resource });
  const response = await fetch(client.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: form });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const message = tokenExchangeMessage(response.status, text);
    console.log(redactJson({ event: "robinhood_token_exchange_failed", status: response.status, message }));
    return { ok: false, error: message };
  }
  const tokens = tokenSetFromJson(await response.json());
  if (!tokens) return { ok: false, error: "Robinhood did not return an access token." };
  const key = await importTokenKey(c.env.TOKEN_KEY);
  const access = await encryptString(key, tokens.accessToken);
  const refresh = tokens.refreshToken ? await encryptString(key, tokens.refreshToken) : undefined;
  await c.env.DB.prepare("INSERT INTO rh_tokens (id, access_ct, access_iv, refresh_ct, refresh_iv, expires_at, lifetime_secs) VALUES (1, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET access_ct = excluded.access_ct, access_iv = excluded.access_iv, refresh_ct = excluded.refresh_ct, refresh_iv = excluded.refresh_iv, expires_at = excluded.expires_at, lifetime_secs = excluded.lifetime_secs").bind(access.ct, access.iv, refresh?.ct ?? null, refresh?.iv ?? null, tokens.expiresAt ?? null, tokens.lifetimeSecs ?? null).run();
  console.log(redactJson({ event: "robinhood_connected" }));
  return { ok: true };
}

app.all("*", async (c) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return c.json({ error: "Not found." }, 404);
  const embedded = serveEmbedded(c.req.raw);
  if (embedded) return withHtmlNoStore(embedded);
  if (c.env.ASSETS) {
    const asset = await c.env.ASSETS.fetch(c.req.raw);
    return withHtmlNoStore(asset);
  }
  return c.json({ error: "Not found." }, 404);
});

app.onError((error, c) => {
  console.log(redactJson({ message: error instanceof Error ? error.message : "error" }));
  return c.json({ error: "Something went wrong." }, 500);
});

async function markStepUp(c: AppContext, tokenHash: string, method: "passkey" | "totp"): Promise<void> {
  await c.env.DB.prepare("UPDATE sessions SET stepup_until = ?, stepup_method = ? WHERE token_hash = ?").bind(Date.now() + 5 * 60 * 1000, method, tokenHash).run();
}

async function requirePasskeyStepUp(c: AppContext): Promise<Response | undefined> {
  const session = await sessionToken(c);
  if (!session || session.recovery) return c.json({ error: "Sign in with your passkey." }, 401);
  if (session.stepupUntil <= Date.now() || session.stepupMethod !== "passkey") {
    return c.json({ error: "Confirm with your passkey.", stepUp: true, stepUpMethod: "passkey" }, 403);
  }
}

async function requireStepUp(c: AppContext): Promise<Response | undefined> {
  const session = await sessionToken(c);
  if (!session || session.recovery || session.stepupUntil <= Date.now()) return c.json({ error: "Confirm with your passkey.", stepUp: true }, 403);
  return undefined;
}

async function callTrader(c: AppContext, method: "disconnect" | "summary" | "cycle" | "kill" | "resume" | "setMode" | "saveSettings" | "saveTop10", arg?: unknown): Promise<Summary> {
  const stub = trader(c) as unknown as AccountTrader;
  if (method === "summary") return stub.summary();
  if (method === "disconnect") return stub.disconnect();
  if (method === "cycle") return stub.cycle();
  if (method === "kill") return stub.kill();
  if (method === "resume") return stub.resume();
  if (method === "setMode") return stub.setMode(arg as "view_only" | "live");
  if (method === "saveSettings") return stub.saveSettings(arg as { profitTargetPct: number; stopLossPct: number; dailyLossPct: number; orderCap: number; tradingCapital?: number });
  return stub.saveTop10(arg as string[]);
}

interface Discovered extends AuthServerMetadata {
  resource: string;
}

async function discover(mcpUrl: string): Promise<Discovered> {
  let metadataUrl = protectedResourceUrls(mcpUrl)[0] ?? "";
  const probe = await fetch(mcpUrl, { method: "POST", headers: { accept: "application/json" } });
  const pointed = resourceMetadataFromHeader(probe.headers.get("www-authenticate") ?? "");
  if (pointed) metadataUrl = pointed;
  const resourceResponse = await fetch(metadataUrl, { headers: { accept: "application/json" } });
  if (!resourceResponse.ok) throw new Error(`Robinhood resource metadata returned HTTP ${resourceResponse.status}.`);
  const resourceDoc = parseProtectedResource(await resourceResponse.json());
  for (const candidate of authorizationMetadataUrls(resourceDoc.issuer)) {
    const response = await fetch(candidate, { headers: { accept: "application/json" } });
    if (!response.ok) continue;
    return { ...parseAuthServerMetadata(await response.json()), resource: resourceDoc.resource };
  }
  throw new Error("Robinhood sign-in metadata was not found.");
}

async function registerOrLoad(c: AppContext, discovered: Discovered, redirectUri: string): Promise<string> {
  const saved = await c.env.DB.prepare("SELECT client_id FROM rh_client WHERE id = 1").first<{ client_id: string }>();
  if (saved?.client_id) return saved.client_id;
  const response = await fetch(discovered.registrationEndpoint, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(registrationBody(redirectUri)) });
  if (!response.ok) throw new Error(`Robinhood client registration failed (HTTP ${response.status}).`);
  const { clientId } = parseRegistration(await response.json());
  await c.env.DB.prepare("INSERT INTO rh_client (id, client_id, token_endpoint, registration_endpoint, issuer, resource) VALUES (1, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET client_id = excluded.client_id, token_endpoint = excluded.token_endpoint, registration_endpoint = excluded.registration_endpoint, issuer = excluded.issuer, resource = excluded.resource").bind(clientId, discovered.tokenEndpoint, discovered.registrationEndpoint, discovered.issuer, discovered.resource).run();
  return clientId;
}

export { AccountTrader };

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const stub = env.TRADER.get(env.TRADER.idFromName("owner")) as unknown as { tickSimulator: () => Promise<unknown> };
    ctx.waitUntil(stub.tickSimulator());
  },
};
