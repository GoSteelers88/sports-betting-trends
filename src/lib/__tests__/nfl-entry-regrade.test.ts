// nfl-entry-regrade — grading primitives, stats, and the archive join (recs 1+8).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import {
  binomialPValue,
  correlation,
  favoredAt,
  franchiseOfAbbr,
  gradeAtsAt,
  gradeTotalAt,
  holmSignificant,
  joinArchive,
  loadOddsArchive,
  tally,
  type ArchiveGame,
} from "../nfl-entry-regrade";
import type { GameRow } from "../nfl-loop";

describe("grading primitives (nfl-loop conventions: negative spread = home favored)", () => {
  it("grades ATS covers, losses, and pushes", () => {
    // Home favored by 4.5, wins by 7 → home covers.
    expect(gradeAtsAt("home", -4.5, 7)).toBe("win");
    expect(gradeAtsAt("away", -4.5, 7)).toBe("loss");
    // Wins by exactly the number → push.
    expect(gradeAtsAt("home", -4, 4)).toBe("push");
    // Home dog +3 losing by 1 covers.
    expect(gradeAtsAt("home", 3, -1)).toBe("win");
  });

  it("grades totals", () => {
    expect(gradeTotalAt("over", 47.5, 51)).toBe("win");
    expect(gradeTotalAt("under", 47.5, 51)).toBe("loss");
    expect(gradeTotalAt("over", 48, 48)).toBe("push");
  });

  it("derives favored status from the line being graded", () => {
    expect(favoredAt("home", -3)).toBe("favorite");
    expect(favoredAt("away", -3)).toBe("underdog");
    expect(favoredAt("home", 3)).toBe("underdog");
    expect(favoredAt("home", 0)).toBe("pickem");
  });
});

