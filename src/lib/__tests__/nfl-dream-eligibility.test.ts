// computeDoctrineEligibility — the deterministic doctrine gate, at real prices
// (research rec 3 + the 2026-08-15 review's kill test: an ML-favorite-heavy
// bucket with a high win rate but negative ROI must NOT be eligible).

import { describe, expect, it } from "vitest";

import { computeDoctrineEligibility } from "../nfl-dream";
import type { GradedRow } from "../nfl-loop";

let seq = 0;
const row = (over: Partial<GradedRow>): GradedRow =>
  ({
    key: `g${seq}|${over.market ?? "ats"}`,
    season: 2021,
    phase: "REG",
    week: 1,
    gameId: `2021_01_A_B${seq++}`,
    matchup: "A @ B",
    market: "ats",
    selection: "B -3",
    side: "home",
    confidence: 0.55,
    result: "win",
    oddsAmerican: -110,
    pnlUnits: 0.9091,
    favored: "favorite",
    homeAway: "home",
    divGame: false,
    dome: false,
    restAdvantage: 0,
    wind: null,
    temp: null,
    gradedAt: "2026-01-01T00:00:00Z",
    ...over,
  }) as GradedRow;

describe("computeDoctrineEligibility", () => {
  it("rejects a high-win-rate ML favorite bucket that loses at its prices", () => {
    // 60 wins, 40 losses at -300 (needs 75%): win rate 60%, ROI negative.
    const rows: GradedRow[] = [];
    for (let i = 0; i < 60; i++)
      rows.push(row({ market: "moneyline", result: "win", oddsAmerican: -300 }));
    for (let i = 0; i < 40; i++)
      rows.push(row({ market: "moneyline", result: "loss", oddsAmerican: -300 }));
    const home = computeDoctrineEligibility(rows).find(
      (b) => b.bucket === "homeVsAway: home",
    );
    expect(home).toBeDefined();
    expect(home!.n).toBe(100);
    expect(home!.rawRate).toBeCloseTo(0.6, 6);
    expect(home!.breakeven).toBeCloseTo(0.75, 6);
    expect(home!.eligible).toBe(false);
  });

  it("accepts a plus-money dog bucket that wins less than half but profits", () => {
    // 90 wins, 110 losses at +150 (needs 40%): 45% raw, posterior 46.7%.
    const rows: GradedRow[] = [];
    for (let i = 0; i < 90; i++)
      rows.push(
        row({ market: "moneyline", result: "win", oddsAmerican: 150, homeAway: "away" }),
      );
    for (let i = 0; i < 110; i++)
      rows.push(
        row({ market: "moneyline", result: "loss", oddsAmerican: 150, homeAway: "away" }),
      );
    const away = computeDoctrineEligibility(rows).find(
      (b) => b.bucket === "homeVsAway: away",
    );
    expect(away!.breakeven).toBeCloseTo(0.4, 6);
    expect(away!.eligible).toBe(true);
  });

  it("mirrors computeStatRecord's membership rules", () => {
    const rows = [
      row({ market: "total", side: "over", wind: 3, temp: 75 }),
      row({ market: "ats", favored: "underdog", divGame: true, dome: true }),
    ];
    const buckets = computeDoctrineEligibility(rows).map((b) => b.bucket);
    // totals join wind/temp/div/dome but never home-away, rest, or fav-dog
    expect(buckets).toContain("byWind: calm (0-5)");
    expect(buckets).toContain("byTemp: warm (70+)");
    expect(buckets).toContain("favoriteVsDog: underdog");
    expect(buckets).toContain("divisional: divisional");
    expect(buckets).toContain("domeVsOutdoor: dome");
    const homeAwayCount = computeDoctrineEligibility(rows).find(
      (b) => b.bucket === "homeVsAway: home",
    );
    expect(homeAwayCount!.n).toBe(1); // only the ATS row, not the total
  });
});
