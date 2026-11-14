import { applyTotpAttempt, base32Decode, isTotpLocked, otpauthUri, verifyTotp, type TotpLockState } from "../lib/totp.js";
import { decryptString, importAuthKey, sha256Hex } from "./crypto.js";
import type { Env } from "./env.js";
import { recoveryOrigin } from "../lib/hosts.js";
import type { AppContext } from "./http.js";

export type TotpRow = {
  secret_ct: string;
  secret_iv: string;
  last_step: number;
  enabled: number;
  failed_attempts: number;
  locked_until: number;
  enrolled_at: number;
};

export function lockState(row: TotpRow): TotpLockState {
  return { failedAttempts: row.failed_attempts, lockedUntil: row.locked_until };
}

export async function loadTotp(db: D1Database): Promise<TotpRow | null> {
  return await db.prepare("SELECT secret_ct, secret_iv, last_step, enabled, failed_attempts, locked_until, enrolled_at FROM totp WHERE id = 1").first<TotpRow>();
}

export async function totpIsEnabled(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT enabled FROM totp WHERE id = 1").first<{ enabled: number }>();
  return row?.enabled === 1;
}

export async function writeTotpLock(db: D1Database, state: TotpLockState): Promise<void> {
  await db.prepare("UPDATE totp SET failed_attempts = ?, locked_until = ? WHERE id = 1").bind(state.failedAttempts, state.lockedUntil).run();
}

export async function decryptTotpSecret(env: Env, row: TotpRow): Promise<Uint8Array> {
  if (!env.AUTH_KEY) throw new Error("AUTH_KEY is not configured.");
  const key = await importAuthKey(env.AUTH_KEY);
  const secret = await decryptString(key, row.secret_iv, row.secret_ct);
  return base32Decode(secret);
}

export type TotpCheck =
  | { ok: true; step: number; ownerId: string }
  | { ok: false; error: string; status: 400 | 401 | 429 | 503 };

export async function checkTotpCode(c: AppContext, code: string): Promise<TotpCheck> {
  const row = await loadTotp(c.env.DB);
  if (!row || row.enabled !== 1) return { ok: false, error: "Authenticator app is not set up.", status: 400 };
  const now = Date.now();
  if (isTotpLocked(lockState(row), now)) return { ok: false, error: "Too many attempts. Try again later.", status: 429 };
  let secret: Uint8Array;
  try {
    secret = await decryptTotpSecret(c.env, row);
  } catch {
    return { ok: false, error: "AUTH_KEY is not configured.", status: 503 };
  }
  const verified = await verifyTotp(secret, code, { nowMs: now, lastStep: row.last_step });
  if (verified.ok) {
    await c.env.DB.prepare("UPDATE totp SET last_step = ?, failed_attempts = 0, locked_until = 0 WHERE id = 1").bind(verified.step).run();
    const owner = await c.env.DB.prepare("SELECT id FROM owner LIMIT 1").first<{ id: string }>();
    if (!owner) return { ok: false, error: "Authenticator app is not set up.", status: 400 };
    return { ok: true, step: verified.step, ownerId: owner.id };
  }
  const next = applyTotpAttempt(lockState(row), now, verified.reason);
  if (verified.reason === "invalid") await writeTotpLock(c.env.DB, next);
  if (verified.reason === "replay") return { ok: false, error: "That code was already used.", status: 401 };
  if (next.lockedUntil > now) return { ok: false, error: "Too many attempts. Try again later.", status: 429 };
  return { ok: false, error: "That code is not valid.", status: 401 };
}

export async function consumeBackupCode(c: AppContext, code: string): Promise<TotpCheck> {
  const row = await loadTotp(c.env.DB);
  if (!row || row.enabled !== 1) return { ok: false, error: "Authenticator app is not set up.", status: 400 };
  const now = Date.now();
  if (isTotpLocked(lockState(row), now)) return { ok: false, error: "Too many attempts. Try again later.", status: 429 };
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (normalized.length < 8) {
    const next = applyTotpAttempt(lockState(row), now, "invalid");
    await writeTotpLock(c.env.DB, next);
    return { ok: false, error: "That code is not valid.", status: 401 };
  }
  const hash = await sha256Hex(normalized);
  const found = await c.env.DB.prepare("SELECT code_hash, used_at FROM totp_backup_codes WHERE code_hash = ?").bind(hash).first<{ code_hash: string; used_at: number | null }>();
  if (!found || found.used_at) {
    const next = applyTotpAttempt(lockState(row), now, found && found.used_at ? "replay" : "invalid");
    if (!found) await writeTotpLock(c.env.DB, next);
    if (found?.used_at) return { ok: false, error: "That code was already used.", status: 401 };
    if (next.lockedUntil > now) return { ok: false, error: "Too many attempts. Try again later.", status: 429 };
    return { ok: false, error: "That code is not valid.", status: 401 };
  }
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE totp_backup_codes SET used_at = ? WHERE code_hash = ?").bind(now, hash),
    c.env.DB.prepare("UPDATE totp SET failed_attempts = 0, locked_until = 0 WHERE id = 1"),
  ]);
  const owner = await c.env.DB.prepare("SELECT id FROM owner LIMIT 1").first<{ id: string }>();
  if (!owner) return { ok: false, error: "Authenticator app is not set up.", status: 400 };
  return { ok: true, step: 0, ownerId: owner.id };
}

export function recoveryLink(env: Env, requestUrl: URL, token: string): string {
  const link = new URL("/api/auth/recovery/consume", recoveryOrigin(env, requestUrl));
  link.searchParams.set("token", token);
  return link.toString();
}

export async function sendRecoveryEmail(env: Env, url: URL, token: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!env.EMAIL) return { ok: false, error: "Recovery email could not be sent." };
  const to = env.OWNER_EMAIL.trim().toLowerCase();
  if (to !== "tom2258@gmail.com") return { ok: false, error: "Recovery email could not be sent." };
  const link = recoveryLink(env, url, token);
  const text = `Use this link within 15 minutes to replace your passkey:\n${link}\n\nIf you did not ask for this, you can ignore the email.`;
  const html = `<p>Use this link within 15 minutes to replace your passkey:</p><p><a href="${link}">Replace your passkey</a></p><p>If you did not ask for this, you can ignore the email.</p>`;
  try {
    await env.EMAIL.send({
      to,
      from: { email: `noreply@${env.ZONE}`, name: "Churn Top 10" },
      subject: "Churn Top 10 recovery link",
      text,
      html,
    });
    return { ok: true };
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String((error as { code?: string }).code) : "";
    console.log(JSON.stringify({ event: "recovery_email_failed", code }));
    return { ok: false, error: "Recovery email could not be sent." };
  }
}

export function ownerOtpauth(email: string, setupKey: string): string {
  return otpauthUri({ issuer: "Churn Top 10", account: email, secret: setupKey });
}

export { applyTotpAttempt };
