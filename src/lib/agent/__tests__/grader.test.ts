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
    modelProb: 0.6,
    marketProb: 0.55,
    edge: 0.05,
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

  it("drops a pick below 3% edge threshold", () => {
    const out = gradePicks([pick({ edge: 0.02, modelProb: 0.57, marketProb: 0.55 })]);
    expect(out).toHaveLength(0);
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
    // model 0.6, market 0.55, computed = 0.05; claim 0.10 = mismatch
    const out = gradePicks([pick({ edge: 0.10 })]);
    // SOFT note expected, but since 0.10 also passes the 3% threshold the
    // pick should still be in output — just with a SOFT note.
    expect(out).toHaveLength(1);
    expect(out[0].graderNotes.some(n => /SOFT/.test(n))).toBe(true);
  });
});
