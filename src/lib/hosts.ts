export type HostConfig = {
  ENVIRONMENT: string;
  HOSTNAME?: string;
  ALLOWED_HOSTS?: string;
};

export function allowedHosts(env: HostConfig): string[] {
  const hosts = new Set<string>();
  const canonical = (env.HOSTNAME ?? "").trim().toLowerCase();
  if (canonical) hosts.add(canonical);
  for (const raw of (env.ALLOWED_HOSTS ?? "").split(",")) {
    const host = raw.trim().toLowerCase();
    if (host) hosts.add(host);
  }
  if (env.ENVIRONMENT !== "prod") {
    hosts.add("localhost");
    hosts.add("127.0.0.1");
  }
  return [...hosts];
}

export function allowHost(env: HostConfig, hostname: string): boolean {
  return allowedHosts(env).includes(hostname.toLowerCase());
}

export function rpFromUrl(url: URL): { origin: string; rpID: string } {
  if (url.hostname === "localhost") return { origin: url.origin, rpID: "localhost" };
  return { origin: url.origin, rpID: url.hostname };
}

/** Canonical public origin for recovery email links. Localhost keeps the request origin. */
export function recoveryOrigin(env: HostConfig, requestUrl: URL): string {
  if (requestUrl.hostname === "localhost" || requestUrl.hostname === "127.0.0.1") return requestUrl.origin;
  const host = (env.HOSTNAME ?? "").trim();
  if (host) return `https://${host}`;
  return requestUrl.origin;
}
