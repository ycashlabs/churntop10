export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

export function securityHeaders(): Record<string, string> {
  return {
    "content-security-policy": CONTENT_SECURITY_POLICY,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "cross-origin-opener-policy": "same-origin",
    "x-dns-prefetch-control": "off",
  };
}

export function applySecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(securityHeaders())) headers.set(key, value);
  headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function hostCookie(name: string, value: string, maxAge: number): string {
  const parts = [`${name}=${value}`, "HttpOnly", "Secure", "Path=/", "SameSite=Strict"];
  if (maxAge >= 0) parts.push(`Max-Age=${maxAge}`);
  return parts.join("; ");
}

/** HTML must never be cached, so a deploy is picked up on the next load and old bundles are not kept alive. Hashed assets keep their own caching. */
export function withHtmlNoStore(response: Response): Response {
  const type = response.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("text/html")) return response;
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store, no-cache, must-revalidate, max-age=0");
  headers.delete("etag");
  headers.delete("last-modified");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
