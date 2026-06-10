// Unit tests for the PEAD dream's deterministic aggregation. The LLM only
// writes prose over these numbers, so this is where correctness lives.

import { describe, it, expect } from "vitest";
import { computeDreamStats, type DreamRow } from "../stocks/peadDream";

const row = (overrides: Partial<DreamRow> = {}): DreamRow => ({
  status: "closed",
  surprisePct: 30,
  excessRetPct: 2,
  pnlUsd: 10,
  annotation: JSON.stringify({ artifactRisk: "low", revenueConfirmed: true, note: "" }),
  revEstimate: 100,
  revActual: 110,
  ...overrides,
});

describe("computeDreamStats", () => {
  it("splits entries by artifact risk and revenue confirmation", () => {
    const stats = computeDreamStats([
      row(),
      row({ annotation: JSON.stringify({ artifactRisk: "high", revenueConfirmed: false, note: "" }) }),
      row({ annotation: null, revEstimate: null }), // unannotated, revenue unknown
    ]);
    expect(stats.entries.total).toBe(3);
    expect(stats.entries.artifactRisk).toEqual({ low: 1, medium: 0, high: 1, unannotated: 1 });
    expect(stats.entries.revenueConfirmed).toEqual({ yes: 1, no: 1, unknown: 1 });
  });

  it("computes cohort excess stats over closed positions only", () => {
    const stats = computeDreamStats([
      row({ excessRetPct: 4 }),
      row({ excessRetPct: -2 }),
      row({ status: "open", excessRetPct: null }),
    ]);
    expect(stats.performance.all.n).toBe(2);
    expect(stats.performance.all.meanExcessPct).toBeCloseTo(1);
    expect(stats.entries.open).toBe(1);
  });

  it("buckets by surprise magnitude", () => {
    const stats = computeDreamStats([
      row({ surprisePct: 25 }),
      row({ surprisePct: 75 }),
      row({ surprisePct: 150 }),
    ]);
    expect(stats.performance.surprise20to50.n).toBe(1);
    expect(stats.performance.surprise50to100.n).toBe(1);
    expect(stats.performance.surpriseOver100.n).toBe(1);
  });

  it("falls back to the deterministic revenue check when annotation is malformed", () => {
    const stats = computeDreamStats([
      row({ annotation: "not json{", revEstimate: 100, revActual: 90 }),
    ]);
    expect(stats.entries.revenueConfirmed.no).toBe(1);
  });

  it("reports verdict progress against the pre-registered gate", () => {
    const stats = computeDreamStats([row(), row()]);
    expect(stats.verdict).toEqual({ settled: 2, needed: 40, state: "accumulating" });
  });

  it("sums realized P&L from closed rows", () => {
    const stats = computeDreamStats([row({ pnlUsd: 12.5 }), row({ pnlUsd: -2.5 })]);
    expect(stats.book.realizedPnlUsd).toBe(10);
  });
});
