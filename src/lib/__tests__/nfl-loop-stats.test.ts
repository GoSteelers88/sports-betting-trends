import { describe, it, expect } from "vitest";
import { computeStatRecord, type GradedRow } from "../nfl-loop";

function row(over: Partial<GradedRow>): GradedRow {
  return {
    key: over.key ?? `${over.gameId ?? "G"}|${over.market ?? "ats"}`,
    season: 2023,
    phase: "REG",
    week: 1,
    gameId: over.gameId ?? "G",
    matchup: "A @ B",
    market: over.market ?? "ats",
    selection: "sel",
    side: over.side ?? "home",
    confidence: over.confidence ?? 0.6,
    result: over.result ?? "win",
    oddsAmerican: over.oddsAmerican ?? -110,
    pnlUnits: over.pnlUnits ?? 0.9091,
    favored: over.favored ?? "favorite",
    homeAway: over.homeAway ?? "home",
    divGame: over.divGame ?? false,
    dome: over.dome ?? false,
    restAdvantage: over.restAdvantage ?? 0,
    wind: over.wind ?? 5,
    temp: over.temp ?? 60,
    gradedAt: "2023-09-08T00:00:00Z",
    ...over,
  };
}

describe("computeStatRecord", () => {
  // 4 ATS rows: 2 win, 1 loss, 1 push
  const rows: GradedRow[] = [
    row({ key: "1|ats", gameId: "1", market: "ats", result: "win", pnlUnits: 0.9091, favored: "favorite", homeAway: "home", confidence: 0.7 }),
    row({ key: "2|ats", gameId: "2", market: "ats", result: "win", pnlUnits: 0.9091, favored: "underdog", homeAway: "away", confidence: 0.7 }),
    row({ key: "3|ats", gameId: "3", market: "ats", result: "loss", pnlUnits: -1, favored: "favorite", homeAway: "home", confidence: 0.65 }),
    row({ key: "4|ats", gameId: "4", market: "ats", result: "push", pnlUnits: 0, favored: "underdog", homeAway: "away", confidence: 0.55 }),
    // moneyline rows
    row({ key: "1|ml", gameId: "1", market: "moneyline", result: "win", pnlUnits: 1.4, side: "away", homeAway: "away", confidence: 0.8 }),
    row({ key: "3|ml", gameId: "3", market: "moneyline", result: "loss", pnlUnits: -1, side: "home", homeAway: "home", confidence: 0.6 }),
    // totals
    row({ key: "1|tot", gameId: "1", market: "total", side: "over", result: "win", pnlUnits: 0.9091, confidence: 0.6 }),
    row({ key: "2|tot", gameId: "2", market: "total", side: "under", result: "win", pnlUnits: 0.9091, confidence: 0.6 }),
    row({ key: "3|tot", gameId: "3", market: "total", side: "over", result: "loss", pnlUnits: -1, confidence: 0.6 }),
  ];

  const rec = computeStatRecord(rows);

  it("counts total rows", () => {
    expect(rec.totalRows).toBe(9);
  });

  it("overall ATS: 2-1-1, win rate 2/3, ROI from pnl/decisive", () => {
    const ats = rec.overall.ats;
    expect(ats.wins).toBe(2);
    expect(ats.losses).toBe(1);
    expect(ats.pushes).toBe(1);
    expect(ats.n).toBe(3); // decisive only
    expect(ats.winRate).toBeCloseTo(0.6667, 3);
    // pnl = 0.9091 + 0.9091 - 1 = 0.8182 over 3 staked → 27.27%
    expect(ats.pnlUnits).toBeCloseTo(0.8182, 3);
    expect(ats.roiPct).toBeCloseTo(27.27, 1);
  });

  it("overall moneyline: 1-1, pnl 0.4", () => {
    const ml = rec.overall.moneyline;
    expect(ml.wins).toBe(1);
    expect(ml.losses).toBe(1);
    expect(ml.pnlUnits).toBeCloseTo(0.4, 3);
    expect(ml.winRate).toBeCloseTo(0.5, 3);
  });

  it("overall total: 2-1", () => {
    expect(rec.overall.total.wins).toBe(2);
    expect(rec.overall.total.losses).toBe(1);
  });

  it("favorite-cover rate: among ATS favorites (1 win, 1 loss) = 0.5", () => {
    expect(rec.baseRates.favoriteCoverRate).toBeCloseTo(0.5, 3);
  });

  it("over rate: total rows decisive = 3; over went over=1, under-loss=0 → 1/3", () => {
    // over-win (game1) ⇒ over; under-win (game2) ⇒ under; over-loss (game3) ⇒ under
    expect(rec.baseRates.overRate).toBeCloseTo(0.3333, 3);
  });

  it("favorite vs dog split present and labelled", () => {
    const labels = rec.splits.favoriteVsDog.map((s) => s.label);
    expect(labels).toContain("favorite");
    expect(labels).toContain("underdog");
    const fav = rec.splits.favoriteVsDog.find((s) => s.label === "favorite")!;
    expect(fav.n).toBe(2); // 1 win + 1 loss
  });

  it("calibration buckets predicted vs realized", () => {
    // 0.6-0.7 bucket has several rows; 0.7-0.8 and 0.8-0.9 too.
    const labels = rec.calibration.map((c) => c.label);
    expect(labels).toContain("0.6-0.7");
    for (const c of rec.calibration) {
      expect(c.predicted).toBeGreaterThanOrEqual(0);
      expect(c.predicted).toBeLessThanOrEqual(1);
      if (c.realized != null) {
        expect(c.realized).toBeGreaterThanOrEqual(0);
        expect(c.realized).toBeLessThanOrEqual(1);
      }
    }
  });

  it("empty input yields zeroed record without throwing", () => {
    const empty = computeStatRecord([]);
    expect(empty.totalRows).toBe(0);
    expect(empty.overall.ats.winRate).toBeNull();
    expect(empty.baseRates.favoriteCoverRate).toBeNull();
    expect(empty.calibration).toEqual([]);
  });
});
