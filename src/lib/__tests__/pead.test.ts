// Unit tests for the PEAD paper book's pure logic (peadLogic.ts). The rule is
// pre-registered in PEAD_PAPER_SPEC.md — these tests pin its semantics.

import { describe, it, expect } from "vitest";
import {
  PEAD_CONFIG,
  surprisePct,
  qualifies,
  calendarRange,
  exitDueISO,
  isExitDue,
  excessReturnPct,
  meanTStat,
  killVerdict,
} from "../stocks/peadLogic";

describe("surprisePct", () => {
  it("computes percent surprise against the absolute estimate", () => {
    expect(surprisePct(1.0, 1.25)).toBeCloseTo(25);
    expect(surprisePct(-0.5, -0.4)).toBeCloseTo(20); // smaller loss = positive surprise
  });

  it("returns null for tiny estimates that would fake extreme surprises", () => {
    expect(surprisePct(0.01, 0.05)).toBeNull();
    expect(surprisePct(0.049, 0.1)).toBeNull();
    expect(surprisePct(0.05, 0.1)).not.toBeNull(); // boundary inclusive
  });

  it("returns null for non-finite inputs", () => {
    expect(surprisePct(NaN, 1)).toBeNull();
    expect(surprisePct(1, Infinity)).toBeNull();
  });
});

describe("qualifies", () => {
  const base = { symbol: "ACME", date: "2026-06-09" };

  it("accepts beats at or above the threshold", () => {
    expect(qualifies({ ...base, epsEstimate: 1.0, epsActual: 1.2 }).ok).toBe(true); // +20%
    expect(qualifies({ ...base, epsEstimate: 1.0, epsActual: 1.19 }).ok).toBe(false);
  });

  it("rejects misses and missing data", () => {
    expect(qualifies({ ...base, epsEstimate: 1.0, epsActual: 0.5 }).ok).toBe(false);
    expect(qualifies({ ...base, epsEstimate: null, epsActual: 1.2 }).ok).toBe(false);
    expect(qualifies({ ...base, epsEstimate: 1.0, epsActual: null }).ok).toBe(false);
  });
});

describe("calendarRange", () => {
  it("covers yesterday (AMC reports) through today (BMO reports)", () => {
    const r = calendarRange(new Date("2026-06-10T15:05:00.000Z"));
    expect(r).toEqual({ from: "2026-06-09", to: "2026-06-10" });
  });
});

describe("exit timing", () => {
  it("schedules the exit a full hold period after entry", () => {
    const due = exitDueISO("2026-06-10T15:05:00.000Z", 28);
    expect(due).toBe("2026-07-08T15:05:00.000Z");
  });

  it("is due only at or after the scheduled instant", () => {
    const due = "2026-07-08T15:05:00.000Z";
    expect(isExitDue(due, new Date("2026-07-08T15:04:59.000Z"))).toBe(false);
    expect(isExitDue(due, new Date("2026-07-08T15:05:00.000Z"))).toBe(true);
    expect(isExitDue("not-a-date", new Date())).toBe(false);
  });
});

describe("excessReturnPct", () => {
  it("subtracts the SPY return over the identical window", () => {
    // stock +10%, SPY +2% → +8pp excess
    expect(excessReturnPct(100, 110, 500, 510)).toBeCloseTo(8);
  });

  it("falls back to the raw return when a benchmark leg is missing", () => {
    expect(excessReturnPct(100, 110, null, 510)).toBeCloseTo(10);
  });

  it("returns null for nonsensical prices", () => {
    expect(excessReturnPct(0, 110, 500, 510)).toBeNull();
  });
});

describe("meanTStat / killVerdict", () => {
  it("computes a one-sample t-stat", () => {
    const { n, mean, t } = meanTStat([1, 2, 3, 4]);
    expect(n).toBe(4);
    expect(mean).toBeCloseTo(2.5);
    expect(t).toBeCloseTo(2.5 / (Math.sqrt(5 / 3) / 2)); // se = sd/√n
  });

  it("accumulates below the minimum sample", () => {
    expect(killVerdict(Array(PEAD_CONFIG.killMinSettles - 1).fill(1))).toBe("accumulating");
  });

  it("kills on non-positive mean excess at the gate", () => {
    expect(killVerdict(Array(40).fill(-0.5))).toBe("kill");
  });

  it("validates a positive mean with t ≥ 2", () => {
    // constant positive values → enormous t? sd=0 → se=0 → t null. Use a
    // realistic spread instead.
    const xs = Array.from({ length: 40 }, (_, i) => 1 + (i % 2 === 0 ? 0.5 : -0.5));
    expect(killVerdict(xs)).toBe("validated");
  });

  it("extends an inconclusive positive mean, then kills at n=80", () => {
    const noisy = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 5 : -4.8));
    expect(killVerdict(noisy)).toBe("extend");
    const noisy80 = Array.from({ length: 80 }, (_, i) => (i % 2 === 0 ? 5 : -4.9));
    const v = killVerdict(noisy80);
    expect(["kill", "validated"]).toContain(v); // decided either way at n=80, never "extend"
  });
});
