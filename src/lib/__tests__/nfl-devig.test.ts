// nfl-devig — vig removal methods and the worst-case envelope (research rec 7).

import { describe, expect, it } from "vitest";

import {
  americanToDecimal,
  americanToImplied,
  decimalToAmerican,
  devigTwoWay,
  devigTwoWayDecimal,
  overround,
  DEVIG_METHODS,
} from "../nfl-devig";

describe("odds conversion", () => {
  it("converts american to decimal both directions", () => {
    expect(americanToDecimal(-110)).toBeCloseTo(1.9091, 4);
    expect(americanToDecimal(200)).toBeCloseTo(3.0, 9);
    expect(decimalToAmerican(3.0)).toBeCloseTo(200, 6);
    expect(decimalToAmerican(1.9091)).toBeCloseTo(-110, 0);
  });

  it("computes the -110/-110 overround", () => {
    expect(overround(-110, -110)).toBeCloseTo(1.0476, 4);
    expect(americanToImplied(-110)).toBeCloseTo(0.5238, 4);
  });
});

describe("devigTwoWay", () => {
  it("all methods agree at a symmetric -110/-110 market", () => {
    const r = devigTwoWay(-110, -110);
    for (const m of DEVIG_METHODS) {
      expect(r.byMethod[m]).toBeCloseTo(0.5, 6);
    }
    expect(r.worstCaseA).toBeCloseTo(0.5, 6);
    expect(r.margin).toBeCloseTo(0.0476, 4);
  });

  it("probabilities for the two sides sum to 1 under every method", () => {
    const dog = devigTwoWay(210, -250); // side A = dog
    const fav = devigTwoWay(-250, 210); // side A = fav
    for (const m of DEVIG_METHODS) {
      expect(dog.byMethod[m] + fav.byMethod[m]).toBeCloseTo(1, 6);
    }
  });

  it("odds-weighted/power/shin give the LONGSHOT less fair probability than naive (the documented distortion)", () => {
    // Refuter-verified example: decimal 1.25 / 4.20, ~4.7% overround.
    // Multiplicative dog ≈ 22.93%, power ≈ 21.88% (~1pp lower).
    const r = devigTwoWayDecimal(4.2, 1.25);
    expect(r.byMethod.multiplicative).toBeCloseTo(0.2293, 3);
    // The published 21.88% reference figure is the odds-weighted closed form.
    expect(r.byMethod.oddsWeighted).toBeCloseTo(0.219, 3);
    expect(r.byMethod.power).toBeLessThan(r.byMethod.multiplicative);
    expect(r.byMethod.shin).toBeLessThan(r.byMethod.multiplicative);
    expect(r.byMethod.shin).toBeGreaterThan(0.19); // sane, not degenerate
    // Worst case is the conservative envelope for boarding a dog.
    expect(r.worstCaseA).toBeLessThanOrEqual(r.byMethod.power + 1e-9);
  });

  it("gives the FAVORITE more fair probability under odds-weighted methods", () => {
    const r = devigTwoWayDecimal(1.25, 4.2);
    expect(r.byMethod.power).toBeGreaterThan(r.byMethod.multiplicative);
    expect(r.byMethod.shin).toBeGreaterThan(r.byMethod.multiplicative);
  });

  it("handles a typical NFL ML market (-192/+160) without degenerating", () => {
    const r = devigTwoWay(160, -192);
    for (const m of DEVIG_METHODS) {
      expect(r.byMethod[m]).toBeGreaterThan(0.35);
      expect(r.byMethod[m]).toBeLessThan(0.4);
    }
    expect(r.margin).toBeGreaterThan(0.02);
    expect(r.margin).toBeLessThan(0.08);
  });

  it("rejects invalid odds", () => {
    expect(() => devigTwoWay(0, -110)).toThrow();
    expect(() => decimalToAmerican(1)).toThrow();
  });
});
