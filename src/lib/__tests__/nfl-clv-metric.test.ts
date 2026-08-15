// nfl-clv-metric — devig-correct CLV, sharp benchmarks, props realized verdict (rec 2).

import { describe, expect, it } from "vitest";

import {
  angleHealth,
  clvVerdict,
  isSharpBenchmark,
  propsRealizedVerdict,
  summarizeBeatRate,
} from "../nfl-clv-metric";

describe("clvVerdict", () => {
  it("reproduces the documented flattery: -195 entry vs -220 close reads ~+4% raw but under 1% devigged", () => {
    // Close two-sided: -220 / +180 (a 30-cent line, per the cited example).
    const v = clvVerdict(-195, {
      book: "pinnacle",
      sideAmerican: -220,
      otherAmerican: 180,
    });
    // (Unabated's "+4%" is the decimal-odds EV ratio; in probability points
    // the same example is ~2.6pp raw.)
    expect(v.rawClvPp).toBeGreaterThan(2);
    expect(v.rawClvPp).toBeLessThan(3.5);
    expect(v.devigClvPp).toBeLessThan(1.5);
    expect(v.devigClvPp).toBeGreaterThan(-0.5);
    // Raw CLV overstates by more than 3× — the whole point of rec 2.
    expect(v.rawClvPp / Math.max(v.devigClvPp, 0.1)).toBeGreaterThan(3);
    expect(v.benchmarkIsSharp).toBe(true);
  });

  it("flags a beat when the fair close exceeds the entry implied", () => {
    // Entry +150 (implied 40%); close -130/+110 → our side fair well above 40%? No:
    // we took +150 and it closed -130 on our side → strong beat.
    const beat = clvVerdict(150, { book: "pinnacle", sideAmerican: -130, otherAmerican: 110 });
    expect(beat.beatClose).toBe(true);
    expect(beat.evAtClosePct).toBeGreaterThan(0);
    // Entry -130; closed +120 on our side → the market moved away. No beat.
    const missed = clvVerdict(-130, { book: "pinnacle", sideAmerican: 120, otherAmerican: -140 });
    expect(missed.beatClose).toBe(false);
    expect(missed.evAtClosePct).toBeLessThan(0);
  });

  it("marks non-sharp benchmarks for the audit counter", () => {
    const v = clvVerdict(-110, { book: "draftkings", sideAmerican: -115, otherAmerican: -105 });
    expect(v.benchmarkIsSharp).toBe(false);
    expect(isSharpBenchmark("Pinnacle")).toBe(true);
    expect(isSharpBenchmark("circa")).toBe(true);
    expect(isSharpBenchmark("consensus")).toBe(false);
  });
});

describe("summarizeBeatRate", () => {
  it("counts only sharp benchmarks and excludes soft-book verdicts entirely", () => {
    const beat = clvVerdict(150, { book: "pinnacle", sideAmerican: -130, otherAmerican: 110 });
    const sharpMiss = clvVerdict(-130, { book: "circa", sideAmerican: 120, otherAmerican: -140 });
    const softBeat = clvVerdict(150, { book: "draftkings", sideAmerican: -130, otherAmerican: 110 });
    const s = summarizeBeatRate([beat, beat, sharpMiss, softBeat]);
    expect(s.n).toBe(3); // the DK verdict is refused, not counted
    expect(s.beats).toBe(2);
    expect(s.beatRate).toBeCloseTo(2 / 3, 6);
    expect(s.nonSharpExcluded).toBe(1);
    expect(s.avgRawClvPp).toBeGreaterThan(s.avgDevigClvPp); // raw always flatters
    expect(s.beatRateWilson95.low).toBeGreaterThan(0);
    expect(s.beatRateWilson95.high).toBeLessThan(1);
  });

  it("handles the empty ledger", () => {
    const s = summarizeBeatRate([]);
    expect(s.n).toBe(0);
    expect(s.beatRate).toBe(0);
  });
});

describe("propsRealizedVerdict", () => {
  it("computes record, Wilson CI, and flat-stake ROI at actual odds — no CLV anywhere", () => {
    const v = propsRealizedVerdict([
      { result: "win", oddsAmerican: -115 },
      { result: "win" }, // defaults -110
      { result: "loss", oddsAmerican: -120 },
      { result: "push" },
    ]);
    expect(v.n).toBe(3);
    expect(v.pushes).toBe(1);
    expect(v.wins).toBe(2);
    expect(v.winRate).toBeCloseTo(2 / 3, 6);
  });

  it("gets the arithmetic right", () => {
    const v = propsRealizedVerdict([
      { result: "win" },
      { result: "loss" },
    ]);
    expect(v.winRate).toBeCloseTo(0.5, 6);
    expect(v.roiPct).toBeCloseTo(((100 / 110 - 1) / 2) * 100, 4);
    expect(v.winRateWilson95.low).toBeLessThan(0.5);
    expect(v.winRateWilson95.high).toBeGreaterThan(0.5);
  });
});

describe("angleHealth (dual ledger)", () => {
  it("kills only when BOTH ledgers are negative", () => {
    expect(angleHealth(0.45, -3)).toBe("dead");
    expect(angleHealth(0.45, +4)).toBe("watch"); // CLV flunks, ROI vindicates
    expect(angleHealth(0.58, -2)).toBe("watch");
    expect(angleHealth(0.58, +2)).toBe("healthy");
  });

  it("never rules below the n floor — three verdicts cannot kill an angle", () => {
    expect(angleHealth(0.0, -50, 3)).toBe("watch");
    expect(angleHealth(1.0, +50, 3)).toBe("watch");
    expect(angleHealth(0.45, -3, 60)).toBe("dead");
  });
});
