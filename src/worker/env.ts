export interface Env {
  ASSETS?: Fetcher;
  DB: D1Database;
  AUDIT: R2Bucket;
  TRADER: DurableObjectNamespace;
  ENVIRONMENT: string;
  ALLOW_LIVE_TRADING: string;
  ACCESS_ENFORCE: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  OWNER_EMAIL: string;
  ZONE: string;
  HOSTNAME: string;
  TOKEN_KEY?: string;
  AUTH_KEY?: string;
  EMAIL?: SendEmail;
}

export interface SendEmail {
  send(message: {
    to: string | { email: string; name?: string };
    from: string | { email: string; name?: string };
    subject: string;
    text?: string;
    html?: string;
  }): Promise<{ messageId: string }>;
}

