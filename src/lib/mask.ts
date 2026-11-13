/** Keep the last 4 characters. Shorter values collapse to a mask. */
export function maskAccountNumber(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

export function maskLongDigitRuns(text: string): string {
  return text.replace(/\d{8,}/g, (run) => maskAccountNumber(run));
}

const SECRET_KEY = /token|secret|authorization|password|cookie/i;

export function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (!value || typeof value !== "object") {
    if (typeof value === "string") {
      if (/bearer\s|access_token|refresh_token/i.test(value)) return "[redacted]";
      return maskLongDigitRuns(value);
    }
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    if (key === "account_number" || key === "accountNumber" || key === "rhs_account_number" || key === "rhc_account_number") {
      out[key] = typeof child === "string" ? maskAccountNumber(child) : "••••";
      continue;
    }
    out[key] = redactValue(child);
  }
  return out;
}

export function redactJson(value: unknown): string {
  const text = JSON.stringify(redactValue(value));
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}