describe("statistics", () => {
  it("tally computes ROI at -110 and posterior mean", () => {
    const t = tally(["win", "win", "loss", "push"]);
    expect(t.n).toBe(3);
    expect(t.pushes).toBe(1);
    expect(t.roiPct).toBeCloseTo(((2 * (100 / 110) - 1) / 3) * 100, 4);
    expect(t.posteriorMean).toBeCloseTo((2 + 50) / (3 + 100), 6);
  });

  it("binomial p-value: exact one-sided vs breakeven", () => {
    expect(binomialPValue(0, 0)).toBe(1);
    // 60/100 vs 52.38%: modest evidence, p ~0.07-0.08
    const p = binomialPValue(60, 100);
    expect(p).toBeGreaterThan(0.03);
    expect(p).toBeLessThan(0.12);
    // Overwhelming: 90/100
    expect(binomialPValue(90, 100)).toBeLessThan(1e-8);
    // Below breakeven: near 1 tail
    expect(binomialPValue(40, 100)).toBeGreaterThan(0.98);
  });

  it("holm step-down stops at the first failure", () => {
    // m=3: thresholds 0.05/3, 0.05/2, 0.05
    expect(holmSignificant([0.001, 0.02, 0.2])).toEqual([true, true, false]);
    // second-ranked fails → third never tested even though < alpha
    expect(holmSignificant([0.001, 0.04, 0.045])).toEqual([true, false, false]);
    expect(holmSignificant([0.6, 0.7])).toEqual([false, false]);
  });

  it("correlation is 1 for identical series and ~0 for orthogonal", () => {
    expect(correlation([1, 2, 3, 4], [1, 2, 3, 4])).toBeCloseTo(1, 9);
    expect(correlation([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 9);
    expect(correlation([1, 2], [1, 2])).toBe(0); // n<3 guard
  });
});

describe("franchise mapping", () => {
  it("maps era-dependent and relocated abbreviations to one franchise", () => {
    expect(franchiseOfAbbr("OAK")).toBe(franchiseOfAbbr("LV"));
    expect(franchiseOfAbbr("SD")).toBe(franchiseOfAbbr("LAC"));
    expect(franchiseOfAbbr("STL")).toBe(franchiseOfAbbr("LA"));
    expect(franchiseOfAbbr("WSH")).toBe(franchiseOfAbbr("WAS"));
    expect(franchiseOfAbbr("XXX")).toBeNull();
  });
});

const gameRow = (over: Partial<GameRow>): GameRow =>
  ({
    gameId: "2021_01_AAA_BBB",
    season: 2021,
    gameType: "REG",
    week: 1,
    gameday: "2021-09-12",
    gametime: "13:00",
    awayTeam: "GB",
    homeTeam: "CHI",
    awayScore: 20,
    homeScore: 24,
    result: 4,
    total: 44,
    spreadLine: -3,
    totalLine: 45.5,
    awayMoneyline: 130,
    homeMoneyline: -150,
    overOdds: -110,
    underOdds: -110,
    awayRest: 7,
    homeRest: 7,
    divGame: false,
    roof: "outdoors",
    surface: "grass",
    temp: 70,
    wind: 5,
    awayQb: "",
    homeQb: "",
    awayCoach: "",
    homeCoach: "",
    referee: "",
    stadium: "",
    ...over,
  }) as GameRow;

const archGame = (over: Partial<ArchiveGame>): ArchiveGame => ({
  season: 2021,
  date: 20210912,
  homeFranchise: "bears",
  awayFranchise: "packers",
  homeFinal: 24,
  awayFinal: 20,
  homeOpenSpread: -2.5,
  homeCloseSpread: -3,
  openTotal: 45,
  closeTotal: 45.5,
  homeCloseMl: -150,
  awayCloseMl: 130,
  ...over,
});

describe("joinArchive", () => {
  it("joins on home franchise + date and tolerates ±1 day", () => {
    const games = [
      gameRow({ gameId: "2021_01_GB_CHI" }),
      gameRow({ gameId: "2021_01_X_SEA", homeTeam: "SEA", gameday: "2021-09-13" }),
    ];
    const arch = [
      archGame({}),
      archGame({ homeFranchise: "seahawks", date: 20210912 }), // one day early
    ];
    const j = joinArchive(games, arch);
    expect(j.matched).toBe(2);
    expect(j.coverage).toBe(1);
    expect(j.byGameId.get("2021_01_GB_CHI")?.homeOpenSpread).toBe(-2.5);
  });

  it("reports unmatched games and excludes null closes from the close corr", () => {
    const games = [
      gameRow({ gameId: "2021_01_GB_CHI" }),
      gameRow({ gameId: "2021_02_A_DEN", homeTeam: "DEN", gameday: "2021-09-19" }),
    ];
    const arch = [archGame({ homeCloseSpread: null })];
    const j = joinArchive(games, arch);
    expect(j.matched).toBe(1);
    expect(j.unmatchedGameIds).toEqual(["2021_02_A_DEN"]);
    expect(j.closeSpreadCorr).toBe(0); // no valid close pairs → n<3 guard
  });
});

describe("loadOddsArchive plausibility filtering", () => {
  it("nulls corrupt close columns (the SBR favorite/dog swap) and keeps opens", () => {
    const tmp = path.join(os.tmpdir(), `arch-test-${process.pid}.json`);
    fs.writeFileSync(
      tmp,
      JSON.stringify([
        // clean row
        { season: 2021, date: 20210912, home_team: "Bears", away_team: "Packers", home_final: 24, away_final: 20, home_open_spread: -2.5, home_close_spread: -3, open_over_under: 45, close_over_under: 45.5, home_close_ml: -150, away_close_ml: 130 },
        // swapped-close row: close spread holds the total
        { season: 2021, date: 20210919, home_team: "Broncos", away_team: "Jets", home_final: 10, away_final: 20, home_open_spread: 3, home_close_spread: 40.5, open_over_under: 41, close_over_under: 3.5, home_close_ml: 140, away_close_ml: -160 },
        // junk team name row (the archive's "0" rows)
        { season: 2021, date: 20210919, home_team: "0", away_team: "Bears", home_final: 1, away_final: 2, home_open_spread: 1, home_close_spread: 1, open_over_under: 44, close_over_under: 44 },
        // corrupt OPEN → dropped entirely
        { season: 2021, date: 20210926, home_team: "Lions", away_team: "Rams", home_final: 17, away_final: 28, home_open_spread: 47, home_close_spread: -7, open_over_under: 46, close_over_under: 46 },
      ]),
    );
    const rows = loadOddsArchive(tmp);
    fs.unlinkSync(tmp);
    expect(rows).toHaveLength(2);
    expect(rows[0].homeCloseSpread).toBe(-3);
    expect(rows[1].homeCloseSpread).toBeNull(); // 40.5 is a total, not a spread
    expect(rows[1].closeTotal).toBeNull(); // 3.5 is a spread, not a total
    expect(rows[1].homeOpenSpread).toBe(3); // open survives
  });
});
