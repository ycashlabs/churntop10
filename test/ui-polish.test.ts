import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dollarsFromSlider, sliderPercent } from "../src/client/capital-slider.js";
import { NAV, pageFromPath, STRIP_HIDDEN } from "../src/client/nav.js";
import { displaySessionId, sessionTimeline, timeZoneAbbreviation, zonedWallTime } from "../src/client/session-timeline.js";
import { marketSession } from "../src/lib/clock.js";

describe("nav order", () => {
  it("lists the seven screens with Rules just above Settings", () => {
    expect(NAV.map((item) => item.label)).toEqual([
      "Account Summary",
      "Top 10",
      "Live Positions",
      "Simulator",
      "Review",
      "Rules",
      "Settings",
    ]);
    expect(NAV.map((item) => item.href)).toEqual(["/", "/top10", "/positions", "/simulator", "/review", "/rules", "/settings"]);
    expect(pageFromPath("/positions")).toBe("positions");
    expect(pageFromPath("/positions/open")).toBe("positions");
    expect(pageFromPath("/")).toBe("summary");
    expect(pageFromPath("/nope")).toBe("summary");
    expect([...STRIP_HIDDEN]).toEqual(["settings", "review"]);
  });
});

describe("trading capital slider", () => {
  it("maps 0–100% of the balance in 1% steps and keeps an exact dollar entry", () => {
    expect(sliderPercent(2500, 10000)).toBe(25);
    expect(sliderPercent(10000, 10000)).toBe(100);
    expect(sliderPercent(15000, 10000)).toBe(100);
    expect(sliderPercent(10, 0)).toBe(0);
    expect(dollarsFromSlider(1, 10000)).toBe(100);
    expect(dollarsFromSlider(0, 10000)).toBe(0);
    expect(dollarsFromSlider(100, 1234.56)).toBe(1234.56);
    expect(dollarsFromSlider(33, 100)).toBe(33);
  });
});

describe("session timeline time zones", () => {
  const wednesday = new Date("2026-01-14T15:00:00Z");

  it("places the regular session on the viewer’s local clock, including DST gaps", () => {
    const et = sessionTimeline(wednesday, "America/New_York");
    const regular = et.spans.find((span) => span.id === "regular");
    expect(et.timeZoneName).toMatch(/EST|EDT/);
    expect(regular?.startMin).toBe(9 * 60 + 30);
    expect(regular?.endMin).toBe(16 * 60);
    expect(et.spans.find((span) => span.current)?.id).toBe("regular");
    expect(displaySessionId(wednesday)).toBe("regular");

    const la = sessionTimeline(wednesday, "America/Los_Angeles");
    const laRegular = la.spans.find((span) => span.id === "regular");
    expect(la.timeZoneName).toMatch(/PST|PDT/);
    expect(laRegular?.startMin).toBe(6 * 60 + 30);
    expect(laRegular?.endMin).toBe(13 * 60);
    expect(laRegular?.startLabel).toMatch(/6:30/);
    expect(laRegular?.endLabel).toMatch(/1:00/);

    const london = sessionTimeline(new Date("2026-03-16T14:00:00Z"), "Europe/London");
    const londonRegular = london.spans.find((span) => span.id === "regular");
    expect(londonRegular?.startMin).toBe(13 * 60 + 30);
    expect(londonRegular?.endMin).toBe(20 * 60);
    expect(timeZoneAbbreviation(new Date("2026-03-16T14:00:00Z"), "Europe/London")).toMatch(/GMT/);
    expect(timeZoneAbbreviation(new Date("2026-07-15T14:00:00Z"), "Europe/London")).toMatch(/BST|GMT\+1/);
  });

  it("highlights the same session the trading clock names, split into pre-market and after-hours", () => {
    const samples = [
      "2026-01-14T13:00:00Z",
      "2026-01-14T15:00:00Z",
      "2026-01-14T21:30:00Z",
      "2026-01-14T02:00:00Z",
      "2026-01-17T18:00:00Z",
      "2026-01-18T16:00:00Z",
      "2026-07-15T13:00:00Z",
      "2026-07-15T20:30:00Z",
      "2026-11-05T02:30:00Z",
    ];
    for (const iso of samples) {
      const now = new Date(iso);
      const model = sessionTimeline(now, "America/Chicago");
      const current = model.spans.filter((span) => span.current);
      expect(current.map((span) => span.id)).toEqual([displaySessionId(now)]);
      expect(marketSession(now)).toBeTruthy();
    }
    const saturday = sessionTimeline(new Date("2026-11-14T15:50:00Z"), "UTC");
    const closed = saturday.spans.filter((span) => span.id === "closed");
    expect(closed).toHaveLength(1);
    expect(closed[0]?.startMin).toBe(60);
    expect(closed[0]?.endMin).toBe(1440);
    expect(closed[0]?.current).toBe(true);
    const spring = sessionTimeline(new Date("2026-03-08T15:00:00Z"), "America/New_York");
    expect(spring.dayMinutes).toBe(23 * 60);
    expect(spring.ticks.some((tick) => tick.label === "2a")).toBe(false);
    const fall = sessionTimeline(new Date("2026-11-01T15:00:00Z"), "America/New_York");
    expect(fall.dayMinutes).toBe(25 * 60);
  });

  it("converts an ET wall time without assuming a fixed offset", () => {
    const winter = zonedWallTime(2026, 1, 14, 9, 30, "America/New_York");
    const summer = zonedWallTime(2026, 7, 15, 9, 30, "America/New_York");
    expect(winter.toISOString()).toBe("2026-01-14T14:30:00.000Z");
    expect(summer.toISOString()).toBe("2026-07-15T13:30:00.000Z");
  });
});

describe("shared button and symbol styles", () => {
  const css = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
  const app = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
  const chart = readFileSync(new URL("../src/client/session-chart.tsx", import.meta.url), "utf8");

  it("uses one light button fill and plain quote text, with no ticker chip", () => {
    expect(css).toContain("--btn-primary: #d9e6f8;");
    expect(css).toContain("--btn-primary: #3a4d68;");
    expect(css).not.toContain("background: var(--ink)");
    expect(css).not.toContain(".pill.up");
    expect(css).toContain(".sym {");
    expect(css).toMatch(/\.sym \{[^}]*border: 0/);
    expect(app).not.toContain("Edit / rename");
    expect(app).not.toContain("Save caps");
    expect(app).toContain("Set Trading Capital");
    expect(app).toContain('aria-label="Edit position"');
    expect(chart).toContain("Stops are app-watched every 5 minutes");
  });
});
