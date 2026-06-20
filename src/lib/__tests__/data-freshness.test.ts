// Tests for the freshness primitive that gates stale data from rendering as
// live across the prop pipeline.

import { describe, it, expect } from "vitest";
import { assessFreshness, MAX_AGE_HOURS } from "../data-freshness";

const NOW = Date.parse("2026-06-20T12:00:00Z");

describe("assessFreshness", () => {
  it("marks a recent timestamp fresh", () => {
    const f = assessFreshness("2026-06-20T06:00:00Z", 30, NOW); // 6h old
    expect(f.status).toBe("fresh");
    expect(f.isFresh).toBe(true);
    expect(f.ageHours).toBeCloseTo(6, 1);
  });

  it("marks a timestamp past the budget stale", () => {
    const f = assessFreshness("2026-05-06T19:21:00Z", MAX_AGE_HOURS.PROPS_QUOTE, NOW);
    expect(f.status).toBe("stale");
    expect(f.isFresh).toBe(false);
    expect(f.ageHours).toBeGreaterThan(1000); // ~45 days
  });

  it("treats a missing timestamp as unknown (NOT fresh)", () => {
    for (const v of [null, undefined, ""]) {
      const f = assessFreshness(v, 30, NOW);
      expect(f.status).toBe("unknown");
      expect(f.isFresh).toBe(false);
      expect(f.ageHours).toBeNull();
    }
  });

  it("treats an unparseable timestamp as unknown (NOT fresh)", () => {
    const f = assessFreshness("not-a-date", 30, NOW);
    expect(f.status).toBe("unknown");
    expect(f.isFresh).toBe(false);
  });

  it("clamps a slightly-future timestamp to age 0 and calls it fresh", () => {
    const f = assessFreshness("2026-06-20T13:00:00Z", 30, NOW); // 1h in the future
    expect(f.ageHours).toBe(0);
    expect(f.isFresh).toBe(true);
  });

  it("is exactly at the boundary => fresh (age == maxAge)", () => {
    const f = assessFreshness("2026-06-19T06:00:00Z", 30, NOW); // exactly 30h
    expect(f.ageHours).toBeCloseTo(30, 1);
    expect(f.isFresh).toBe(true);
  });

  it("one minute past the boundary => stale", () => {
    const f = assessFreshness("2026-06-19T05:59:00Z", 30, NOW); // 30h01m
    expect(f.isFresh).toBe(false);
    expect(f.status).toBe("stale");
  });

  it("a non-positive maxAge never reports fresh for a real age", () => {
    const f = assessFreshness("2026-06-20T11:00:00Z", 0, NOW);
    expect(f.isFresh).toBe(false);
  });
});
