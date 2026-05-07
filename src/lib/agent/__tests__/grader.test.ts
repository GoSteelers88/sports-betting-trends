// Unit tests for the local pick rubric grader. Hard-fail conditions must
// be enforced or the analyst can ship picks below threshold.

import { describe, it, expect } from "vitest";
import { gradePicks } from "../grader";
import type { AnalystPick } from "../analyst";

function pick(over: Partial<AnalystPick> = {}): AnalystPick {
  return {
    matchup: "A @ B",
    market: "moneyline",
    selection: "A",
    oddsAmerican: -130,
    modelProb: 0.62,
    marketProb: 0.55,
    edge: 0.07, // clears the 6% floor with headroom
    kellyStakeUnits: 1.0,
    confidence: 65,
    thesis: "this is a long enough thesis to pass the minimum 80 character threshold imposed by the grader function",
    invalidation: "if X happens this is wrong",
    signals: ["test"],
    ...over,
  };
}

describe("gradePicks", () => {
  it("keeps a healthy pick", () => {
    const out = gradePicks([pick()]);
    expect(out).toHaveLength(1);
    expect(out[0].graderOk).toBe(true);
  });

  it("drops a pick below the 6% edge threshold", () => {
    // 5% edge — used to pass the old 3% floor, must fail the new 6% floor.
    const out = gradePicks([pick({ edge: 0.05, modelProb: 0.60, marketProb: 0.55 })]);
    expect(out).toHaveLength(0);
  });

  it("keeps a pick just above the 6% edge floor", () => {
    // 6.5% computed — comfortably above the floor and float-fuzz-safe.
    const out = gradePicks([pick({ edge: 0.065, modelProb: 0.615, marketProb: 0.55 })]);
    expect(out).toHaveLength(1);
  });

  it("drops a pick with thesis too short", () => {
    const out = gradePicks([pick({ thesis: "too short" })]);
    expect(out).toHaveLength(0);
  });

  it("drops a pick with no invalidation", () => {
    const out = gradePicks([pick({ invalidation: "" })]);
    expect(out).toHaveLength(0);
  });

  it("clamps stake at 2u when over cap", () => {
    const out = gradePicks([pick({ kellyStakeUnits: 5 })]);
    expect(out).toHaveLength(1);
    expect(out[0].kellyStakeUnits).toBeLessThanOrEqual(2);
  });

  it("drops picks with NaN/out-of-range probabilities", () => {
    const out = gradePicks([pick({ modelProb: NaN })]);
    expect(out).toHaveLength(0);
  });

  it("drops picks where claimed edge mismatches computed edge by >0.5%", () => {
    // model 0.62, market 0.55, computed = 0.07; claim 0.12 = mismatch.
    // Computed 7% still clears the 6% floor, so the pick survives with a
    // SOFT note rather than a HARD drop.
    const out = gradePicks([pick({ edge: 0.12 })]);
    expect(out).toHaveLength(1);
    expect(out[0].graderNotes.some(n => /SOFT/.test(n))).toBe(true);
  });
});
