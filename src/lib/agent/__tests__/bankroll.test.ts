// Unit tests for the bankroll guard. Safety-critical: any bug here ships
// extra exposure or drops the wrong picks.

import { describe, it, expect } from "vitest";
import { applyBankrollGuard } from "../bankroll";
import type { GradedPick } from "../grader";

function pick(over: Partial<GradedPick> = {}): GradedPick {
  return {
    matchup: "Yankees @ Red Sox",
    market: "moneyline",
    selection: "Yankees",
    oddsAmerican: -130,
    modelProb: 0.6,
    marketProb: 0.55,
    edge: 0.05,
    kellyStakeUnits: 1.0,
    confidence: 65,
    thesis: "test",
    invalidation: "test",
    signals: [],
    graderOk: true,
    graderNotes: [],
    ...over,
  };
}

describe("applyBankrollGuard", () => {
  it("keeps all picks when total stake is under cap", () => {
    const picks = [pick({ kellyStakeUnits: 1 }), pick({ matchup: "A @ B", selection: "A", kellyStakeUnits: 1 })];
    const result = applyBankrollGuard(picks);
    expect(result.kept).toHaveLength(2);
    expect(result.dropped).toHaveLength(0);
  });

  it("drops same-game duplicates, keeping highest edge", () => {
    const a = pick({ matchup: "A @ B", selection: "A", edge: 0.05, kellyStakeUnits: 1 });
    const b = pick({ matchup: "A @ B", selection: "A", edge: 0.10, kellyStakeUnits: 1 });
    const result = applyBankrollGuard([a, b]);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0].edge).toBe(0.10);
    expect(result.dropped).toHaveLength(1);
  });

  it("collapses 'A @ B' and 'B vs A' as the same game", () => {
    const a = pick({ matchup: "Lakers @ Celtics", selection: "Lakers", edge: 0.06, kellyStakeUnits: 1 });
    const b = pick({ matchup: "Celtics vs Lakers", selection: "Lakers", edge: 0.07, kellyStakeUnits: 1 });
    const result = applyBankrollGuard([a, b]);
    expect(result.kept).toHaveLength(1);
    expect(result.dropped).toHaveLength(1);
  });

  it("trims by worst edge/stake when over cap", () => {
    // 3 picks at 2u each = 6u (over 5u cap). Should drop the worst edge/stake.
    const a = pick({ matchup: "A @ B", selection: "A", edge: 0.10, kellyStakeUnits: 2 });
    const b = pick({ matchup: "C @ D", selection: "C", edge: 0.04, kellyStakeUnits: 2 }); // worst ratio
    const c = pick({ matchup: "E @ F", selection: "E", edge: 0.08, kellyStakeUnits: 2 });
    const result = applyBankrollGuard([a, b, c]);
    expect(result.totalUnits).toBeLessThanOrEqual(5);
    // The 0.04-edge pick should be dropped first
    expect(result.dropped.some(d => d.pick.edge === 0.04)).toBe(true);
  });

  it("does not trim a slate that sums to exactly cap (float-epsilon)", () => {
    const a = pick({ matchup: "A @ B", selection: "A", kellyStakeUnits: 2.5 });
    const b = pick({ matchup: "C @ D", selection: "C", kellyStakeUnits: 2.5 });
    const result = applyBankrollGuard([a, b]);
    expect(result.kept).toHaveLength(2);
    expect(result.dropped).toHaveLength(0);
  });

  it("flags road-dog cluster (3+) without dropping", () => {
    const picks = [
      pick({ matchup: "Sox @ Yankees", selection: "Sox", oddsAmerican: 150, kellyStakeUnits: 0.5 }),
      pick({ matchup: "Royals @ Astros", selection: "Royals", oddsAmerican: 180, kellyStakeUnits: 0.5 }),
      pick({ matchup: "Pirates @ Cubs", selection: "Pirates", oddsAmerican: 130, kellyStakeUnits: 0.5 }),
    ];
    const result = applyBankrollGuard(picks);
    expect(result.kept).toHaveLength(3);
    expect(result.flags.some(f => /road-dog/.test(f))).toBe(true);
  });

  it("recognizes road dog with 'vs' format (home vs away convention)", () => {
    const picks = [
      pick({ matchup: "Yankees vs Sox", selection: "Sox", oddsAmerican: 150, kellyStakeUnits: 0.5 }),
      pick({ matchup: "Astros vs Royals", selection: "Royals", oddsAmerican: 180, kellyStakeUnits: 0.5 }),
      pick({ matchup: "Cubs vs Pirates", selection: "Pirates", oddsAmerican: 130, kellyStakeUnits: 0.5 }),
    ];
    const result = applyBankrollGuard(picks);
    expect(result.flags.some(f => /road-dog/.test(f))).toBe(true);
  });
});
