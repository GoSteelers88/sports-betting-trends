import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseGames,
  nextCursor,
  fullSchedule,
  gamesForCursor,
  gradeGame,
  upsertGradedRows,
  loadGradedRows,
  saveCursor,
  loadCursor,
  computeStatRecord,
  LOOP_SEASONS,
  type Cursor,
  type GameRow,
  type GamePick,
} from "../nfl-loop";

// Two seasons, a couple weeks each, with a POST week, to exercise ordering.
const CSV = `game_id,season,game_type,week,gameday,gametime,away_team,away_score,home_team,home_score,result,total,away_rest,home_rest,away_moneyline,home_moneyline,spread_line,total_line,under_odds,over_odds,div_game,roof,surface,temp,wind,away_qb_name,home_qb_name,away_coach,home_coach,referee,stadium
2023_01_A_B,2023,REG,1,2023-09-07,20:20,A,21,B,20,-1,41,7,7,140,-160,-4,53,-110,-110,0,outdoors,grass,71,5,QbA,QbB,CoA,CoB,Ref1,Stad1
2023_01_C_D,2023,REG,1,2023-09-10,13:00,C,10,D,24,14,34,7,7,160,-180,-3.5,40.5,-110,-110,1,dome,fieldturf,72,0,QbC,QbD,CoC,CoD,Ref2,Stad2
2023_02_A_C,2023,REG,2,2023-09-14,13:00,A,28,C,17,-11,45,7,7,-200,170,3,44,-110,-110,0,outdoors,grass,65,10,QbA,QbC,CoA,CoC,Ref1,Stad1
2023_19_A_B,2023,WC,19,2024-01-13,16:30,A,31,B,17,-14,48,7,7,-130,110,-2,46,-110,-110,0,outdoors,grass,30,12,QbA,QbB,CoA,CoB,Ref1,Stad1
2023_22_A_D,2023,SB,22,2024-02-11,18:30,A,25,D,22,-3,47,14,14,-120,100,1.5,49,-110,-110,0,dome,grass,70,0,QbA,QbD,CoA,CoD,Ref3,Stad3
2024_01_B_D,2024,REG,1,2024-09-05,20:20,B,30,D,27,-3,57,7,7,-150,130,-2.5,48,-110,-110,0,outdoors,grass,75,8,QbB,QbD,CoB,CoD,Ref1,Stad1
`;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nfl-loop-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const games: GameRow[] = parseGames(CSV);

describe("schedule ordering", () => {
  it("orders REG weeks ascending then POST, across seasons", () => {
    const sched = fullSchedule(games);
    expect(sched).toEqual([
      { season: 2023, phase: "REG", week: 1 },
      { season: 2023, phase: "REG", week: 2 },
      { season: 2023, phase: "POST", week: 19 }, // WC folds to POST
      { season: 2023, phase: "POST", week: 22 }, // SB folds to POST
      { season: 2024, phase: "REG", week: 1 },
    ]);
  });
});

describe("cursor advancement", () => {
  it("advances exactly one week at a time", () => {
    let c: Cursor | null = { season: 2023, phase: "REG", week: 1 };
    c = nextCursor(games, c!);
    expect(c).toEqual({ season: 2023, phase: "REG", week: 2 });
    c = nextCursor(games, c!);
    expect(c).toEqual({ season: 2023, phase: "POST", week: 19 });
    c = nextCursor(games, c!);
    expect(c).toEqual({ season: 2023, phase: "POST", week: 22 });
    c = nextCursor(games, c!);
    expect(c).toEqual({ season: 2024, phase: "REG", week: 1 });
  });

  it("returns null past the end (caught up)", () => {
    expect(nextCursor(games, { season: 2024, phase: "REG", week: 1 })).toBeNull();
  });

  it("persists + reloads the cursor", () => {
    const c: Cursor = { season: 2023, phase: "POST", week: 22 };
    saveCursor(dir, c);
    expect(loadCursor(dir)).toEqual(c);
  });

  it("defaults to the first LOOP_SEASON REG wk1 with no file", () => {
    expect(loadCursor(dir)).toEqual({ season: LOOP_SEASONS[0], phase: "REG", week: 1 });
  });
});

// ── idempotency: re-running the same week must NOT double-count ──────────────

function pickFor(g: GameRow): GamePick {
  return {
    gameId: g.gameId,
    atsSide: "home",
    atsSpreadHome: g.spreadLine ?? 0,
    moneylineSide: "home",
    totalSide: "over",
    totalLine: g.totalLine ?? 0,
    confidence: 0.6,
    rationale: "fixture",
    keyFactors: ["fixture factor"],
  };
}

function processWeek(c: Cursor): { added: number; replaced: number } {
  const slate = gamesForCursor(games, c);
  const rows = slate.flatMap((g) => gradeGame(g, pickFor(g)));
  return upsertGradedRows(dir, rows);
}

describe("idempotent week processing", () => {
  const c: Cursor = { season: 2023, phase: "REG", week: 1 };

  it("first run adds all rows; rerun replaces, never adds", () => {
    const first = processWeek(c);
    // 2 games × 3 markets = 6 rows
    expect(first.added).toBe(6);
    expect(first.replaced).toBe(0);
    expect(loadGradedRows(dir)).toHaveLength(6);

    const second = processWeek(c);
    expect(second.added).toBe(0);
    expect(second.replaced).toBe(6);
    // total row count UNCHANGED — no double-count
    expect(loadGradedRows(dir)).toHaveLength(6);
  });

  it("processing the next week adds new rows without touching old ones", () => {
    processWeek({ season: 2023, phase: "REG", week: 1 }); // 6 rows
    const wk2 = processWeek({ season: 2023, phase: "REG", week: 2 }); // 1 game × 3
    expect(wk2.added).toBe(3);
    expect(wk2.replaced).toBe(0);
    expect(loadGradedRows(dir)).toHaveLength(9);
  });

  it("stat record is stable across reruns (derived, not accumulated)", () => {
    processWeek(c);
    const a = computeStatRecord(loadGradedRows(dir));
    processWeek(c); // rerun
    processWeek(c); // rerun again
    const b = computeStatRecord(loadGradedRows(dir));
    expect(b.totalRows).toBe(a.totalRows);
    expect(b.overall.ats).toEqual(a.overall.ats);
    expect(b.overall.moneyline).toEqual(a.overall.moneyline);
  });
});
