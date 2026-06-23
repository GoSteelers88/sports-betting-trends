import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parsePlayerStats,
  buildPlayerContexts,
  gradePropPick,
  actualStatKey,
  upsertGradedPropRows,
  loadGradedPropRows,
  propPicksLogPath,
  indexInjuries,
  parseInjuries,
  type PlayerStatRow,
  type PropPick,
  type Cursor,
} from "../nfl-loop";

// ─── Fixture: three-row player_stats CSV with real nflverse column names ───

// nflverse uses `season_type` (not `game_type`), `player_display_name` (not
// `full_name`), `recent_team` (not `team`). This fixture verifies the parser
// maps them correctly.
const PLAYER_STATS_CSV = `player_id,player_display_name,position,recent_team,season,week,season_type,passing_yards,passing_tds,rushing_yards,rushing_tds,receptions,targets,receiving_yards,receiving_tds
00-001,Patrick Mahomes,QB,KC,2023,1,REG,312,2,18,0,,,,
00-002,Travis Kelce,TE,KC,2023,1,REG,,,,,7,10,85,1
00-003,Tyreek Hill,WR,MIA,2023,1,REG,,,,,9,14,120,0
`;

// A row with an irrelevant position (K = kicker) to verify filtering
const PLAYER_STATS_WITH_KICKER_CSV = `player_id,player_display_name,position,recent_team,season,week,season_type,passing_yards,passing_tds,rushing_yards,rushing_tds,receptions,targets,receiving_yards,receiving_tds
00-001,Patrick Mahomes,QB,KC,2023,1,REG,312,2,18,0,,,,
00-099,Harrison Butker,K,KC,2023,1,REG,,,,,,,,
`;

// Multi-season concatenated fixture (two header rows)
const MULTI_SEASON_CSV = `player_id,player_display_name,position,recent_team,season,week,season_type,passing_yards,passing_tds,rushing_yards,rushing_tds,receptions,targets,receiving_yards,receiving_tds
00-001,Patrick Mahomes,QB,KC,2023,1,REG,312,2,18,0,,,,
player_id,player_display_name,position,recent_team,season,week,season_type,passing_yards,passing_tds,rushing_yards,rushing_tds,receptions,targets,receiving_yards,receiving_tds
00-001,Patrick Mahomes,QB,KC,2024,1,REG,275,1,12,0,,,,
`;

// ─── parsePlayerStats ───────────────────────────────────────────────────────

describe("parsePlayerStats", () => {
  it("maps nflverse column names correctly for QB row", () => {
    const rows = parsePlayerStats(PLAYER_STATS_CSV);
    const mahomes = rows.find((r) => r.playerName === "Patrick Mahomes");
    expect(mahomes).toBeDefined();
    expect(mahomes!.playerId).toBe("00-001");
    expect(mahomes!.position).toBe("QB");
    expect(mahomes!.team).toBe("KC");
    expect(mahomes!.season).toBe(2023);
    expect(mahomes!.week).toBe(1);
    expect(mahomes!.gameType).toBe("REG");
    expect(mahomes!.passYds).toBe(312);
    expect(mahomes!.passTDs).toBe(2);
    expect(mahomes!.rushYds).toBe(18);
  });

  it("maps TE row receiving stats correctly", () => {
    const rows = parsePlayerStats(PLAYER_STATS_CSV);
    const kelce = rows.find((r) => r.playerName === "Travis Kelce");
    expect(kelce).toBeDefined();
    expect(kelce!.receptions).toBe(7);
    expect(kelce!.targets).toBe(10);
    expect(kelce!.recYds).toBe(85);
    expect(kelce!.recTDs).toBe(1);
  });

  it("filters out non-QB/RB/WR/TE positions (kicker)", () => {
    const rows = parsePlayerStats(PLAYER_STATS_WITH_KICKER_CSV);
    const kicker = rows.find((r) => r.position === "K");
    expect(kicker).toBeUndefined();
    // QB still present
    expect(rows.find((r) => r.position === "QB")).toBeDefined();
  });

  it("handles multi-season concatenated CSV (two header rows)", () => {
    const rows = parsePlayerStats(MULTI_SEASON_CSV);
    expect(rows.filter((r) => r.season === 2023)).toHaveLength(1);
    expect(rows.filter((r) => r.season === 2024)).toHaveLength(1);
  });

  it("returns [] for empty input", () => {
    expect(parsePlayerStats("")).toHaveLength(0);
  });
});

