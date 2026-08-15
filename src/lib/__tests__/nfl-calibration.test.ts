// nfl-calibration — posterior gate, Wilson CI, beta calibration, Kelly (rec 3).

import { describe, expect, it } from "vitest";

import {
  breakevenProb,
  calibrate,
  evaluateBucket,
  evaluateBucketAt,
  fitBetaCalibration,
  kellyStakeFraction,
  logLoss,
  posteriorMeanWinRate,
  wilsonInterval,
} from "../nfl-calibration";

describe("Beta(50,50) posterior gate", () => {
  it("computes -110 breakeven at 52.38%", () => {
    expect(breakevenProb(-110)).toBeCloseTo(0.5238, 4);
  });

  it("blocks zero-evidence and small hot streaks", () => {
    expect(posteriorMeanWinRate(0, 0)).toBeCloseTo(0.5, 9); // prior mean
    expect(evaluateBucket("hot", 5, 0).eligible).toBe(false); // 5-0 not enough
    expect(evaluateBucket("hot", 7, 3).eligible).toBe(false); // 7-3 not enough
  });

  it("passes the documented minimum shapes (8/10, 13/20, 29/50)", () => {
    expect(evaluateBucket("a", 8, 2).eligible).toBe(true);
    expect(evaluateBucket("b", 13, 7).eligible).toBe(true);
    expect(evaluateBucket("c", 29, 21).eligible).toBe(true);
    // one win fewer fails each
    expect(evaluateBucket("a", 7, 3).eligible).toBe(false);
    expect(evaluateBucket("b", 12, 8).eligible).toBe(false);
    expect(evaluateBucket("c", 28, 22).eligible).toBe(false);
  });

  it("excludes pushes from n and rejects impossible records", () => {
    const e = evaluateBucket("d", 10, 5, 3);
    expect(e.n).toBe(15);
    expect(e.pushes).toBe(3);
    expect(() => posteriorMeanWinRate(5, 3)).toThrow();
  });

  it("passes the walk's dog-ATS-shaped bucket (159-93)", () => {
    const e = evaluateBucket("underdog ATS", 159, 93);
    expect(e.posteriorMean).toBeCloseTo((159 + 50) / (252 + 100), 6);
    expect(e.eligible).toBe(true);
  });

  it("gates against the bucket's OWN break-even, not a fixed -110 (review must-fix)", () => {
    // +150 dogs winning 45%: loses the -110 test but is PROFITABLE at its
    // price (break-even 40%) — must be eligible.
    const dogBe = 100 / 250; // implied prob of +150
    const dogs = evaluateBucketAt("ml dogs +150", 450, 550, 0, dogBe);
    expect(dogs.posteriorMean).toBeCloseTo(0.4545, 3);
    expect(dogs.eligible).toBe(true);
    // -300 favorites winning 60%: sails past 52.4% but is LOSING at its price
    // (break-even 75%) — must be ineligible.
    const favBe = 300 / 400;
    const favs = evaluateBucketAt("ml favorites -300", 600, 400, 0, favBe);
    expect(favs.posteriorMean).toBeCloseTo(0.5909, 3);
    expect(favs.eligible).toBe(false);
    // The old fixed-juice gate would have gotten both of these wrong.
    expect(evaluateBucket("wrong-favs", 600, 400).eligible).toBe(true);
    expect(evaluateBucket("wrong-dogs", 450, 550).eligible).toBe(false);
  });
});

describe("wilsonInterval", () => {
  it("matches known values (55/100 → roughly .451-.645)", () => {
    const { low, high } = wilsonInterval(55, 100);
    expect(low).toBeCloseTo(0.4524, 2);
    expect(high).toBeCloseTo(0.6439, 2);
  });

  it("narrows with n and stays in [0,1]", () => {
    const small = wilsonInterval(7, 10);
    const large = wilsonInterval(700, 1000);
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
    expect(wilsonInterval(0, 5).low).toBe(0);
    expect(wilsonInterval(5, 5).high).toBe(1);
  });
});

describe("beta calibration", () => {
  it("a=1,b=1,c=0 is the identity map", () => {
    const id = { a: 1, b: 1, c: 0, n: 0 };
    for (const s of [0.3, 0.5, 0.55, 0.62, 0.7]) {
      expect(calibrate(id, s)).toBeCloseTo(s, 6);
    }
  });

  it("returns the identity when there is too little data to fit", () => {
    const cal = fitBetaCalibration([{ score: 0.6, won: true }]);
    expect(cal).toMatchObject({ a: 1, b: 1, c: 0 });
  });

  it("shrinks overconfident scores toward reality and reduces log loss", () => {
    // Synthetic overconfident picker: claims s, true win prob is
    // 0.5 + 0.4*(s-0.5) — i.e. a 0.70 claim is really 0.58.
    const rand = (() => {
      let seed = 42;
      return () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
    })();
    const samples: Array<{ score: number; won: boolean }> = [];
    for (let i = 0; i < 400; i++) {
      const s = 0.5 + 0.25 * rand();
      const pTrue = 0.5 + 0.4 * (s - 0.5);
      samples.push({ score: s, won: rand() < pTrue });
    }
    const cal = fitBetaCalibration(samples);
    // Calibrated 0.70 should land well below 0.70, near 0.58.
    const c70 = calibrate(cal, 0.7);
    expect(c70).toBeLessThan(0.66);
    expect(c70).toBeGreaterThan(0.5);
    const rawLoss = logLoss(samples);
    const calLoss = logLoss(
      samples.map((s) => ({ score: calibrate(cal, s.score), won: s.won })),
    );
    expect(calLoss).toBeLessThan(rawLoss);
  });
});

describe("kellyStakeFraction", () => {
  it("computes quarter Kelly at p=0.55, -110 (~1.37% of bankroll)", () => {
    expect(kellyStakeFraction(0.55, -110)).toBeCloseTo(0.01375, 3);
  });

  it("stakes zero without an edge and never exceeds the cap", () => {
    expect(kellyStakeFraction(0.52, -110)).toBe(0); // below breakeven
    expect(kellyStakeFraction(0.5238, -110)).toBeCloseTo(0, 3);
    expect(kellyStakeFraction(0.9, -110, 0.5)).toBe(0.03); // capped
    expect(kellyStakeFraction(0, -110)).toBe(0);
    expect(kellyStakeFraction(1, -110)).toBe(0);
  });

  it("scales with the fraction k", () => {
    const quarter = kellyStakeFraction(0.54, -110, 0.25);
    const half = kellyStakeFraction(0.54, -110, 0.5);
    expect(half).toBeCloseTo(quarter * 2, 6);
  });
});
