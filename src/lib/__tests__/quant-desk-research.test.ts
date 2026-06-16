import { describe, it, expect } from "vitest";
import {
  pearson,
  correlationPValue,
  scanCorrelations,
  MIN_N,
  type Sample,
} from "../quant-desk/research/correlations";
import { auditCoverage } from "../quant-desk/research/coverage-audit";

describe("pearson", () => {
  it("is 1 for a perfectly increasing line", () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 6);
  });
  it("is -1 for a perfectly decreasing line", () => {
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 6);
  });
  it("is null for a zero-variance vector", () => {
    expect(pearson([1, 1, 1, 1], [1, 2, 3, 4])).toBeNull();
  });
  it("is null below 3 points", () => {
    expect(pearson([1, 2], [1, 2])).toBeNull();
  });
});

describe("correlationPValue", () => {
  it("returns a tiny p for a strong correlation at decent n", () => {
    const p = correlationPValue(0.9, 30);
    expect(p).not.toBeNull();
    expect(p!).toBeLessThan(0.001);
  });
  it("returns a large p for a weak correlation", () => {
    const p = correlationPValue(0.05, 30);
    expect(p!).toBeGreaterThan(0.5);
  });
});

describe("scanCorrelations — discovery + quarantine", () => {
  it("finds a genuinely predictive feature and rejects pure noise", () => {
    const samples: Sample[] = [];
    let seed = 42;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < 80; i++) {
      const x = rng();
      const outcome = rng() < 0.2 + 0.6 * x ? 1 : 0; // x drives the outcome
      samples.push({ features: { x, noise: rng() }, outcome, modelFairProb: 0.5 });
    }
    const scan = scanCorrelations(samples);
    const x = scan.candidates.find((c) => c.feature === "x")!;
    const noise = scan.candidates.find((c) => c.feature === "noise")!;
    expect(x.significant).toBe(true);
    expect(noise.significant).toBe(false);
    // The strongest candidate is ranked first.
    expect(scan.candidates[0].absR).toBeGreaterThanOrEqual(scan.candidates[1].absR);
  });

  it("EVERY surfaced hypothesis carries an out-of-sample validation plan (quarantine)", () => {
    const samples: Sample[] = [];
    for (let i = 0; i < 60; i++) {
      const x = i / 60;
      samples.push({ features: { x }, outcome: i % 2, modelFairProb: 0.5 });
    }
    const scan = scanCorrelations(samples);
    for (const c of scan.candidates) {
      expect(c.validationPlan).toMatch(/HYPOTHESIS \(quarantined\)/);
      expect(c.validationPlan).toMatch(/out-of-sample|held-out/i);
    }
  });

  it("refuses to promote anything below the n floor", () => {
    const samples: Sample[] = [];
    for (let i = 0; i < MIN_N - 1; i++) {
      samples.push({ features: { x: i }, outcome: i % 2, modelFairProb: 0.5 });
    }
    const scan = scanCorrelations(samples);
    expect(scan.hypotheses).toHaveLength(0);
    expect(scan.note).toMatch(/below the n/);
  });
});

describe("auditCoverage — missing-stat detection", () => {
  it("flags a market as missing when its required feed key is absent", () => {
    // MLB gamelog feed WITHOUT stolen bases / batter strikeouts.
    const mlbFields = ["batter_hits", "batter_home_runs", "batter_rbis", "pitcher_strikeouts"];
    const audit = auditCoverage(mlbFields, []);
    const sb = audit.backlog.find((b) => b.market === "Stolen Bases 1+")!;
    expect(sb.status).toBe("missing");
    expect(sb.missingFields).toContain("batter_stolen_bases");
  });

  it("flags Total Bases as SYNTHESIZED when only hits+HR exist (no 2B/3B)", () => {
    const mlbFields = ["batter_hits", "batter_home_runs"];
    const audit = auditCoverage(mlbFields, []);
    const tb = audit.backlog.find((b) => b.market.startsWith("Total Bases"))!;
    expect(tb.status).toBe("synthesized");
    expect(tb.synthesizedFields.length).toBeGreaterThan(0);
  });

  it("flags a covered market when every required field is present", () => {
    const mlbFields = ["batter_hits"];
    const audit = auditCoverage(mlbFields, []);
    const hits = audit.backlog.find((b) => b.market === "Hits 1+/2+")!;
    expect(hits.status).toBe("covered");
  });

  it("ranks higher-impact, lower-difficulty, more-missing items first", () => {
    const audit = auditCoverage(["batter_hits"], []);
    for (let i = 1; i < audit.backlog.length; i++) {
      expect(audit.backlog[i - 1].priority).toBeGreaterThanOrEqual(audit.backlog[i].priority);
    }
  });

  it("detects NFL feed gaps from the games.csv header columns (case-insensitive)", () => {
    // NFL header WITHOUT snap counts / EPA → snap-level + total markets missing.
    const nflFields = ["game_id", "season", "week", "home_team", "away_team", "temp", "wind", "roof"];
    const audit = auditCoverage([], nflFields);
    const weather = audit.backlog.find((b) => b.market === "Weather-adjusted total")!;
    expect(weather.status).toBe("covered"); // temp+wind+roof present
    const snap = audit.backlog.find((b) => b.market.startsWith("Spread (snap"))!;
    expect(snap.status).toBe("missing");
  });
});