// ─── buildPlayerContexts ────────────────────────────────────────────────────

describe("buildPlayerContexts", () => {
  // Build a multi-week fixture: Mahomes has week 1-4 data; cursor is week 5.
  function makeRows(season: number, weekCount: number): PlayerStatRow[] {
    const rows: PlayerStatRow[] = [];
    for (let w = 1; w <= weekCount; w++) {
      rows.push({
        playerId: "00-001",
        playerName: "Patrick Mahomes",
        position: "QB",
        team: "KC",
        season,
        week: w,
        gameType: "REG",
        passYds: 250 + w * 10,
        passTDs: 2,
        rushYds: 10,
        rushTDs: 0,
        receptions: null,
        targets: null,
        recYds: null,
        recTDs: null,
      });
    }
    return rows;
  }

  it("filters to prior weeks strictly (< cursor.week)", () => {
    const rows = makeRows(2023, 5);
    const cursor: Cursor = { season: 2023, phase: "REG", week: 5 };
    const injIndex = indexInjuries([]);
    const contexts = buildPlayerContexts(rows, cursor, injIndex);
    const mahomes = contexts.find((c) => c.player === "Patrick Mahomes");
    expect(mahomes).toBeDefined();
    // weeks 1-4 included; week 5 excluded. avg passYds = (260+270+280+290)/4 = 275
    expect(mahomes!.gamesPlayed).toBe(4);
    expect(mahomes!.seasonAvg.passYds).toBeCloseTo(275);
  });

  it("week-1 cold-start: returns [] when all stats are at wk1 and cursor is wk1", () => {
    const rows = makeRows(2023, 1);
    const cursor: Cursor = { season: 2023, phase: "REG", week: 1 };
    const injIndex = indexInjuries([]);
    const contexts = buildPlayerContexts(rows, cursor, injIndex);
    expect(contexts).toHaveLength(0);
  });

  it("graceful degradation: empty stats returns []", () => {
    const cursor: Cursor = { season: 2023, phase: "REG", week: 5 };
    const injIndex = indexInjuries([]);
    const contexts = buildPlayerContexts([], cursor, injIndex);
    expect(contexts).toHaveLength(0);
  });

  it("POST cursor uses REG season rows as prior context", () => {
    // 3 REG weeks + 1 POST week; cursor at POST wk19
    const rows: PlayerStatRow[] = [];
    for (let w = 1; w <= 3; w++) {
      rows.push({
        playerId: "00-001",
        playerName: "Patrick Mahomes",
        position: "QB",
        team: "KC",
        season: 2023,
        week: w,
        gameType: "REG",
        passYds: 300,
        passTDs: 2,
        rushYds: 10,
        rushTDs: 0,
        receptions: null,
        targets: null,
        recYds: null,
        recTDs: null,
      });
    }
    const cursor: Cursor = { season: 2023, phase: "POST", week: 19 };
    const injIndex = indexInjuries([]);
    const contexts = buildPlayerContexts(rows, cursor, injIndex);
    const mahomes = contexts.find((c) => c.player === "Patrick Mahomes");
    expect(mahomes).toBeDefined();
    expect(mahomes!.gamesPlayed).toBe(3);
    expect(mahomes!.seasonAvg.passYds).toBeCloseTo(300);
  });

  it("attaches injury status when player is in the injury index", () => {
    const INJ_CSV = `season,game_type,team,week,gsis_id,position,full_name,first_name,last_name,report_primary_injury,report_secondary_injury,report_status,practice_primary_injury,practice_secondary_injury,practice_status,date_modified
2023,REG,KC,5,00-001,QB,Patrick Mahomes,Patrick,Mahomes,Knee,,Questionable,Knee,,Limited,2023-10-10T18:00:00Z
`;
    const rows = makeRows(2023, 5);
    const cursor: Cursor = { season: 2023, phase: "REG", week: 5 };
    const injIndex = indexInjuries(parseInjuries(INJ_CSV));
    const contexts = buildPlayerContexts(rows, cursor, injIndex);
    const mahomes = contexts.find((c) => c.player === "Patrick Mahomes");
    expect(mahomes).toBeDefined();
    expect(mahomes!.injuryStatus).toBe("Questionable");
  });

  it("sets injuryStatus null when player not in injury report", () => {
    const rows = makeRows(2023, 5);
    const cursor: Cursor = { season: 2023, phase: "REG", week: 5 };
    const injIndex = indexInjuries([]);
    const contexts = buildPlayerContexts(rows, cursor, injIndex);
    const mahomes = contexts.find((c) => c.player === "Patrick Mahomes");
    expect(mahomes!.injuryStatus).toBeNull();
  });
});

