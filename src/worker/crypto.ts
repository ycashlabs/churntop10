export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  let binary = "";
  for (const byte of buffer) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function importAesKey(raw: string, name: string): Promise<CryptoKey> {
  const bytes = base64ToBytes(raw);
  if (bytes.length !== 32) throw new Error(`${name} must decode to 32 bytes`);
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function importTokenKey(raw: string): Promise<CryptoKey> {
  return importAesKey(raw, "TOKEN_KEY");
}

export async function importAuthKey(raw: string): Promise<CryptoKey> {
  return importAesKey(raw, "AUTH_KEY");
}

export async function encryptString(key: CryptoKey, plaintext: string): Promise<{ iv: string; ct: string }> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return { iv: bytesToBase64(iv), ct: bytesToBase64(new Uint8Array(ct)) };
}

export async function decryptString(key: CryptoKey, iv: string, ct: string): Promise<string> {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(iv) }, key, base64ToBytes(ct));
  return new TextDecoder().decode(plain);
}
