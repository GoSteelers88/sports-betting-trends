// team-colors.test.ts — the contrast claim is re-derived here, not trusted.
// Every ink is measured against the real page ground, and the ratio recorded
// in the module must match what the formula returns.

import { describe, it, expect } from "vitest";
import { FRANCHISES } from "../teams";
import {
  MIN_CONTRAST,
  PAPER_HEX,
  TEAM_INK,
  contrastOnPaper,
  relativeLuminance,
  teamInk,
} from "../team-colors";

describe("team ink map", () => {
  it("covers all 32 franchises and nothing else", () => {
    const keys = Object.keys(TEAM_INK).sort();
    const franchiseKeys = FRANCHISES.map((f) => f.key).sort();
    expect(keys).toEqual(franchiseKeys);
    expect(keys).toHaveLength(32);
  });

  it("clears WCAG AA 4.5:1 on the page ground for every franchise", () => {
    const failures: string[] = [];
    for (const [key, entry] of Object.entries(TEAM_INK)) {
      const measured = contrastOnPaper(entry.ink);
      if (measured < MIN_CONTRAST) {
        failures.push(`${key} ${entry.ink} = ${measured.toFixed(2)}:1`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("records the ratio it actually measures, to 2dp", () => {
    for (const [key, entry] of Object.entries(TEAM_INK)) {
      const measured = Math.round(contrastOnPaper(entry.ink) * 100) / 100;
      expect(`${key}:${entry.ratioOnPaper}`).toBe(`${key}:${measured}`);
    }
  });

  it("darkens rather than recolors — hue direction is preserved", () => {
    for (const [key, entry] of Object.entries(TEAM_INK)) {
      const src = relativeLuminance(entry.sourcePrimary);
      const ink = relativeLuminance(entry.ink);
      expect(`${key} darkened`).toBe(
        ink <= src + 1e-9 ? `${key} darkened` : `${key} LIGHTENED`,
      );
    }
  });

  it("emits only 6-digit hex, never a bare name or rgb() string", () => {
    for (const entry of Object.values(TEAM_INK)) {
      expect(entry.ink).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it("is a negative control on itself: a light color must FAIL the gate", () => {
    // Without this, the contrast test could pass forever on a broken formula.
    expect(contrastOnPaper("#FFB612")).toBeLessThan(MIN_CONTRAST);
    expect(contrastOnPaper(PAPER_HEX)).toBeCloseTo(1, 5);
  });

  it("resolves franchise keys and refuses to invent a fallback color", () => {
    expect(teamInk("jets")).toBe(TEAM_INK.jets.ink);
    expect(teamInk("not-a-team")).toBeNull();
    expect(teamInk(null)).toBeNull();
  });
});