// ─── gradePropPick ──────────────────────────────────────────────────────────

function makeStatRow(overrides: Partial<PlayerStatRow> = {}): PlayerStatRow {
  return {
    playerId: "00-001",
    playerName: "Patrick Mahomes",
    position: "QB",
    team: "KC",
    season: 2023,
    week: 5,
    gameType: "REG",
    passYds: 300,
    passTDs: 3,
    rushYds: 20,
    rushTDs: 0,
    receptions: null,
    targets: null,
    recYds: null,
    recTDs: null,
    ...overrides,
  };
}

function makePick(overrides: Partial<PropPick> = {}): PropPick {
  return {
    player: "Patrick Mahomes",
    team: "KC",
    position: "QB",
    stat: "passYds",
    threshold: 250,
    side: "over",
    confidence: 0.7,
    rationale: "Strong matchup vs weak secondary",
    ...overrides,
  };
}

const CURSOR: Cursor = { season: 2023, phase: "REG", week: 5 };

describe("gradePropPick", () => {
  it("over wins when actualValue exceeds threshold by >= 0.5", () => {
    const actualMap = new Map([["Patrick Mahomes|KC", makeStatRow({ passYds: 300 })]]);
    const row = gradePropPick(makePick({ threshold: 250, side: "over" }), "game123", CURSOR, actualMap);
    expect(row.result).toBe("win");
    expect(row.actualValue).toBe(300);
  });

  it("over loses when actualValue is below threshold by >= 0.5", () => {
    const actualMap = new Map([["Patrick Mahomes|KC", makeStatRow({ passYds: 200 })]]);
    const row = gradePropPick(makePick({ threshold: 250, side: "over" }), "game123", CURSOR, actualMap);
    expect(row.result).toBe("loss");
  });

  it("under wins when actualValue is below threshold by >= 0.5", () => {
    const actualMap = new Map([["Patrick Mahomes|KC", makeStatRow({ passYds: 200 })]]);
    const row = gradePropPick(makePick({ threshold: 250, side: "under" }), "game123", CURSOR, actualMap);
    expect(row.result).toBe("win");
  });

  it("under loses when actualValue exceeds threshold by >= 0.5", () => {
    const actualMap = new Map([["Patrick Mahomes|KC", makeStatRow({ passYds: 300 })]]);
    const row = gradePropPick(makePick({ threshold: 250, side: "under" }), "game123", CURSOR, actualMap);
    expect(row.result).toBe("loss");
  });

  it("push when actualValue is within 0.5 of threshold (integer line)", () => {
    // threshold 50, actual 50.3 → diff 0.3 < 0.5 → push
    const actualMap = new Map([["Patrick Mahomes|KC", makeStatRow({ passYds: 50.3 })]]);
    const row = gradePropPick(makePick({ threshold: 50, side: "over" }), "game123", CURSOR, actualMap);
    expect(row.result).toBe("push");
  });

  it("no-data when player not in actualStats map", () => {
    const actualMap = new Map<string, PlayerStatRow>();
    const row = gradePropPick(makePick(), "game123", CURSOR, actualMap);
    expect(row.result).toBe("no-data");
    expect(row.actualValue).toBeNull();
  });

  it("no-data when player's stat field is null in the actual row", () => {
    const actualMap = new Map([["Patrick Mahomes|KC", makeStatRow({ passYds: null })]]);
    const row = gradePropPick(makePick({ stat: "passYds" }), "game123", CURSOR, actualMap);
    expect(row.result).toBe("no-data");
  });

  it("disambiguates two same-display-name players on different teams (finding #2)", () => {
    // nflverse has real duplicate display names (two 'Mike Williams', LAC + NYJ).
    // Keying the actual-stat map by name alone would grade against the wrong box
    // score. The compound name|team key must resolve each to its own line.
    const lacWilliams = makeStatRow({
      playerName: "Mike Williams",
      team: "LAC",
      position: "WR",
      passYds: null,
      recYds: 95, // big game
    });
    const nyjWilliams = makeStatRow({
      playerName: "Mike Williams",
      team: "NYJ",
      position: "WR",
      passYds: null,
      recYds: 5, // quiet game
    });
    const actualMap = new Map([
      [actualStatKey("Mike Williams", "LAC"), lacWilliams],
      [actualStatKey("Mike Williams", "NYJ"), nyjWilliams],
    ]);

    // A prop on the LAC Williams OVER 50 rec yds must grade against 95 (win),
    // not against the NYJ Williams' 5 (which would be a loss).
    const lacPick = makePick({
      player: "Mike Williams",
      team: "LAC",
      position: "WR",
      stat: "recYds",
      threshold: 50,
      side: "over",
    });
    const lacRow = gradePropPick(lacPick, "game-lac", CURSOR, actualMap);
    expect(lacRow.actualValue).toBe(95);
    expect(lacRow.result).toBe("win");

    // The NYJ Williams OVER 50 must grade against 5 (loss).
    const nyjPick = makePick({
      player: "Mike Williams",
      team: "NYJ",
      position: "WR",
      stat: "recYds",
      threshold: 50,
      side: "over",
    });
    const nyjRow = gradePropPick(nyjPick, "game-nyj", CURSOR, actualMap);
    expect(nyjRow.actualValue).toBe(5);
    expect(nyjRow.result).toBe("loss");
  });

  it("key format is gameId|player|stat", () => {
    const actualMap = new Map([["Patrick Mahomes|KC", makeStatRow()]]);
    const row = gradePropPick(makePick({ stat: "passYds" }), "2023_05_DET_KC", CURSOR, actualMap);
    expect(row.key).toBe("2023_05_DET_KC|Patrick Mahomes|passYds");
  });

  it("carries the pick's rationale onto the graded row", () => {
    const actualMap = new Map([["Patrick Mahomes|KC", makeStatRow({ passYds: 300 })]]);
    const row = gradePropPick(
      makePick({ rationale: "Pace-up spot vs bottom-5 pass D; no injury flags" }),
      "game123",
      CURSOR,
      actualMap,
    );
    expect(row.rationale).toBe("Pace-up spot vs bottom-5 pass D; no injury flags");
  });

  it("carries rationale even on a no-data grade (the field is set before grading)", () => {
    const actualMap = new Map<string, PlayerStatRow>(); // miss → no-data
    const row = gradePropPick(makePick({ rationale: "thesis text" }), "g", CURSOR, actualMap);
    expect(row.result).toBe("no-data");
    expect(row.rationale).toBe("thesis text");
  });

  it("half-line threshold (passTDs=1.5): over with 2 TDs → win (no push possible)", () => {
    const actualMap = new Map([["Patrick Mahomes|KC", makeStatRow({ passTDs: 2 })]]);
    const row = gradePropPick(
      makePick({ stat: "passTDs", threshold: 1.5, side: "over" }),
      "game123",
      CURSOR,
      actualMap,
    );
    expect(row.result).toBe("win");
  });
});

