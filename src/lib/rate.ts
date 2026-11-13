export function nextBucket(input: { hits: number; windowStart: number; now: number; limit: number; windowMs: number }): { allow: boolean; hits: number; windowStart: number } {
  if (input.now - input.windowStart >= input.windowMs) {
    return { allow: true, hits: 1, windowStart: input.now };
  }
  if (input.hits >= input.limit) {
    return { allow: false, hits: input.hits, windowStart: input.windowStart };
  }
  return { allow: true, hits: input.hits + 1, windowStart: input.windowStart };
}

/** Body returned to the browser. The token itself is never included. */
export function recoveryPublicBody(environment: string): { ok: true; delivery: "log" | "email" } {
  return { ok: true, delivery: environment === "dev" ? "log" : "email" };
}
