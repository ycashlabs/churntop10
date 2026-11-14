export type RecoveryFromConfig = {
  ZONE: string;
  EMAIL_FROM?: string;
};

/** From address for recovery mail. Prefer EMAIL_FROM; fall back to noreply@{ZONE}. */
export function recoveryFromAddress(env: RecoveryFromConfig): string {
  const configured = env.EMAIL_FROM?.trim();
  if (configured) return configured;
  return `noreply@${env.ZONE}`;
}
