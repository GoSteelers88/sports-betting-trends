// Unit tests for the de-vig math library. These guard the heart of the
// de-vigged-sharp pivot — if fair-value math drifts, every downstream EV
// number is wrong.

import { describe, it, expect } from "vitest";
import {
  americanToDecimal,
  decimalToAmerican,
  americanToImpliedProb,
  probToAmerican,
  devigImplied,
  devigAmerican,
  noVigFairProbTwoWay,
  expectedValue,
  kellyFraction,
} from "../devig";

const approx = (a: number, b: number, eps = 1e-6) =>
  expect(Math.abs(a - b)).toBeLessThan(eps);

describe("odds conversions", () => {
  it("american → decimal (favourite and underdog)", () => {
    approx(americanToDecimal(-110), 1.909090909, 1e-6);
    approx(americanToDecimal(+150), 2.5);
    approx(americanToDecimal(+100), 2.0);
    approx(americanToDecimal(-200), 1.5);
  });

  it("decimal → american round-trips", () => {
    approx(decimalToAmerican(2.5), 150);
    approx(decimalToAmerican(1.5), -200);
    expect(decimalToAmerican(americanToDecimal(-137))).toBe(-137);
    expect(decimalToAmerican(americanToDecimal(+220))).toBe(220);
  });

  it("implied prob of a pick'em pair sums to >1 (the vig)", () => {
    const a = americanToImpliedProb(-110);
    const b = americanToImpliedProb(-110);
    expect(a + b).toBeGreaterThan(1);
    approx(a + b, 1.047619, 1e-4); // standard -110/-110 ≈ 4.76% overround
  });

  it("probToAmerican is the inverse of impliedProb (fair line)", () => {
    approx(americanToImpliedProb(probToAmerican(0.6)), 0.6, 1e-6);
    approx(americanToImpliedProb(probToAmerican(0.25)), 0.25, 1e-6);
  });

  it("rejects garbage input with NaN", () => {
    expect(americanToDecimal(0)).toBeNaN();
    expect(americanToDecimal(NaN)).toBeNaN();
    expect(probToAmerican(0)).toBeNaN();
    expect(probToAmerican(1)).toBeNaN();
    expect(probToAmerican(1.2)).toBeNaN();
  });
});

describe("devig — multiplicative (default)", () => {
  it("a perfectly symmetric -110/-110 de-vigs to 50/50", () => {
    const res = devigAmerican([-110, -110]);
    expect(res).not.toBeNull();
    approx(res!.fair[0], 0.5);
    approx(res!.fair[1], 0.5);
    approx(res!.fair[0] + res!.fair[1], 1);
    approx(res!.overround, 0.047619, 1e-4);
  });

  it("recovers fair probs from a vig-laden favourite/dog and they sum to 1", () => {
    // -200 / +170 — clear favourite
    const res = devigAmerican([-200, +170]);
    expect(res).not.toBeNull();
    approx(res!.fair[0] + res!.fair[1], 1);
    // favourite implied ~0.667, dog ~0.370, sum 1.037 overround
    expect(res!.fair[0]).toBeGreaterThan(0.6);
    expect(res!.fair[0]).toBeLessThan(res!.fair[0] / res!.fair[1] > 1 ? 1 : 1);
    expect(res!.fair[0]).toBeGreaterThan(res!.fair[1]);
  });

  it("two-way sugar matches the vector form", () => {
    const sugar = noVigFairProbTwoWay(-130, +110);
    const vec = devigAmerican([-130, +110]);
    approx(sugar!.fairA, vec!.fair[0]);
    approx(sugar!.fairB, vec!.fair[1]);
  });
});

describe("devig — all methods agree on direction and normalize", () => {
  const prices = [-150, +130];
  for (const method of ["multiplicative", "additive", "power", "shin"] as const) {
    it(`${method}: fair probs sum to 1 and keep favourite > dog`, () => {
      const res = devigAmerican(prices, method);
      expect(res, method).not.toBeNull();
      approx(res!.fair[0] + res!.fair[1], 1, 1e-5);
      expect(res!.fair[0]).toBeGreaterThan(res!.fair[1]); // favourite heavier
      expect(res!.fair[0]).toBeLessThan(americanToImpliedProb(-150)); // vig stripped
    });
  }

  it("shin shades the favourite below multiplicative (longshot insurance)", () => {
    const mult = devigAmerican([-300, +240], "multiplicative")!;
    const shin = devigAmerican([-300, +240], "shin")!;
    // Shin pulls probability away from the heavy favourite toward the longshot
    expect(shin.fair[0]).toBeLessThanOrEqual(mult.fair[0] + 1e-9);
    expect(shin.z).toBeGreaterThanOrEqual(0);
  });

  it("power exponent k > 1 when there is overround", () => {
    const res = devigAmerican([-150, +130], "power")!;
    expect(res.k).toBeGreaterThan(1);
  });
});

describe("devig — guards", () => {
  it("returns null on out-of-range implied probs", () => {
    expect(devigImplied([1.2, 0.3])).toBeNull();
    expect(devigImplied([0.5])).toBeNull(); // need ≥2 outcomes
    expect(devigImplied([NaN, 0.5])).toBeNull();
  });

  it("handles a 3-way market (sums to 1)", () => {
    // soccer-style implied probs with vig
    const res = devigImplied([0.45, 0.30, 0.32]); // sum 1.07
    expect(res).not.toBeNull();
    approx(res!.fair.reduce((s, p) => s + p, 0), 1, 1e-6);
  });
});

describe("expected value + kelly", () => {
  it("EV is positive when the offered price beats fair value", () => {
    // fair prob 0.55 (true line -122). Offered +110 (implied 0.476) → +EV.
    const ev = expectedValue(0.55, +110);
    expect(ev).toBeGreaterThan(0);
    approx(ev, 0.55 * 2.1 - 1, 1e-9);
  });

  it("EV is negative when paying vig at fair value", () => {
    // true 50/50 but offered -110 → negative EV equal to the vig
    const ev = expectedValue(0.5, -110);
    expect(ev).toBeLessThan(0);
    approx(ev, 0.5 * americanToDecimal(-110) - 1, 1e-9);
  });

  it("kelly is 0 with no edge and positive with edge", () => {
    expect(kellyFraction(0.5, -110)).toBe(0); // no edge → no bet
    expect(kellyFraction(0.55, +110)).toBeGreaterThan(0);
    // quarter-kelly is a quarter of full
    const full = kellyFraction(0.6, +120, 1);
    const quarter = kellyFraction(0.6, +120, 0.25);
    approx(quarter, full * 0.25, 1e-9);
  });

  it("kelly never goes negative", () => {
    expect(kellyFraction(0.3, -200)).toBe(0);
  });
});
