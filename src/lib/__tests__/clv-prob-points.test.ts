import { describe, it, expect } from "vitest";
import { clvProbPoints, americanToImpliedProb } from "../devig";

// ─────────────────────────────────────────────────────────────────────────────
// Regression cover for the CLV units bug.
//
// clvCents stored `pickedOdds - closingOdds` — a raw subtraction of American
// odds. American odds are discontinuous at ±100 (+100 and −100 are both 50%
// implied yet subtract to 200), so any move across the boundary had its
// magnitude inflated by ~200. Three such picks ended up carrying 98% of the
// paper trial's entire CLV total and flipped the pre-registered
// "avg CLV ≥ +2¢" funding gate from FAIL to PASS on an artifact.
//
// The SIGN was always right (raw American value is monotonically decreasing in
// probability), which is why the beat-rate never looked wrong and the bug hid
// for the whole trial. These tests pin both properties: sign preserved,
// magnitude sane.
// ─────────────────────────────────────────────────────────────────────────────

describe("clvProbPoints — the ±100 boundary", () => {
  it("reads a boundary-crossing move as its true ~1.5 points, not 206", () => {
    // The real pick: took +102 (49.50%), closed −104 (50.98%).
    const pp = clvProbPoints(102, -104);
    expect(pp).toBeCloseTo(1.48, 1);
    // The legacy figure for the same move:
    expect(102 - -104).toBe(206);
  });

  it("handles the other two picks that carried the trial's average", () => {
    expect(clvProbPoints(106, -104)).toBeCloseTo(2.44, 1); // legacy said 210
    expect(clvProbPoints(112, -121)).toBeCloseTo(7.58, 1); // legacy said 233
  });

  it("treats +100 and -100 as the same price — zero CLV, not 200", () => {
    expect(clvProbPoints(100, -100)).toBeCloseTo(0, 6);
    expect(clvProbPoints(-100, 100)).toBeCloseTo(0, 6);
    expect(americanToImpliedProb(100)).toBeCloseTo(americanToImpliedProb(-100), 10);
  });
});

describe("clvProbPoints — sign and orientation", () => {
  it("is positive when we took a longer price than the close", () => {
    // Took +150, closed +120: we got the better number.
    expect(clvProbPoints(150, 120)).toBeGreaterThan(0);
    expect(clvProbPoints(-105, -125)).toBeGreaterThan(0);
  });

  it("is negative when the price we took was worse than the close", () => {
    expect(clvProbPoints(120, 150)).toBeLessThan(0);
    expect(clvProbPoints(-125, -105)).toBeLessThan(0);
  });

  it("is zero when nothing moved", () => {
    for (const a of [-250, -110, -100, 100, 145, 600]) {
      expect(clvProbPoints(a, a)).toBeCloseTo(0, 10);
    }
  });

  it("agrees in SIGN with the legacy subtraction on every ordinary case", () => {
    // The legacy column's sign was trustworthy — that is exactly why the bad
    // magnitude survived undetected. Pin it so the backfill's sign-preservation
    // assertion stays meaningful.
    const prices = [-400, -250, -150, -110, -105, -100, 100, 105, 110, 150, 250, 400];
    for (const taken of prices) {
      for (const close of prices) {
        const legacy = Math.sign(taken - close);
        const correct = Math.sign(+clvProbPoints(taken, close).toFixed(6));
        if (legacy !== 0 && correct !== 0) {
          expect(correct, `taken ${taken} close ${close}`).toBe(legacy);
        }
      }
    }
  });
});

describe("clvProbPoints — magnitude is bounded and sane", () => {
  it("never exceeds 100 points, unlike the legacy cents figure", () => {
    const prices = [-2000, -400, -110, -100, 100, 110, 400, 2000];
    for (const taken of prices) {
      for (const close of prices) {
        const pp = clvProbPoints(taken, close);
        expect(Math.abs(pp)).toBeLessThanOrEqual(100);
      }
    }
    // The legacy measure had no such bound — this pair alone "scored" 4000.
    expect(Math.abs(2000 - -2000)).toBe(4000);
  });

  it("returns NaN on unusable prices rather than a bogus number", () => {
    expect(Number.isNaN(clvProbPoints(NaN, -110))).toBe(true);
    expect(Number.isNaN(clvProbPoints(-110, NaN))).toBe(true);
  });

  it("scales sensibly for a typical two-cent move", () => {
    // The pre-registered gate was +2¢, which is ~0.46pp at standard -110
    // pricing. That conversion is what trial-status.ts encodes as 0.45.
    expect(Math.abs(clvProbPoints(-110, -108))).toBeCloseTo(0.458, 2);
  });
});
