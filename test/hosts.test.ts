import { describe, expect, it } from "vitest";
import { allowHost, recoveryOrigin, rpFromUrl, type HostConfig } from "../src/lib/hosts.js";

function env(partial: Partial<HostConfig> = {}): HostConfig {
  return {
    ENVIRONMENT: "dev",
    HOSTNAME: "desk-dev.churncapital.com",
    ALLOWED_HOSTS: "top10-dev.ycashlabs.com",
    ...partial,
  };
}

function recoveryLink(config: HostConfig, requestUrl: URL, token: string): string {
  const link = new URL("/api/auth/recovery/consume", recoveryOrigin(config, requestUrl));
  link.searchParams.set("token", token);
  return link.toString();
}

describe("allowHost", () => {
  it("allows the configured hostname, aliases, and localhost on dev", () => {
    const dev = env();
    expect(allowHost(dev, "desk-dev.churncapital.com")).toBe(true);
    expect(allowHost(dev, "top10-dev.ycashlabs.com")).toBe(true);
    expect(allowHost(dev, "localhost")).toBe(true);
    expect(allowHost(dev, "127.0.0.1")).toBe(true);
    expect(allowHost(dev, "desk.churncapital.com")).toBe(false);
    expect(allowHost(dev, "top10.ycashlabs.com")).toBe(false);
  });

  it("allows only HOSTNAME and ALLOWED_HOSTS on prod, not localhost", () => {
    const prod = env({ ENVIRONMENT: "prod", HOSTNAME: "top10.ycashlabs.com", ALLOWED_HOSTS: "" });
    expect(allowHost(prod, "top10.ycashlabs.com")).toBe(true);
    expect(allowHost(prod, "localhost")).toBe(false);
    expect(allowHost(prod, "desk.churncapital.com")).toBe(false);
    const moving = env({
      ENVIRONMENT: "prod",
      HOSTNAME: "desk.churncapital.com",
      ALLOWED_HOSTS: "top10.ycashlabs.com",
    });
    expect(allowHost(moving, "desk.churncapital.com")).toBe(true);
    expect(allowHost(moving, "top10.ycashlabs.com")).toBe(true);
    expect(allowHost(moving, "localhost")).toBe(false);
  });
});

describe("recovery links", () => {
  it("uses https://HOSTNAME for deployed hosts and the request origin on localhost", () => {
    const dev = env();
    const fromAlias = new URL("https://top10-dev.ycashlabs.com/api/auth/recovery");
    expect(recoveryOrigin(dev, fromAlias)).toBe("https://desk-dev.churncapital.com");
    expect(recoveryLink(dev, fromAlias, "tok")).toBe(
      "https://desk-dev.churncapital.com/api/auth/recovery/consume?token=tok",
    );
    expect(recoveryOrigin(dev, new URL("http://localhost:8787/api/auth/recovery"))).toBe("http://localhost:8787");
    expect(recoveryOrigin(dev, new URL("http://127.0.0.1:8787/api/auth/recovery"))).toBe("http://127.0.0.1:8787");
  });
});

describe("rpFromUrl", () => {
  it("uses the request hostname as the WebAuthn RP ID", () => {
    expect(rpFromUrl(new URL("https://desk-dev.churncapital.com/"))).toEqual({
      origin: "https://desk-dev.churncapital.com",
      rpID: "desk-dev.churncapital.com",
    });
    expect(rpFromUrl(new URL("http://localhost:8787/"))).toEqual({
      origin: "http://localhost:8787",
      rpID: "localhost",
    });
  });
});
