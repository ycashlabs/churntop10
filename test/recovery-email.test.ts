import { describe, expect, it } from "vitest";
import { recoveryFromAddress } from "../src/lib/email.js";

describe("recoveryFromAddress", () => {
  it("uses EMAIL_FROM when set", () => {
    expect(recoveryFromAddress({ ZONE: "ycashlabs.com", EMAIL_FROM: "noreply@desk.churncapital.com" })).toBe(
      "noreply@desk.churncapital.com",
    );
    expect(recoveryFromAddress({ ZONE: "ycashlabs.com", EMAIL_FROM: "  noreply@desk-dev.churncapital.com  " })).toBe(
      "noreply@desk-dev.churncapital.com",
    );
  });

  it("falls back to noreply@{ZONE} when EMAIL_FROM is missing or blank", () => {
    expect(recoveryFromAddress({ ZONE: "ycashlabs.com" })).toBe("noreply@ycashlabs.com");
    expect(recoveryFromAddress({ ZONE: "ycashlabs.com", EMAIL_FROM: "" })).toBe("noreply@ycashlabs.com");
    expect(recoveryFromAddress({ ZONE: "ycashlabs.com", EMAIL_FROM: "   " })).toBe("noreply@ycashlabs.com");
  });
});
