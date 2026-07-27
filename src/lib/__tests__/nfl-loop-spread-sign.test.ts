import { describe, it, expect } from "vitest";
import {
  parseGames,
  assertSpreadConvention,
  spreadMarginCorrelation,
  gradeAts,
  type GameRow,
} from "../nfl-loop";

// ─────────────────────────────────────────────────────────────────────────────
// Regression cover for the spread sign inversion (Experiment No. 5).
//
// nflverse `spread_line` is POSITIVE when the HOME team is favored. Every
// consumer in nfl-loop.ts uses the opposite convention (negative = home
// favored). parseGames() passed the raw value straight through, so favorites
// and underdogs were swapped in both the blind input the model reasoned from
// and the number gradeAts() scored against — manufacturing a 75.9% ATS win
// rate and +45% ROI out of nothing.
//
// Why the existing suite missed it: every other NFL test builds `GameRow`
// literals by hand with the CORRECT sign, so the whole suite stayed green while
// the CSV→GameRow seam was inverted. These tests deliberately go through
// parseGames() from real CSV text — the seam itself.
// ─────────────────────────────────────────────────────────────────────────────

const HEADER =
  "game_id,season,game_type,week,gameday,gametime,away_team,home_team," +
  "spread_line,total_line,away_moneyline,home_moneyline,over_odds,under_odds," +
  "away_rest,home_rest,div_game,roof,surface,temp,wind,away_qb_name,home_qb_name," +
  "away_coach,home_coach,referee,stadium,away_score,home_score,result,total";

/** One CSV row. `spreadLine` here is in NFLVERSE convention (positive = home
 *  favored), because that is what the real file contains. */
function csvRow(o: {
  id: string;
  spreadLine: number;
  awayScore: number;
  homeScore: number;
}): string {
  const result = o.homeScore - o.awayScore;
  const total = o.homeScore + o.awayScore;
  return [
    o.id, "2015", "REG", "1", "2015-09-13", "13:00", "AWY", "HME",
    String(o.spreadLine), "45", "150", "-170", "-110", "-110",
    "7", "7", "0", "outdoors", "grass", "70", "5", "A QB", "H QB",
    "A Coach", "H Coach", "Ref", "Stadium",
    String(o.awayScore), String(o.homeScore), String(result), String(total),
  ].join(",");
}

function parse(rows: string[]): GameRow[] {
  return parseGames([HEADER, ...rows].join("\n"));
}

describe("parseGames spread sign conversion", () => {
  it("flips nflverse positive-home-favored into negative-home-favored", () => {
    // nflverse says +14.5 → the HOME team is favored by 14.5.
    const [g] = parse([csvRow({ id: "2015_01_AWY_HME", spreadLine: 14.5, awayScore: 10, homeScore: 31 })]);
    expect(g.spreadLine).toBe(-14.5);
  });

  it("flips a home underdog line the other way", () => {
    // nflverse -3 → the AWAY team is favored by 3 → home is a +3 dog.
    const [g] = parse([csvRow({ id: "2015_01_AWY_HME", spreadLine: -3, awayScore: 24, homeScore: 20 })]);
    expect(g.spreadLine).toBe(3);
  });

  it("keeps pick'em at zero without producing -0", () => {
    const [g] = parse([csvRow({ id: "2015_01_AWY_HME", spreadLine: 0, awayScore: 17, homeScore: 17 })]);
    expect(g.spreadLine).toBe(0);
    expect(Object.is(g.spreadLine, -0)).toBe(false);
  });

  it("grades a big home favorite correctly end-to-end through the parser", () => {
    // The exact shape of the real failure: NE favored by 14.5 at home, wins by
    // 21. Pre-fix this parsed as +14.5, gradeAts treated NE as a 14.5-point DOG
    // and scored a trivially free win. Post-fix NE must genuinely cover -14.5.
    const [g] = parse([csvRow({ id: "2015_15_TEN_NE", spreadLine: 14.5, awayScore: 7, homeScore: 28 })]);
    expect(gradeAts("home", g.spreadLine!, g.result!)).toBe("win"); // won by 21 > 14.5
    expect(gradeAts("away", g.spreadLine!, g.result!)).toBe("loss");
  });

  it("does NOT hand a favorite a free cover when it wins by less than the number", () => {
    // Won by 3 while laying 14.5 — must be a loss. This is the assertion that
    // fails loudest under the inverted sign (it scored as a win before).
    const [g] = parse([csvRow({ id: "2015_15_TEN_NE", spreadLine: 14.5, awayScore: 21, homeScore: 24 })]);
    expect(gradeAts("home", g.spreadLine!, g.result!)).toBe("loss");
    expect(gradeAts("away", g.spreadLine!, g.result!)).toBe("win");
  });
});

describe("assertSpreadConvention", () => {
  // Favorites mostly win by roughly their number → under the correct
  // convention corr(spreadLine, homeMargin) is strongly NEGATIVE.
  const healthy = () =>
    parse([
      csvRow({ id: "2015_01_A_H", spreadLine: 14, awayScore: 10, homeScore: 31 }),
      csvRow({ id: "2015_02_A_H", spreadLine: 10, awayScore: 14, homeScore: 27 }),
      csvRow({ id: "2015_03_A_H", spreadLine: 3, awayScore: 20, homeScore: 24 }),
      csvRow({ id: "2015_04_A_H", spreadLine: -3, awayScore: 27, homeScore: 20 }),
      csvRow({ id: "2015_05_A_H", spreadLine: -10, awayScore: 30, homeScore: 13 }),
      csvRow({ id: "2015_06_A_H", spreadLine: -14, awayScore: 34, homeScore: 10 }),
    ]);

  it("passes on correctly-signed data", () => {
    const games = healthy();
    const corr = spreadMarginCorrelation(games);
    expect(corr).not.toBeNull();
    expect(corr!).toBeLessThan(-0.15);
    expect(() => assertSpreadConvention(games)).not.toThrow();
  });

  it("throws when the sign is inverted — the guard that was missing", () => {
    const inverted = healthy().map((g) => ({ ...g, spreadLine: -g.spreadLine! }));
    expect(() => assertSpreadConvention(inverted)).toThrow(/INVERTED/);
  });

  it("is silent when there is nothing graded yet", () => {
    const ungraded: GameRow[] = healthy().map((g) => ({ ...g, result: null }));
    expect(spreadMarginCorrelation(ungraded)).toBeNull();
    expect(() => assertSpreadConvention(ungraded)).not.toThrow();
  });
});
