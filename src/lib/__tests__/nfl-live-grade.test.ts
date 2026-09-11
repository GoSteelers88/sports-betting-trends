// nfl-live-grade — grading the private live board against results into the
// live calibration record. Pins: selection parsing never guesses a side, a
// game without a final stays pending, results/pnl match the loop's graders,
// and the upsert is idempotent.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  gradeLiveBoard,
  loadLiveGradedRows,
  parseSelection,
  upsertLiveGradedRows,
  type LiveBoardLeg,
} from "../nfl-live-grade";
import type { GameRow } from "../nfl-loop";

function game(over: Partial<GameRow>): GameRow {
  return {
    gameId: "2026_01_NYJ_TEN",
    season: 2026,
    gameType: "REG",
    week: 1,
    gameday: "2026-09-13",
    gametime: "13:00",
    awayTeam: "NYJ",
    homeTeam: "TEN",
    spreadLine: -1.5, // home favored by 1.5
    totalLine: 41,
    awayMoneyline: 106,
    homeMoneyline: -125,
    overOdds: -110,
    underOdds: -110,
    awayRest: 7,
    homeRest: 7,
    divGame: false,
    roof: "outdoors",
    surface: "grass",
    temp: 84,
    wind: 4,
    awayQb: "QB A",
    homeQb: "QB B",
    awayCoach: "C A",
    homeCoach: "C B",
    referee: "",
    stadium: "Nissan Stadium",
    awayScore: 24,
    homeScore: 20,
    result: -4, // home margin: TEN lost by 4
    total: 44,
    ...over,
  };
}

function leg(over: Partial<LiveBoardLeg>): LiveBoardLeg {
  return {
    gameId: "2026_01_NYJ_TEN",
    matchup: "NYJ @ TEN",
    market: "moneyline",
    selection: "NYJ ML",
    priceAmerican: 106,
    rawConfidence: 0.55,
    verdict: "PLAY",
    divGame: false,
    dome: false,
    ...over,
  };
}

describe("parseSelection", () => {
  const g = game({});
  it("reads the side out of ML / ATS / total selections", () => {
    expect(parseSelection(leg({}), g)).toEqual({ market: "moneyline", side: "away" });
    expect(parseSelection(leg({ market: "ats", selection: "NYJ +1.5" }), g)).toEqual({ market: "ats", side: "away", spreadHome: -1.5 });
    expect(parseSelection(leg({ market: "ats", selection: "TEN -1.5" }), g)).toEqual({ market: "ats", side: "home", spreadHome: -1.5 });
    expect(parseSelection(leg({ market: "total", selection: "OVER 41" }), g)).toEqual({ market: "total", side: "over", line: 41 });
  });
  it("refuses a team token that is not one of the game's two codes", () => {
    expect(parseSelection(leg({ selection: "SEA ML" }), g)).toBeNull();
    expect(parseSelection(leg({ market: "ats", selection: "SEA +3" }), g)).toBeNull();
    expect(parseSelection(leg({ market: "total", selection: "OVERISH 41" }), g)).toBeNull();
  });
});

describe("gradeLiveBoard", () => {
  it("grades every market against the real result with the loop's rules and the board's price", () => {
    const legs = [
      leg({}), // NYJ ML +106 — NYJ won by 4 → win, +1.06u
      leg({ market: "ats", selection: "TEN -1.5", priceAmerican: -110, verdict: "PASS" }), // TEN lost → loss
      leg({ market: "total", selection: "UNDER 41", priceAmerican: -108, verdict: "PASS" }), // 44 > 41 → loss
    ];
    const res = gradeLiveBoard(legs, [game({})], "2026-09-15T10:00:00Z");
    expect(res.pending).toEqual([]);
    expect(res.unparsed).toEqual([]);
    expect(res.rows.map((r) => [r.key, r.result, r.pnlUnits])).toEqual([
      ["2026_01_NYJ_TEN|moneyline", "win", 1.06],
      ["2026_01_NYJ_TEN|ats", "loss", -1],
      ["2026_01_NYJ_TEN|total", "loss", -1],
    ]);
    const ml = res.rows[0];
    expect(ml).toMatchObject({
      season: 2026,
      phase: "REG",
      week: 1,
      matchup: "NYJ @ TEN",
      side: "away",
      confidence: 0.55,
      oddsAmerican: 106,
      favored: "underdog",
      homeAway: "away",
      restAdvantage: 0,
      wind: 4,
      temp: 84,
      gradedAt: "2026-09-15T10:00:00Z",
    });
    // A PASS leg is graded too — calibration is about the read, not the verdict.
    expect(res.rows[1].confidence).toBe(0.55);
  });

  it("a game with no final stays pending; an unknown game is reported", () => {
    const res = gradeLiveBoard(
      [leg({}), leg({ gameId: "2026_01_XX_YY", matchup: "XX @ YY" })],
      [game({ awayScore: null, homeScore: null, result: null, total: null })],
      "2026-09-15T10:00:00Z",
    );
    expect(res.rows).toEqual([]);
    expect(res.pending).toEqual(["2026_01_NYJ_TEN moneyline"]);
    expect(res.unknownGames).toEqual(["2026_01_XX_YY moneyline"]);
  });

  it("a tied game grades the moneyline as a push at zero P&L", () => {
    const res = gradeLiveBoard([leg({})], [game({ result: 0, total: 40 })], "2026-09-15T10:00:00Z");
    expect(res.rows[0].result).toBe("push");
    expect(res.rows[0].pnlUnits).toBe(0);
  });
});

describe("live-graded.jsonl upsert", () => {
  it("re-running a week replaces its rows in place — no double count", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nfl-live-grade-"));
    const { rows } = gradeLiveBoard([leg({}), leg({ market: "ats", selection: "NYJ +1.5", priceAmerican: -110 })], [game({})], "t1");
    expect(upsertLiveGradedRows(dir, rows)).toEqual({ added: 2, replaced: 0 });
    expect(upsertLiveGradedRows(dir, rows)).toEqual({ added: 0, replaced: 2 });
    expect(loadLiveGradedRows(dir)).toHaveLength(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
