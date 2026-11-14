import { describe, expect, it } from "vitest";
import {
  applyTotpAttempt,
  base32Decode,
  base32Encode,
  generateBackupCodes,
  generateSecret,
  hotp,
  normalizeBackupCode,
  otpauthUri,
  timeStep,
  totpAt,
  totpStepUpGate,
  verifyTotp,
} from "../src/lib/totp.js";

/** RFC 6238 Appendix B SHA-1 secret and 8-digit vectors. */
const RFC_SECRET = new TextEncoder().encode("12345678901234567890");
const RFC_SHA1_8 = [
  { unix: 59, otp: "94287082" },
  { unix: 1111111109, otp: "07081804" },
  { unix: 1111111111, otp: "14050471" },
  { unix: 1234567890, otp: "89005924" },
  { unix: 2000000000, otp: "69279037" },
  { unix: 20000000000, otp: "65353130" },
];

describe("TOTP RFC 6238 SHA-1 vectors", () => {
  it("matches the 8-digit SHA-1 test vectors", async () => {
    for (const row of RFC_SHA1_8) {
      const step = Math.floor(row.unix / 30);
      expect(await hotp(RFC_SECRET, step, 8)).toBe(row.otp);
      expect(await totpAt(RFC_SECRET, step, 8)).toBe(row.otp);
    }
  });
});

describe("TOTP verify, replay, and lockout", () => {
  it("accepts a 6-digit code in the ±1 step window and rejects a replay of the same step", async () => {
    const secret = generateSecret();
    const now = 1_700_000_000_000;
    const step = timeStep(now);
    const code = await totpAt(secret, step);
    const previous = await totpAt(secret, step - 1);
    const next = await totpAt(secret, step + 1);
    expect((await verifyTotp(secret, code, { nowMs: now, lastStep: -1 })).ok).toBe(true);
    expect((await verifyTotp(secret, previous, { nowMs: now, lastStep: -1 })).ok).toBe(true);
    expect((await verifyTotp(secret, next, { nowMs: now, lastStep: -1 })).ok).toBe(true);
    const first = await verifyTotp(secret, code, { nowMs: now, lastStep: -1 });
    expect(first).toEqual({ ok: true, step });
    const replay = await verifyTotp(secret, code, { nowMs: now, lastStep: step });
    expect(replay).toEqual({ ok: false, reason: "replay" });
    const old = await totpAt(secret, step - 1);
    expect(await verifyTotp(secret, old, { nowMs: now, lastStep: step })).toEqual({ ok: false, reason: "replay" });
    const bad = await verifyTotp(secret, "000000", { nowMs: now, lastStep: -1 });
    expect(bad).toEqual({ ok: false, reason: "invalid" });
  });

  it("locks after five invalid attempts and unlocks after 15 minutes", () => {
    const now = 1_000;
    let state = applyTotpAttempt({ failedAttempts: 0, lockedUntil: 0 }, now, "success");
    expect(state.allowed).toBe(true);
    for (let i = 0; i < 4; i += 1) {
      state = applyTotpAttempt(state, now, "invalid");
      expect(state.allowed).toBe(false);
      expect(state.lockedUntil).toBe(0);
    }
    state = applyTotpAttempt(state, now, "invalid");
    expect(state.failedAttempts).toBe(5);
    expect(state.lockedUntil).toBe(now + 15 * 60 * 1000);
    expect(state.allowed).toBe(false);
    const during = applyTotpAttempt(state, now + 60_000, "invalid");
    expect(during.lockedUntil).toBe(state.lockedUntil);
    expect(during.failedAttempts).toBe(5);
    const after = applyTotpAttempt(state, now + 15 * 60 * 1000, "success");
    expect(after).toEqual({ failedAttempts: 0, lockedUntil: 0, allowed: true });
  });

  it("does not count a replay toward lockout", () => {
    const next = applyTotpAttempt({ failedAttempts: 4, lockedUntil: 0 }, 1, "replay");
    expect(next.failedAttempts).toBe(4);
    expect(next.lockedUntil).toBe(0);
    expect(next.allowed).toBe(false);
  });
});

describe("otpauth and backup codes", () => {
  it("builds a SHA-1 6-digit 30s otpauth URI", () => {
    const uri = otpauthUri({ issuer: "Churn Top 10", account: "tom2258@gmail.com", secret: "JBSWY3DPEHPK3PXP" });
    expect(uri.startsWith("otpauth://totp/Churn%20Top%2010:tom2258%40gmail.com?")).toBe(true);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });

  it("round-trips base32 and issues eight formatted one-time backup codes", () => {
    const secret = generateSecret();
    expect(base32Decode(base32Encode(secret))).toEqual(secret);
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(8);
    const normalized = new Set(codes.map(normalizeBackupCode));
    expect(normalized.size).toBe(8);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
      expect(normalizeBackupCode(code.toLowerCase().replace("-", " ")).length).toBe(10);
    }
  });
});

describe("step-up via TOTP", () => {
  it("accepts a valid TOTP only when an existing non-recovery session belongs to the same owner", async () => {
    const secret = generateSecret();
    const now = 1_700_000_030_000;
    const code = await totpAt(secret, timeStep(now));
    expect((await verifyTotp(secret, code, { nowMs: now, lastStep: -1 })).ok).toBe(true);
    expect(totpStepUpGate(undefined, "owner-1")).toEqual({ ok: false, error: "Sign in first.", status: 401 });
    expect(totpStepUpGate({ recovery: true, ownerId: "owner-1" }, "owner-1")).toEqual({ ok: false, error: "Sign in first.", status: 401 });
    expect(totpStepUpGate({ recovery: false, ownerId: "other" }, "owner-1")).toEqual({ ok: false, error: "Sign in first.", status: 401 });
    expect(totpStepUpGate({ recovery: false, ownerId: "owner-1" }, "owner-1")).toEqual({ ok: true });
  });
});
