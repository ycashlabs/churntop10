export function nextBucket(input: { hits: number; windowStart: number; now: number; limit: number; windowMs: number }): { allow: boolean; hits: number; windowStart: number } {
  if (input.now - input.windowStart >= input.windowMs) {
    return { allow: true, hits: 1, windowStart: input.now };
  }
  if (input.hits >= input.limit) {
    return { allow: false, hits: input.hits, windowStart: input.windowStart };
  }
  return { allow: true, hits: input.hits + 1, windowStart: input.windowStart };
}

/** Body returned to the browser. The token itself is never included. Only pass delivery when it actually happened. */
export function recoveryPublicBody(delivery?: "log" | "email"): { ok: true; delivery?: "log" | "email" } {
  if (delivery) return { ok: true, delivery };
  return { ok: true };
}

const memoryBuckets = new Map<string, { hits: number; windowStart: number }>();

/** In-memory rate limit for paths that must not write to D1 (GET /api/session). */
export function takeMemoryBucket(key: string, now: number, limit: number, windowMs: number): { allow: boolean; hits: number; windowStart: number } {
  const row = memoryBuckets.get(key);
  const next = nextBucket({ hits: row?.hits ?? 0, windowStart: row?.windowStart ?? now, now, limit, windowMs });
  memoryBuckets.set(key, { hits: next.hits, windowStart: next.windowStart });
  return next;
}

export function resetMemoryRateLimits(): void {
  memoryBuckets.clear();
}
