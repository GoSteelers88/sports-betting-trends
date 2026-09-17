import { describe, it, expect } from "vitest";
import {
  impliedProb, gatePick, buildPick, toCandidates,
  CONFIDENCE_FLOOR, EDGE_FLOOR, type LineCandidate,
} from "../nfl-live-props-pick";

const cand = (over: any = { point: 50.5, priceAmerican: -115, book: "dk" }, under: any = { point: 54.5, priceAmerican: -110, book: "fd" }): LineCandidate => ({
  gameId: "2026_02_A_B", matchup: "A @ B", player: "P", team: "A", stat: "recYds", over, under,
});

describe("impliedProb", () => {
  it("is vig-inclusive and correct", () => {
    expect(impliedProb(+100)).toBeCloseTo(0.5, 6);
    expect(impliedProb(-115)).toBeCloseTo(0.5349, 4);
    expect(impliedProb(+150)).toBeCloseTo(0.4, 6);
  });
});

describe("gating", () => {
  it("passes a view below the confidence floor even with a big edge", () => {
    // Deliberately expressed relative to the constant, not a hardcoded number:
    // the floor moved from 0.62 to 0.55 once it was measured against real lines,
    // and a test pinned to the old value fails for the wrong reason.
    const below = CONFIDENCE_FLOOR - 0.05;
    const p = buildPick(cand({ point: 20.5, priceAmerican: +200, book: "dk" }), "over", below, "r")!;
    expect(p.edge).toBeGreaterThan(EDGE_FLOOR); // big edge, still refused
    expect(p.verdict).toBe("pass");
    expect(p.passReason).toMatch(/confidence/);
  });

  it("passes a confident view whose edge does not clear the price", () => {
    // -115 implies 53.5%. Confidence 0.56 is confident enough but only +2.5pp.
    const p = buildPick(cand(), "over", 0.65, "r")!;
    expect(p.edge).toBeCloseTo(0.65 - impliedProb(-115), 6);
    const tight = buildPick(cand({ point: 50.5, priceAmerican: -300, book: "dk" }), "over", 0.70, "r")!;
    expect(tight.verdict).toBe("pass");
    expect(tight.passReason).toMatch(/edge/);
  });

  it("plays only when BOTH floors clear", () => {
    const p = buildPick(cand(), "over", 0.70, "r")!;
    expect(p.verdict).toBe("play");
    expect(p.passReason).toBeNull();
    expect(p.edge).toBeGreaterThanOrEqual(EDGE_FLOOR);
    expect(p.confidence).toBeGreaterThanOrEqual(CONFIDENCE_FLOOR);
  });

  // NEGATIVE CONTROL: a heavy favourite price must not become a play just
  // because the model is confident. -300 implies 75%; 70% confidence is a
  // NEGATIVE edge and has to be refused.
  it("refuses a confident view that is still worse than the price", () => {
    const p = buildPick(cand({ point: 20.5, priceAmerican: -300, book: "dk" }), "over", 0.70, "r")!;
    expect(p.edge).toBeLessThan(0);
    expect(p.verdict).toBe("pass");
  });

  it("returns null when the market does not offer the side the model named", () => {
    expect(buildPick(cand({ point: 50.5, priceAmerican: -115, book: "dk" }, null), "under", 0.9, "r")).toBeNull();
  });
});

describe("toCandidates", () => {
  const line = (side: string, point: number, price: number) => ({
    gameId: "g", matchup: "A @ B", player: "P", team: "A",
    stat: "recYds", side, point, priceAmerican: price, book: "dk",
  });

  it("pairs both sides into one candidate", () => {
    const c = toCandidates([line("over", 50.5, -115), line("under", 54.5, -110)]);
    expect(c).toHaveLength(1);
    expect(c[0].over!.point).toBe(50.5);
    expect(c[0].under!.point).toBe(54.5);
  });

  it("drops lines with no resolved team — they could never be graded", () => {
    expect(toCandidates([{ ...line("over", 50.5, -115), team: "" }])).toHaveLength(0);
  });
});
