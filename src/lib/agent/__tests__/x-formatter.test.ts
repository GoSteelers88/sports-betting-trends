import { describe, it, expect } from "vitest";
import { formatPicksForX } from "../x-formatter";
import type { GradedPick } from "../grader";

function pick(over: Partial<GradedPick> = {}): GradedPick {
  return {
    matchup: "Lakers @ Celtics",
    market: "moneyline",
    selection: "Celtics",
    oddsAmerican: -135,
    modelProb: 0.62,
    marketProb: 0.575,
    edge: 0.045,
    kellyStakeUnits: 1.2,
    confidence: 68,
    thesis: "thesis " + "x".repeat(80),
    invalidation: "if x then y",
    signals: ["s1"],
    graderOk: true,
    graderNotes: [],
    ...over,
  };
}

describe("formatPicksForX", () => {
  it("emits a no-picks message when the slate is empty", () => {
    const out = formatPicksForX({ league: "NBA", picks: [], paperTrialDay: 5 });
    expect(out.picksIncluded).toBe(0);
    expect(out.text).toMatch(/No plays today/i);
    expect(out.text).toMatch(/Day 5\/30/);
    expect(out.charCount).toBeLessThanOrEqual(280);
  });

  it("formats a single pick with header + footer", () => {
    const out = formatPicksForX({ league: "NBA", picks: [pick()], paperTrialDay: 2 });
    expect(out.picksIncluded).toBe(1);
    expect(out.charCount).toBeLessThanOrEqual(280);
    expect(out.truncated).toBe(false);
    expect(out.text).toContain("NIGHTLY LOCKS");
    expect(out.text).toContain("NBA");
    expect(out.text).toContain("DAY 2/30");
    expect(out.text).toContain("🏀");
    expect(out.text).toContain("Celtics ML -135");
    expect(out.text).toContain("+4.5% edge");
    expect(out.text).toContain("1 play · 1.2u");
  });

  it("uses the right league emoji per pick when BOTH", () => {
    const picks = [pick({ selection: "Tigers", oddsAmerican: -120, edge: 0.04 }), pick()];
    const out = formatPicksForX({
      league: "BOTH",
      picks,
      pickLeagues: ["MLB", "NBA"],
      paperTrialDay: 7,
    });
    expect(out.text).toContain("⚾ Tigers");
    expect(out.text).toContain("🏀 Celtics");
    expect(out.text).not.toMatch(/· (NBA|MLB|BOTH) ·/); // no league label when BOTH
  });

  it("never exceeds 280 chars even with many picks", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      pick({ selection: `Team${i}`, oddsAmerican: -110, edge: 0.035 + i * 0.001 })
    );
    const out = formatPicksForX({ league: "NBA", picks: many, paperTrialDay: 10 });
    expect(out.charCount).toBeLessThanOrEqual(280);
    expect(out.text.length).toBeLessThanOrEqual(280);
    expect(out.truncated).toBe(true);
    expect(out.picksIncluded).toBeGreaterThan(0);
    expect(out.picksIncluded).toBeLessThan(12);
  });

  it("pluralizes plays correctly", () => {
    const one = formatPicksForX({ league: "NBA", picks: [pick()] });
    expect(one.text).toMatch(/1 play /);
    const three = formatPicksForX({
      league: "NBA",
      picks: [pick(), pick({ selection: "Heat" }), pick({ selection: "Suns" })],
    });
    expect(three.text).toMatch(/3 plays /);
  });

  it("formats positive American odds with a leading +", () => {
    const out = formatPicksForX({
      league: "MLB",
      picks: [pick({ selection: "Tigers", oddsAmerican: 145, edge: 0.05 })],
    });
    expect(out.text).toContain("Tigers ML +145");
  });

  it("works without a paper trial day", () => {
    const out = formatPicksForX({ league: "NBA", picks: [pick()] });
    expect(out.text).not.toMatch(/DAY \d+\/30/);
    expect(out.text).toContain("NIGHTLY LOCKS");
  });

  it("never emits a URL (X charges $0.20/post for URL posts)", () => {
    const out = formatPicksForX({
      league: "NBA",
      picks: [pick(), pick({ selection: "Heat", oddsAmerican: 110, edge: 0.038 })],
      paperTrialDay: 2,
    });
    expect(out.text).not.toMatch(/https?:\/\//);
    expect(out.text).not.toMatch(/\.(com|io|ai|net|vercel\.app)/);
  });

  it("formats edges with one decimal", () => {
    const out = formatPicksForX({
      league: "NBA",
      picks: [pick({ edge: 0.04567 })],
    });
    expect(out.text).toContain("+4.6% edge");
  });
});
