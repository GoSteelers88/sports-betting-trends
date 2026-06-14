import { describe, it, expect } from "vitest";
import {
  gradeAts,
  gradeMoneyline,
  gradeTotal,
  gradeGame,
  americanToProfitUnits,
  type GamePick,
  type GameRow,
} from "../nfl-loop";

describe("ATS grading", () => {
  // home favored by 4 (spreadHome = -4). result = home margin.
  it("home favorite covers when margin beats the number", () => {
    expect(gradeAts("home", -4, 7)).toBe("win"); // home won by 7, covers -4
    expect(gradeAts("away", -4, 7)).toBe("loss");
  });
  it("home favorite fails to cover", () => {
    expect(gradeAts("home", -4, 3)).toBe("loss"); // won by 3, didn't cover -4
    expect(gradeAts("away", -4, 3)).toBe("win"); // away +4 covers
  });
  it("exact push when margin lands on the number", () => {
    expect(gradeAts("home", -4, 4)).toBe("push");
    expect(gradeAts("away", -4, 4)).toBe("push");
    expect(gradeAts("home", 3, -3)).toBe("push"); // home dog +3, lost by 3
  });
  it("underdog cover", () => {
    expect(gradeAts("away", -7, 3)).toBe("win"); // away +7, lost by 3 → covers
    expect(gradeAts("home", -7, 3)).toBe("loss");
  });
  it("home margin negative (home lost)", () => {
    expect(gradeAts("away", 3, -10)).toBe("win"); // away favored -3, won by 10
    expect(gradeAts("home", 3, -10)).toBe("loss");
  });
});

describe("moneyline grading", () => {
  it("home win", () => {
    expect(gradeMoneyline("home", 6)).toBe("win");
    expect(gradeMoneyline("away", 6)).toBe("loss");
  });
  it("away win (negative home margin)", () => {
    expect(gradeMoneyline("away", -3)).toBe("win");
    expect(gradeMoneyline("home", -3)).toBe("loss");
  });
  it("tie is a push for both sides", () => {
    expect(gradeMoneyline("home", 0)).toBe("push");
    expect(gradeMoneyline("away", 0)).toBe("push");
  });
});

describe("total grading", () => {
  it("over hits", () => {
    expect(gradeTotal("over", 44.5, 51)).toBe("win");
    expect(gradeTotal("under", 44.5, 51)).toBe("loss");
  });
  it("under hits", () => {
    expect(gradeTotal("under", 44.5, 40)).toBe("win");
    expect(gradeTotal("over", 44.5, 40)).toBe("loss");
  });
  it("exact total is a push", () => {
    expect(gradeTotal("over", 44, 44)).toBe("push");
    expect(gradeTotal("under", 44, 44)).toBe("push");
  });
});

describe("americanToProfitUnits", () => {
  it("-110 returns ~0.909", () => {
    expect(americanToProfitUnits(-110)).toBeCloseTo(0.9091, 3);
  });
  it("+150 returns 1.5", () => {
    expect(americanToProfitUnits(150)).toBe(1.5);
  });
});

// ── gradeGame: full per-game pick set → up to 3 graded rows with correct P&L ──

function makeGame(overrides: Partial<GameRow> = {}): GameRow {
  return {
    gameId: "2023_01_DET_KC",
    season: 2023,
    gameType: "REG",
    week: 1,
    gameday: "2023-09-07",
    gametime: "20:20",
    awayTeam: "DET",
    homeTeam: "KC",
    spreadLine: -4, // KC favored by 4
    totalLine: 53,
    awayMoneyline: 140,
    homeMoneyline: -160,
    overOdds: -110,
    underOdds: -110,
    awayRest: 7,
    homeRest: 10,
    divGame: false,
    roof: "outdoors",
    surface: "fieldturf",
    temp: 71,
    wind: 5,
    awayQb: "Jared Goff",
    homeQb: "Patrick Mahomes",
    awayCoach: "Dan Campbell",
    homeCoach: "Andy Reid",
    referee: "Carl Cheffers",
    stadium: "Arrowhead",
    awayScore: 21,
    homeScore: 20, // DET won by 1 → home margin -1
    result: -1,
    total: 41,
    ...overrides,
  };
}

const pick: GamePick = {
  gameId: "2023_01_DET_KC",
  atsSide: "away", // DET +4
  atsSpreadHome: -4,
  moneylineSide: "away", // DET to win
  totalSide: "under", // total 53, actual 41 → under
  totalLine: 53,
  confidence: 0.72,
  rationale: "fixture",
  keyFactors: ["fixture factor"],
};

describe("gradeGame", () => {
  const rows = gradeGame(makeGame(), pick);

  it("produces one row per market", () => {
    expect(rows.map((r) => r.market).sort()).toEqual(["ats", "moneyline", "total"]);
  });

  it("ATS: DET +4 wins (lost by 1, covers), -110 odds, +0.909u", () => {
    const ats = rows.find((r) => r.market === "ats")!;
    expect(ats.result).toBe("win");
    expect(ats.oddsAmerican).toBe(-110);
    expect(ats.pnlUnits).toBeCloseTo(0.9091, 3);
    expect(ats.favored).toBe("underdog"); // DET is the dog
    expect(ats.homeAway).toBe("away");
  });

  it("ML: DET wins outright at +140 → +1.4u", () => {
    const ml = rows.find((r) => r.market === "moneyline")!;
    expect(ml.result).toBe("win");
    expect(ml.oddsAmerican).toBe(140);
    expect(ml.pnlUnits).toBeCloseTo(1.4, 3);
    expect(ml.favored).toBe("underdog");
  });

  it("total: under 53 wins (actual 41), -110 → +0.909u", () => {
    const tot = rows.find((r) => r.market === "total")!;
    expect(tot.result).toBe("win");
    expect(tot.pnlUnits).toBeCloseTo(0.9091, 3);
  });

  it("loss returns -1u flat regardless of odds", () => {
    const losingPick: GamePick = { ...pick, moneylineSide: "home" }; // KC lost
    const r = gradeGame(makeGame(), losingPick);
    const ml = r.find((x) => x.market === "moneyline")!;
    expect(ml.result).toBe("loss");
    expect(ml.pnlUnits).toBe(-1);
  });

  it("ATS push yields 0u and is keyed correctly", () => {
    // KC -3, DET loses by exactly 3 → push
    const g = makeGame({ spreadLine: -3, homeScore: 24, awayScore: 21, result: 3, total: 45 });
    const p: GamePick = { ...pick, atsSide: "home", atsSpreadHome: -3 };
    const r = gradeGame(g, p);
    const ats = r.find((x) => x.market === "ats")!;
    expect(ats.result).toBe("push");
    expect(ats.pnlUnits).toBe(0);
    expect(ats.key).toBe("2023_01_DET_KC|ats");
  });

  it("skips a market when its result field is missing (unplayed game)", () => {
    const g = makeGame({ result: null, total: null, homeScore: null, awayScore: null });
    const r = gradeGame(g, pick);
    expect(r).toHaveLength(0);
  });
});
