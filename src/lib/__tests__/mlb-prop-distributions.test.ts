// Unit tests for the MLB per-stat distributional projector. The invariants
// that matter for a milestone ladder: P(≥k) is monotone decreasing in k; a
// higher per-game rate raises every rung; thin samples shrink the tails toward
// the prior; and a known fixture lands in a sane range.

import { describe, it, expect } from "vitest";
import {
  weightedMoments,
  poissonSf,
  nbPmf,
  nbSf,
  distributionFor,
  seriesFor,
  MLB_STAT_SPEC_BY_STAT,
  type PlayerGameLog,
} from "../mlb-prop-distributions";

const LEAGUE_AVERAGES = {
  batter_hits: 1.067,
  batter_home_runs: 0.133,
  batter_rbis: 0.382,
  batter_runs_scored: 0.571,
  pitcher_strikeouts: 1.117,
  pitcher_earned_runs: 0.933,
};

// Build a player whose every game has the given stat value (constant series of
// length n). Constant series → zero variance → exercises the Poisson/prior
// dispersion fallback path. Vary values to test rate sensitivity.
function makePlayer(stat: string, values: number[], team = "Test Team"): PlayerGameLog {
  return {
    displayName: "Test Player",
    team,
    // file order is newest-first; values are given oldest→newest, so reverse.
    games: [...values].reverse().map((v, i) => ({
      date: `2026-05-${String(20 - i).padStart(2, "0")}T22:00Z`,
      opponent: "Opp Team",
      stats: { [stat]: v },
    })),
  };
}

describe("poissonSf", () => {
  it("is a proper survival function: monotone decreasing, P(≥0)=1", () => {
    expect(poissonSf(0, 1.5)).toBe(1);
    const a = poissonSf(1, 1.5);
    const b = poissonSf(2, 1.5);
    const c = poissonSf(3, 1.5);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });
  it("matches the analytic Poisson tail for λ=1 (P(≥1)=1−e^-1≈0.632)", () => {
    expect(poissonSf(1, 1)).toBeCloseTo(1 - Math.exp(-1), 4);
  });
  it("returns 0 mass above 0 when λ=0", () => {
    expect(poissonSf(1, 0)).toBe(0);
    expect(poissonSf(0, 0)).toBe(1);
  });
});

describe("nbPmf / nbSf", () => {
  it("nbPmf sums to ~1 over a wide support", () => {
    let s = 0;
    for (let j = 0; j < 60; j++) s += nbPmf(j, 2, 5);
    expect(s).toBeCloseTo(1, 3);
  });
  it("NB has a HEAVIER tail than Poisson at the same mean (over-dispersion)", () => {
    const mean = 1.2;
    const nbTail = nbSf(3, mean, 3); // small r ⇒ over-dispersed
    const poisTail = poissonSf(3, mean);
    expect(nbTail).toBeGreaterThan(poisTail);
  });
  it("NB → Poisson as r → ∞", () => {
    const mean = 1.5;
    expect(nbSf(2, mean, 1e6)).toBeCloseTo(poissonSf(2, mean), 3);
  });
  it("nbSf is monotone decreasing in k and P(≥0)=1", () => {
    expect(nbSf(0, 1.5, 4)).toBe(1);
    expect(nbSf(1, 1.5, 4)).toBeGreaterThan(nbSf(2, 1.5, 4));
    expect(nbSf(2, 1.5, 4)).toBeGreaterThan(nbSf(3, 1.5, 4));
  });
});

describe("weightedMoments", () => {
  it("weights the most recent game heaviest", () => {
    // rising series: newest (2.0) heaviest ⇒ weighted mean > simple mean (1.5)
    const { mean } = weightedMoments([1, 1, 1, 2, 2, 2]);
    expect(mean).toBeGreaterThan(1.5);
  });
  it("zero variance on a constant series", () => {
    const { variance } = weightedMoments([2, 2, 2, 2, 2]);
    expect(variance).toBeCloseTo(0, 6);
  });
});

describe("seriesFor", () => {
  it("synthesizes Total Bases from hits + HR when the feed has no TB key", () => {
    const player: PlayerGameLog = {
      displayName: "Slugger",
      team: "Test Team",
      games: [
        { date: "2026-05-20T22:00Z", opponent: "Opp", stats: { batter_hits: 2, batter_home_runs: 1 } },
        { date: "2026-05-19T22:00Z", opponent: "Opp", stats: { batter_hits: 1, batter_home_runs: 0 } },
      ],
    };
    const spec = MLB_STAT_SPEC_BY_STAT.batter_total_bases;
    const res = seriesFor(player.games, spec)!;
    expect(res.derived).toBe(true);
    // game1: 1 HR (4) + 1 non-HR hit (1.28) = 5.28 ; game2: 1.28
    // oldest→newest: [1.28, 5.28]
    expect(res.values).toHaveLength(2);
    expect(res.values[0]).toBeCloseTo(1.28, 2);
    expect(res.values[1]).toBeCloseTo(5.28, 2);
  });
});

