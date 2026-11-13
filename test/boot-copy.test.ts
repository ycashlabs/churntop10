import { describe, expect, it } from "vitest";
import { sessionBootstrapCopy } from "../src/lib/boot-copy.js";

describe("sessionBootstrapCopy", () => {
  it("keeps Loading… and surfaces the session error instead of an infinite loading screen", () => {
    expect(sessionBootstrapCopy(null, "Request failed.")).toEqual({
      heading: "Loading…",
      error: "Request failed.",
    });
    expect(sessionBootstrapCopy(null, "Could not load.")).toEqual({
      heading: "Loading…",
      error: "Could not load.",
    });
    expect(sessionBootstrapCopy(null, "")).toEqual({
      heading: "Loading…",
      error: "",
    });
  });

  it("does not reuse the loading heading once a session exists", () => {
    expect(sessionBootstrapCopy({ authenticated: true }, "Request failed.").heading).toBe("");
  });
});
