/** RFC 6238 TOTP (SHA-1, 6 digits, 30s) plus lockout and backup-code helpers. */

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_WINDOW = 1;
export const TOTP_MAX_ATTEMPTS = 5;
export const TOTP_LOCK_MS = 15 * 60 * 1000;
export const BACKUP_CODE_COUNT = 8;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function generateSecret(byteLength = 20): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Uint8Array {
  const cleaned = input.toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const idx = BASE32.indexOf(char);
    if (idx < 0) throw new Error("Invalid setup key.");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

export function timeStep(nowMs = Date.now(), periodSeconds = TOTP_PERIOD_SECONDS): number {
  return Math.floor(Math.floor(nowMs / 1000) / periodSeconds);
}

function counterBytes(counter: number): Uint8Array {
  const bytes = new Uint8Array(8);
  let remaining = BigInt(counter);
  for (let i = 7; i >= 0; i -= 1) {
    bytes[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

export async function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBytes(counter)));
  const last = mac[mac.length - 1] ?? 0;
  const offset = last & 0x0f;
  const b0 = mac[offset] ?? 0;
  const b1 = mac[offset + 1] ?? 0;
  const b2 = mac[offset + 2] ?? 0;
  const b3 = mac[offset + 3] ?? 0;
  const bin = ((b0 & 0x7f) << 24) | ((b1 & 0xff) << 16) | ((b2 & 0xff) << 8) | (b3 & 0xff);
  const otp = bin % 10 ** digits;
  return String(otp).padStart(digits, "0");
}

export async function totpAt(secret: Uint8Array, step: number, digits = TOTP_DIGITS): Promise<string> {
  return hotp(secret, step, digits);
}

export function normalizeTotpCode(code: string): string {
  return code.replace(/\s+/g, "");
}

export async function verifyTotp(
  secret: Uint8Array,
  code: string,
  options: { nowMs?: number; lastStep?: number; window?: number; digits?: number; periodSeconds?: number } = {},
): Promise<{ ok: true; step: number } | { ok: false; reason: "invalid" | "replay" }> {
  const digits = options.digits ?? TOTP_DIGITS;
  const window = options.window ?? TOTP_WINDOW;
  const period = options.periodSeconds ?? TOTP_PERIOD_SECONDS;
  const nowMs = options.nowMs ?? Date.now();
  const lastStep = options.lastStep ?? -1;
  const cleaned = normalizeTotpCode(code);
  if (!new RegExp(`^\\d{${digits}}$`).test(cleaned)) return { ok: false, reason: "invalid" };
  const current = timeStep(nowMs, period);
  let matched: number | undefined;
  for (let delta = -window; delta <= window; delta += 1) {
    const step = current + delta;
    if (step < 0) continue;
    if (await totpAt(secret, step, digits) === cleaned) {
      matched = step;
      break;
    }
  }
  if (matched === undefined) return { ok: false, reason: "invalid" };
  if (matched <= lastStep) return { ok: false, reason: "replay" };
  return { ok: true, step: matched };
}

export function otpauthUri(input: { issuer: string; account: string; secret: string }): string {
  const issuer = encodeURIComponent(input.issuer);
  const account = encodeURIComponent(input.account);
  const params = new URLSearchParams({
    secret: input.secret,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${issuer}:${account}?${params.toString()}`;
}

export function generateBackupCodes(count = BACKUP_CODE_COUNT): string[] {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const bytes = new Uint8Array(10);
    crypto.getRandomValues(bytes);
    let raw = "";
    for (const byte of bytes) raw += alphabet[byte % alphabet.length];
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

export function normalizeBackupCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export type TotpLockState = { failedAttempts: number; lockedUntil: number };

export function applyTotpAttempt(
  state: TotpLockState,
  now: number,
  outcome: "success" | "invalid" | "replay",
  options: { maxAttempts?: number; lockMs?: number } = {},
): TotpLockState & { allowed: boolean } {
  const maxAttempts = options.maxAttempts ?? TOTP_MAX_ATTEMPTS;
  const lockMs = options.lockMs ?? TOTP_LOCK_MS;
  if (state.lockedUntil > now) {
    return { failedAttempts: state.failedAttempts, lockedUntil: state.lockedUntil, allowed: false };
  }
  const unlocked: TotpLockState = state.lockedUntil && state.lockedUntil <= now
    ? { failedAttempts: 0, lockedUntil: 0 }
    : { failedAttempts: state.failedAttempts, lockedUntil: 0 };
  if (outcome === "success") return { failedAttempts: 0, lockedUntil: 0, allowed: true };
  if (outcome === "replay") return { ...unlocked, allowed: false };
  const failedAttempts = unlocked.failedAttempts + 1;
  if (failedAttempts >= maxAttempts) {
    return { failedAttempts, lockedUntil: now + lockMs, allowed: false };
  }
  return { failedAttempts, lockedUntil: 0, allowed: false };
}

export function isTotpLocked(state: TotpLockState, now: number): boolean {
  return state.lockedUntil > now;
}

/** A TOTP (or backup code) may satisfy step-up only on an existing non-recovery session for the same owner. */
export function totpStepUpGate(session: { recovery: boolean; ownerId: string } | undefined, ownerId: string): { ok: true } | { ok: false; error: string; status: 401 } {
  if (!session || session.recovery || session.ownerId !== ownerId) return { ok: false, error: "Sign in first.", status: 401 };
  return { ok: true };
}