describe("distributionFor — ladder invariants", () => {
  const hitsSpec = MLB_STAT_SPEC_BY_STAT.batter_hits;

  it("produces a monotone-decreasing ladder P(≥1) ≥ P(≥2) ≥ …", () => {
    const player = makePlayer("batter_hits", [1, 2, 1, 0, 2, 1, 3, 1]);
    const dist = distributionFor(player, hitsSpec, LEAGUE_AVERAGES)!;
    const probs = dist.ladder.map(r => r.prob);
    for (let i = 1; i < probs.length; i++) {
      expect(probs[i]).toBeLessThanOrEqual(probs[i - 1]);
    }
  });

  it("a HIGHER per-game rate raises every rung", () => {
    const cold = distributionFor(makePlayer("batter_hits", [0, 1, 0, 1, 0, 1, 0, 1]), hitsSpec, LEAGUE_AVERAGES)!;
    const hot = distributionFor(makePlayer("batter_hits", [2, 3, 2, 3, 2, 3, 2, 3]), hitsSpec, LEAGUE_AVERAGES)!;
    expect(hot.mean).toBeGreaterThan(cold.mean);
    for (let i = 0; i < cold.ladder.length; i++) {
      expect(hot.ladder[i].prob).toBeGreaterThan(cold.ladder[i].prob);
    }
  });

  it("SHRINKS a thin small-n sample toward the league prior (tames the tail)", () => {
    // Same hot rate, but n=2 (below MIN_GAMES) vs n=20. The thin sample must be
    // pulled harder toward the league prior → a LOWER P(≥2) than the long one.
    const thin = distributionFor(makePlayer("batter_hits", [3, 3]), hitsSpec, LEAGUE_AVERAGES)!;
    const thick = distributionFor(
      makePlayer("batter_hits", Array(20).fill(3)),
      hitsSpec,
      LEAGUE_AVERAGES,
    )!;
    expect(thin.lowConfidence).toBe(true);
    expect(thick.lowConfidence).toBe(false);
    expect(thin.mean).toBeLessThan(thick.mean); // shrinkage pulled the thin mean down
    const thinP2 = thin.ladder.find(r => r.threshold === 2)!.prob;
    const thickP2 = thick.ladder.find(r => r.threshold === 2)!.prob;
    expect(thinP2).toBeLessThan(thickP2);
  });

  it("known fixture: a ~1.0 hits/game contact hitter lands P(≥1) in a sane band", () => {
    // A steady 1-hit-a-game hitter over a real-length sample. P(≥1) should be a
    // solid majority but NOT pinned near 1 (the shrinkage + dispersion floor
    // keep it honest). Empirically ~0.55–0.75.
    const player = makePlayer("batter_hits", [1, 1, 0, 1, 2, 1, 0, 1, 1, 2, 1, 0]);
    const dist = distributionFor(player, hitsSpec, LEAGUE_AVERAGES)!;
    const p1 = dist.ladder.find(r => r.threshold === 1)!.prob;
    expect(p1).toBeGreaterThan(0.5);
    expect(p1).toBeLessThan(0.85);
  });

  it("clamps every rung strictly inside (0,1)", () => {
    const player = makePlayer("batter_hits", Array(15).fill(4)); // extreme
    const dist = distributionFor(player, hitsSpec, LEAGUE_AVERAGES)!;
    for (const r of dist.ladder) {
      expect(r.prob).toBeGreaterThan(0);
      expect(r.prob).toBeLessThan(1);
    }
  });

  it("flags the Total Bases distribution as derived", () => {
    const player: PlayerGameLog = {
      displayName: "Slugger",
      team: "Test Team",
      games: Array(8)
        .fill(0)
        .map((_, i) => ({
          date: `2026-05-${String(20 - i).padStart(2, "0")}T22:00Z`,
          opponent: "Opp",
          stats: { batter_hits: 1, batter_home_runs: i % 4 === 0 ? 1 : 0 },
        })),
    };
    const dist = distributionFor(player, MLB_STAT_SPEC_BY_STAT.batter_total_bases, LEAGUE_AVERAGES)!;
    expect(dist.derived).toBe(true);
    expect(dist.notes.some(n => /synthesized/i.test(n))).toBe(true);
  });

  it("returns null when a non-synthesizable stat has no feed signal", () => {
    // A player with only HR data asked for pitcher strikeouts → no series.
    const player = makePlayer("batter_home_runs", [1, 0, 1]);
    const dist = distributionFor(player, MLB_STAT_SPEC_BY_STAT.pitcher_strikeouts, LEAGUE_AVERAGES);
    expect(dist).toBeNull();
  });
});