// ─── upsertGradedPropRows — idempotency ─────────────────────────────────────

describe("upsertGradedPropRows", () => {
  let tmpDir: string;

  afterEach(() => {
    // Clean up temp dir
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function makeGradedPropRow(overrides: object = {}) {
    return {
      key: "game123|Patrick Mahomes|passYds",
      season: 2023,
      phase: "REG" as const,
      week: 5,
      gameId: "game123",
      player: "Patrick Mahomes",
      team: "KC",
      position: "QB",
      stat: "passYds" as const,
      threshold: 250,
      side: "over" as const,
      confidence: 0.7,
      actualValue: 300,
      result: "win" as const,
      rationale: "test rationale",
      gradedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it("is idempotent — running twice yields same row count", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nfl-props-test-"));
    const row = makeGradedPropRow();

    const first = upsertGradedPropRows(tmpDir, [row]);
    expect(first.added).toBe(1);
    expect(first.replaced).toBe(0);

    // Second run with same row
    const second = upsertGradedPropRows(tmpDir, [row]);
    expect(second.added).toBe(0);
    expect(second.replaced).toBe(1);

    // File still has exactly 1 row
    const loaded = loadGradedPropRows(tmpDir);
    expect(loaded).toHaveLength(1);
  });

  it("adds new rows, replaces existing rows by key", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nfl-props-test-"));
    const row1 = makeGradedPropRow({ key: "g1|P1|passYds" });
    const row2 = makeGradedPropRow({ key: "g2|P2|rushYds" });

    upsertGradedPropRows(tmpDir, [row1]);
    const result = upsertGradedPropRows(tmpDir, [row2]);
    expect(result.added).toBe(1);
    expect(result.replaced).toBe(0);

    const loaded = loadGradedPropRows(tmpDir);
    expect(loaded).toHaveLength(2);
  });

  it("writes to propPicksLogPath only (never touches picks-log.jsonl)", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nfl-props-test-"));
    const row = makeGradedPropRow();
    upsertGradedPropRows(tmpDir, [row]);

    // prop-picks-log.jsonl must exist
    expect(fs.existsSync(propPicksLogPath(tmpDir))).toBe(true);

    // picks-log.jsonl must NOT exist (never created by this function)
    const picksLog = path.join(tmpDir, "picks-log.jsonl");
    expect(fs.existsSync(picksLog)).toBe(false);
  });

  it("returns { added: 0, replaced: 0 } for empty rows array without touching disk", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nfl-props-test-"));
    const result = upsertGradedPropRows(tmpDir, []);
    expect(result.added).toBe(0);
    expect(result.replaced).toBe(0);
    // No file created
    expect(fs.existsSync(propPicksLogPath(tmpDir))).toBe(false);
  });

  it("backward-compat: loads an OLD row that predates the rationale field", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nfl-props-test-"));
    // Simulate a row written before `rationale` existed — no such key on disk.
    const oldRow = makeGradedPropRow();
    delete (oldRow as { rationale?: string }).rationale;
    expect("rationale" in oldRow).toBe(false);
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(propPicksLogPath(tmpDir), JSON.stringify(oldRow) + "\n");

    const loaded = loadGradedPropRows(tmpDir);
    expect(loaded).toHaveLength(1);
    // rationale parses as undefined; downstream coerces to "" — never crashes.
    expect(loaded[0].rationale).toBeUndefined();
    expect(loaded[0].result).toBe("win");
  });
});

// ─── log isolation: prop keys never overlap game keys ───────────────────────

describe("log isolation", () => {
  it("prop row keys never share format with game row keys", () => {
    // Game row key format: `${gameId}|${market}` where market ∈ {ats, moneyline, total}
    // Prop row key format: `${gameId}|${player}|${stat}`
    // The prop key has 2 pipe characters; the game key has 1. They can never collide.
    const gameKeys = ["2023_05_DET_KC|ats", "2023_05_DET_KC|moneyline", "2023_05_DET_KC|total"];
    const propKey = "2023_05_DET_KC|Patrick Mahomes|passYds";

    for (const gk of gameKeys) {
      expect(propKey).not.toBe(gk);
    }
    // Verify the structural difference: prop keys always have exactly 2 pipes
    expect((propKey.match(/\|/g) ?? []).length).toBe(2);
    for (const gk of gameKeys) {
      expect((gk.match(/\|/g) ?? []).length).toBe(1);
    }
  });
});
