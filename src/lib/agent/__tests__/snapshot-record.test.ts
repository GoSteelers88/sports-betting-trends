import { describe, it, expect } from "vitest";
import { buildSnapshotRecord, type SnapshotRow } from "../snapshot-record";

const row = (o: Partial<SnapshotRow>): SnapshotRow => ({
  source: "market", league: "MLB", market: "moneyline", result: "win", ...o,
});

describe("buildSnapshotRecord", () => {
  it("excludes pushes from the win rate denominator", () => {
    const r = buildSnapshotRecord(
      [row({ result: "win" }), row({ result: "loss" }), row({ result: "push" })],
      "test"
    );
    expect(r.totals.n).toBe(3);
    expect(r.totals.pushes).toBe(1);
    // 1W-1L with a push = 50%, NOT 33.3%
    expect(r.totals.winRatePct).toBe(50);
  });

  it("drops ungraded rows entirely", () => {
    const r = buildSnapshotRecord(
      [row({ result: "win" }), row({ result: null }), row({ result: "pending" })],
      "test"
    );
    expect(r.totals.n).toBe(1);
  });

  // NEGATIVE CONTROL: a calibration table that cannot report a miscalibrated
  // model is worthless. Feed it a model that is provably optimistic and require
  // the gap to come back negative with the right magnitude.
  it("detects an optimistic model (negative control)", () => {
    // 10 picks all claiming 80% confidence; only 3 actually win => -50pp gap.
    const rows = [
      ...Array.from({ length: 3 }, () => row({ confidence: 80, result: "win" })),
      ...Array.from({ length: 7 }, () => row({ confidence: 80, result: "loss" })),
    ];
    const r = buildSnapshotRecord(rows, "test");
    const b = r.confidenceCalibration.find(x => x.bucket === "80-89");
    expect(b).toBeDefined();
    expect(b!.n).toBe(10);
    expect(b!.meanPredictedPct).toBe(80);
    expect(b!.realizedWinRatePct).toBe(30);
    expect(b!.gapPp).toBe(-50); // optimistic by 50 points — the table must say so
  });

  it("reports a well-calibrated model as ~zero gap (positive control)", () => {
    const rows = [
      ...Array.from({ length: 8 }, () => row({ confidence: 80, result: "win" })),
      ...Array.from({ length: 2 }, () => row({ confidence: 80, result: "loss" })),
    ];
    const r = buildSnapshotRecord(rows, "test");
    expect(r.confidenceCalibration.find(x => x.bucket === "80-89")!.gapPp).toBe(0);
  });

  it("buckets edge as a fraction around the 6% grader floor", () => {
    const r = buildSnapshotRecord(
      [row({ edge: 0.0712, result: "win" }), row({ edge: 0.03, result: "loss" })],
      "test"
    );
    expect(r.edgeCalibration.map(b => b.bucket)).toEqual(["2-4%", "6-8%"]);
  });

  it("signs prop margin in the direction of the pick", () => {
    // UNDER 5.5 that landed on 3 is a 2.5 margin IN FAVOUR of the pick.
    const r = buildSnapshotRecord(
      [row({ source: "prop_mlb", propType: "strikeouts", selection: "Player Under 5.5", line: 5.5, actualValue: 3, result: "win" })],
      "test"
    );
    const p = r.propsVsActual[0];
    expect(p.underPicks).toBe(1);
    expect(p.meanMarginVsLine).toBe(2.5);
  });

  it("signs an OVER pick that missed as negative", () => {
    const r = buildSnapshotRecord(
      [row({ source: "prop_mlb", propType: "bases", selection: "Player Over 1.5", line: 1.5, actualValue: 0, result: "loss" })],
      "test"
    );
    expect(r.propsVsActual[0].meanMarginVsLine).toBe(-1.5);
  });
});

describe("fieldQuality — guards against calibrating on a constant", () => {
  it("flags a field that is null everywhere", () => {
    const r = buildSnapshotRecord(
      [row({ edge: null, result: "win" }), row({ edge: null, result: "loss" })],
      "test"
    );
    const q = r.fieldQuality.find(f => f.field === "edge")!;
    expect(q.usableForCalibration).toBe(false);
    expect(q.note).toMatch(/never set/);
  });

  // The real-world case: the prop logger stamps confidence 95 on ~every row,
  // producing a huge but meaningless "gap". The record must say so.
  it("flags an effectively-constant field rather than reporting a fake gap", () => {
    const rows = [
      ...Array.from({ length: 99 }, (_, i) => row({ confidence: 95, result: i < 35 ? "win" : "loss" })),
      row({ confidence: 60, result: "win" }),
    ];
    const r = buildSnapshotRecord(rows, "test");
    const q = r.fieldQuality.find(f => f.field === "confidence")!;
    expect(q.usableForCalibration).toBe(false);
    expect(q.note).toMatch(/CONSTANT/);
    expect(q.note).toMatch(/artifact/);
  });

  it("accepts a genuinely varied field", () => {
    const rows = [
      ...Array.from({ length: 20 }, () => row({ confidence: 55, result: "win" })),
      ...Array.from({ length: 20 }, () => row({ confidence: 65, result: "loss" })),
      ...Array.from({ length: 20 }, () => row({ confidence: 85, result: "win" })),
    ];
    const q = buildSnapshotRecord(rows, "test").fieldQuality.find(f => f.field === "confidence")!;
    expect(q.usableForCalibration).toBe(true);
  });
});
