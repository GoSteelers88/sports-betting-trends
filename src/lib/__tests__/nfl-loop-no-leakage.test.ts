import { describe, it, expect } from "vitest";
import {
  parseGames,
  parseInjuries,
  buildBlindWeek,
  FORBIDDEN_LEAK_TOKENS,
  type Cursor,
} from "../nfl-loop";

// A tiny 2-game fixture with FULL post-game results present. If the blind input
// builder leaks any of those, this test catches it.
const CSV = `game_id,season,game_type,week,gameday,gametime,away_team,away_score,home_team,home_score,result,total,away_rest,home_rest,away_moneyline,home_moneyline,spread_line,total_line,under_odds,over_odds,div_game,roof,surface,temp,wind,away_qb_name,home_qb_name,away_coach,home_coach,referee,stadium
2023_01_DET_KC,2023,REG,1,2023-09-07,20:20,DET,21,KC,20,-1,41,7,7,140,-160,-4,53,-110,-110,0,outdoors,fieldturf,71,5,Jared Goff,Patrick Mahomes,Dan Campbell,Andy Reid,Carl Cheffers,Arrowhead
2023_01_CAR_ATL,2023,REG,1,2023-09-10,13:00,CAR,10,ATL,24,14,34,7,7,160,-180,-3.5,40.5,-110,-110,1,outdoors,grass,82,3,Bryce Young,Desmond Ridder,Frank Reich,Arthur Smith,Brad Allen,Mercedes-Benz
`;

// Injury fixture: the four playing teams (DET/KC/CAR/ATL) each get a report row,
// plus BUF — a team NOT on this slate — and a DET row from a DIFFERENT week. The
// blind input must attach ONLY the same-week rows for the two teams in each game.
// The injury description column deliberately contains a comma (quoted) to prove
// the RFC-4180 parser handles it.
const INJ_CSV = `season,game_type,team,week,gsis_id,position,full_name,first_name,last_name,report_primary_injury,report_secondary_injury,report_status,practice_primary_injury,practice_secondary_injury,practice_status,date_modified
2023,REG,DET,1,00-001,LB,Alex Anzalone,Alex,Anzalone,"Hamstring, left",,Questionable,Hamstring,,Limited,2023-09-06T18:00:00Z
2023,REG,KC,1,00-002,WR,Kadarius Toney,Kadarius,Toney,Knee,,Out,Knee,,DNP,2023-09-06T18:00:00Z
2023,REG,CAR,1,00-003,T,Ikem Ekwonu,Ikem,Ekwonu,Ankle,,Doubtful,Ankle,,DNP,2023-09-08T18:00:00Z
2023,REG,ATL,1,00-004,CB,Jeff Okudah,Jeff,Okudah,Foot,,Questionable,Foot,,Limited,2023-09-08T18:00:00Z
2023,REG,BUF,1,00-005,QB,Josh Allen,Josh,Allen,Shoulder,,Out,Shoulder,,DNP,2023-09-08T18:00:00Z
2023,REG,DET,2,00-006,RB,David Montgomery,David,Montgomery,Thigh,,Questionable,Thigh,,Limited,2023-09-13T18:00:00Z
`;

