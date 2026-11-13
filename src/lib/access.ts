export interface AccessClaims {
  email: string;
  aud: string | string[];
  exp: number;
  iss: string;
}

function b64urlToBytes(segment: string): Uint8Array {
  const pad = segment.length % 4 === 0 ? "" : "=".repeat(4 - (segment.length % 4));
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson<T>(segment: string): T {
  const bytes = b64urlToBytes(segment);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

type AccessJwk = JsonWebKey & { kid?: string };

export async function verifyAccessJwt(token: string, jwks: AccessJwk[], expected: { audience: string; issuer: string; email: string; now?: number }): Promise<AccessClaims> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) throw new Error("malformed jwt");
  const header = decodeJson<{ alg?: string; kid?: string }>(parts[0]);
  if (header.alg !== "RS256") throw new Error("unexpected alg");
  const payload = decodeJson<AccessClaims & { nbf?: number }>(parts[1]);
  const now = expected.now ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now) throw new Error("expired");
  if (payload.iss !== expected.issuer) throw new Error("issuer");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(expected.audience)) throw new Error("audience");
  if (payload.email?.toLowerCase() !== expected.email.toLowerCase()) throw new Error("email");
  const jwk = jwks.find((key) => !header.kid || key.kid === header.kid) ?? jwks[0];
  if (!jwk) throw new Error("no key");
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]), data);
  if (!ok) throw new Error("signature");
  return payload;
}

export function accessDecision(input: { enforce: boolean; token: string | undefined; emailOk: boolean }): { ok: boolean; status: number } {
  if (!input.enforce) return { ok: true, status: 200 };
  if (!input.token) return { ok: false, status: 401 };
  if (!input.emailOk) return { ok: false, status: 403 };
  return { ok: true, status: 200 };
}
