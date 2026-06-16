import { describe, it, expect } from "vitest";
import { EloLedger, gradeNflMoneyline, buildNflWeekOpps } from "../quant-desk/adapters/nfl";
import type { GameRow, Cursor } from "../nfl-loop";

function gameRow(over: Partial<GameRow>): GameRow {
  return {
    gameId: "2023_01_AAA_BBB",
    season: 2023,
    gameType: "REG",
    week: 1,
    gameday: "2023-09-10",
    gametime: "13:00",
    awayTeam: "AAA",
    homeTeam: "BBB",
    spreadLine: -3,
    totalLine: 44,
    awayMoneyline: 140,
    homeMoneyline: -160,
    overOdds: -110,
    underOdds: -110,
    awayRest: 7,
    homeRest: 7,
    divGame: false,
    roof: "outdoors",
    surface: "grass",
    temp: 70,
    wind: 5,
    awayQb: "QB1",
    homeQb: "QB2",
    awayCoach: "C1",
    homeCoach: "C2",
    referee: "R",
    stadium: "S",
    awayScore: null,
    homeScore: null,
    result: null,
    total: null,
    ...over,
  };
}

describe("EloLedger", () => {
  it("starts every team at 50/50 (plus home-field) and shifts toward the winner", () => {
    const elo = new EloLedger();
    const before = elo.homeWinProb("BBB", "AAA", 2023);
    expect(before).toBeGreaterThan(0.5); // home-field bump
    expect(before).toBeLessThan(0.6);
    // Home team blows out the away team a few times → its rating climbs.
    for (let i = 0; i < 5; i++) {
      elo.update(gameRow({ awayScore: 0, homeScore: 30 }));
    }
    const after = elo.homeWinProb("BBB", "AAA", 2023);
    expect(after).toBeGreaterThan(before);
  });

  it("reverts toward the mean across a season boundary", () => {
    const elo = new EloLedger();
    for (let i = 0; i < 8; i++) elo.update(gameRow({ awayScore: 0, homeScore: 35 }));
    const peak = elo.homeWinProb("BBB", "AAA", 2023);
    const nextSeason = elo.homeWinProb("BBB", "AAA", 2024);
    // After reversion the home edge shrinks toward the base.
    expect(nextSeason).toBeLessThan(peak);
  });
});

describe("gradeNflMoneyline", () => {
  it("grades a home favorite that won as won, the away pick as lost", () => {
    const g = gameRow({ awayScore: 17, homeScore: 24 });
    expect(gradeNflMoneyline("BBB ML", g)).toBe("won");
    expect(gradeNflMoneyline("AAA ML", g)).toBe("lost");
  });
  it("ties are void; unplayed games are null", () => {
    expect(gradeNflMoneyline("BBB ML", gameRow({ awayScore: 20, homeScore: 20 }))).toBe("void");
    expect(gradeNflMoneyline("BBB ML", gameRow({}))).toBeNull();
  });
});

describe("buildNflWeekOpps — leak-safe dry-run", () => {
  it("emits two moneyline opportunities per game with estimate-flagged fairs", () => {
    const games = [gameRow({})];
    const cursor: Cursor = { season: 2023, phase: "REG", week: 1 };
    const elo = new EloLedger();
    const opps = buildNflWeekOpps(games, cursor, elo);
    expect(opps).toHaveLength(2);
    for (const o of opps) {
      expect(o.sport).toBe("NFL");
      expect(o.fair.estimate).toBe(true); // dry-run fair value is always an estimate
      expect(o.fair.basis).toMatch(/DRY-RUN/);
      expect(o.line.book).toBe("nflverse-close");
    }
  });

  it("skips a game with no moneyline", () => {
    const games = [gameRow({ awayMoneyline: null, homeMoneyline: null })];
    const cursor: Cursor = { season: 2023, phase: "REG", week: 1 };
    expect(buildNflWeekOpps(games, cursor, new EloLedger())).toHaveLength(0);
  });
});