describe("no-leakage guarantee", () => {
  const games = parseGames(CSV);
  const injuries = parseInjuries(INJ_CSV);
  const cursor: Cursor = { season: 2023, phase: "REG", week: 1 };
  const blind = buildBlindWeek(games, cursor, "some prior lessons text", injuries);

  it("parses both fixture games", () => {
    expect(games).toHaveLength(2);
    // results ARE present in the source rows (so leakage would be visible)
    expect(games[0].homeScore).toBe(20);
    expect(games[0].result).toBe(-1);
    expect(games[0].total).toBe(41);
  });

  it("parses injury reports as report-only rows (no post-game columns exist)", () => {
    expect(injuries).toHaveLength(6);
    const det = injuries.find((r) => r.team === "DET" && r.week === 1);
    expect(det).toBeDefined();
    expect(det!.player).toBe("Alex Anzalone");
    expect(det!.position).toBe("LB");
    expect(det!.status).toBe("Questionable");
    // quoted comma in the injury description survived the RFC-4180 parse
    expect(det!.injury).toBe("Hamstring, left");
    // an InjuryRow exposes only routing keys + report fields — never a score
    expect(Object.keys(det!).sort()).toEqual(
      ["gameType", "injury", "player", "position", "season", "status", "team", "week"].sort(),
    );
  });

  it("serialized blind input contains NO post-game tokens", () => {
    const serialized = JSON.stringify(blind);
    for (const token of FORBIDDEN_LEAK_TOKENS) {
      expect(serialized).not.toContain(token);
    }
  });

  it("blind input contains no actual scores or final margins as values", () => {
    // The forbidden numeric values from the fixture: scores 21/20/10/24,
    // result -1/14, total 41/34. None should appear as standalone blind values.
    // (We can't blanket-ban every integer — spreads/totals legitimately appear —
    //  so we assert the structural absence of the post-game KEYS, plus that the
    //  per-game object shape has exactly the allowed top-level keys.)
    for (const g of blind.games) {
      const keys = Object.keys(g).sort();
      expect(keys).toEqual(
        [
          "away",
          "awayRecord",
          "context",
          "gameId",
          "gameType",
          "home",
          "homeRecord",
          "injuries",
          "kickoff",
          "market",
          "season",
          "week",
        ].sort(),
      );
      const marketKeys = Object.keys(g.market).sort();
      expect(marketKeys).toEqual(
        [
          "awayMoneyline",
          "homeMoneyline",
          "overOdds",
          "spreadLineHome",
          "totalLine",
          "underOdds",
        ].sort(),
      );
      // no "score" / "result" / "total" (actual) anywhere in the per-game JSON
      const gj = JSON.stringify(g).toLowerCase();
      expect(gj).not.toContain("score");
      expect(gj).not.toContain('"result"');
    }
  });

  it("attaches injuries scoped to ONLY each game's two teams (this week)", () => {
    const detKc = blind.games.find((g) => g.gameId === "2023_01_DET_KC")!;
    const carAtl = blind.games.find((g) => g.gameId === "2023_01_CAR_ATL")!;

    // DET @ KC: exactly one DET report + one KC report, nothing else.
    expect(detKc.injuries.away.map((i) => i.player)).toEqual(["Alex Anzalone"]); // DET
    expect(detKc.injuries.home.map((i) => i.player)).toEqual(["Kadarius Toney"]); // KC

    // CAR @ ATL: exactly one CAR report + one ATL report.
    expect(carAtl.injuries.away.map((i) => i.player)).toEqual(["Ikem Ekwonu"]); // CAR
    expect(carAtl.injuries.home.map((i) => i.player)).toEqual(["Jeff Okudah"]); // ATL

    // BUF is NOT on this slate — its injury must not appear anywhere.
    const everyName = blind.games
      .flatMap((g) => [...g.injuries.away, ...g.injuries.home])
      .map((i) => i.player);
    expect(everyName).not.toContain("Josh Allen");

    // The DET week-2 row must NOT bleed into this week-1 game.
    expect(everyName).not.toContain("David Montgomery");
  });

  it("each attached injury exposes ONLY report fields (player/position/status/injury)", () => {
    const ALLOWED = ["injury", "player", "position", "status"].sort();
    for (const g of blind.games) {
      for (const inj of [...g.injuries.away, ...g.injuries.home]) {
        expect(Object.keys(inj).sort()).toEqual(ALLOWED);
        // Zero post-game fields, by construction — assert the tokens too.
        const ij = JSON.stringify(inj).toLowerCase();
        for (const token of FORBIDDEN_LEAK_TOKENS) {
          expect(ij).not.toContain(token.toLowerCase());
        }
        expect(ij).not.toContain("score");
      }
    }
  });

  it("standings-to-date in week 1 are empty (no prior games leak forward)", () => {
    // Week 1: no completed prior games, so every record is 0-0.
    for (const g of blind.games) {
      expect(g.awayRecord).toBe("0-0");
      expect(g.homeRecord).toBe("0-0");
    }
  });

  it("lessons memo is the only injected free-text context, passed through verbatim", () => {
    expect(blind.lessons).toBe("some prior lessons text");
  });
});
