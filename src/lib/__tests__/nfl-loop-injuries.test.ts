import { describe, it, expect } from "vitest";
import {
  parseInjuries,
  indexInjuries,
  type InjuryRow,
} from "../nfl-loop";
import { asKeyFactors, validatePick } from "../nfl-agent";
import { parseGames, buildBlindWeek, type Cursor, type BlindWeek } from "../nfl-loop";

const INJ_CSV = `season,game_type,team,week,gsis_id,position,full_name,first_name,last_name,report_primary_injury,report_secondary_injury,report_status,practice_primary_injury,practice_secondary_injury,practice_status,date_modified
2023,REG,KC,1,00-1,QB,Patrick Mahomes,Patrick,Mahomes,Ankle,Knee,Questionable,Ankle,Knee,Limited,2023-09-06T18:00:00Z
2023,REG,KC,1,00-2,WR,Rashee Rice,Rashee,Rice,Hamstring,,Out,Hamstring,,DNP,2023-09-06T18:00:00Z
2023,REG,KC,1,00-3,LB,Nick Bolton,Nick,Bolton,,,,Rest,,Full,2023-09-06T18:00:00Z
2023,WC,KC,19,00-4,T,Donovan Smith,Donovan,Smith,Neck,,Doubtful,Neck,,DNP,2024-01-12T18:00:00Z`;

describe("parseInjuries", () => {
  const rows = parseInjuries(INJ_CSV);

  it("keeps only report fields and normalizes status", () => {
    expect(rows).toHaveLength(4);
    const mahomes = rows.find((r) => r.player === "Patrick Mahomes")!;
    expect(mahomes.status).toBe("Questionable");
    expect(mahomes.injury).toBe("Ankle / Knee"); // primary + secondary joined
    expect(mahomes.position).toBe("QB");
  });

  it("normalizes a blank report_status to 'None' (keeps the row)", () => {
    const bolton = rows.find((r) => r.player === "Nick Bolton")!;
    expect(bolton.status).toBe("None");
    expect(bolton.injury).toBe(""); // no reported injury
  });

  it("folds postseason rounds (WC) into POST with the source week preserved", () => {
    const wc = rows.find((r) => r.player === "Donovan Smith")!;
    expect(wc.gameType).toBe("POST");
    expect(wc.week).toBe(19);
  });

  it("re-reads headers so concatenated per-season files parse cleanly", () => {
    const concatenated = INJ_CSV + "\n" + INJ_CSV; // second copy brings its own header
    const both = parseInjuries(concatenated);
    expect(both).toHaveLength(8);
  });

  it("returns [] on empty input", () => {
    expect(parseInjuries("")).toEqual([]);
  });
});

describe("indexInjuries", () => {
  it("keys by season|phase|week|team and sorts by status severity", () => {
    const rows = parseInjuries(INJ_CSV);
    const idx = indexInjuries(rows);
    const kc = idx.get("2023|REG|1|KC")!;
    expect(kc.map((i) => i.player)).toEqual([
      "Rashee Rice", // Out — most severe, leads
      "Patrick Mahomes", // Questionable
      "Nick Bolton", // None — least severe, trails
    ]);
    // Postseason KC rows live under a different key, never mixed in.
    expect(idx.get("2023|REG|1|KC")!.some((i) => i.player === "Donovan Smith")).toBe(false);
    expect(idx.get("2023|POST|19|KC")!.map((i) => i.player)).toEqual(["Donovan Smith"]);
  });

  it("never attaches a team's rows to another team", () => {
    const rows: InjuryRow[] = [
      { season: 2024, gameType: "REG", week: 5, team: "BUF", player: "P1", position: "QB", status: "Out", injury: "X" },
      { season: 2024, gameType: "REG", week: 5, team: "NYJ", player: "P2", position: "WR", status: "Questionable", injury: "Y" },
    ];
    const idx = indexInjuries(rows);
    expect(idx.get("2024|REG|5|BUF")!.map((i) => i.player)).toEqual(["P1"]);
    expect(idx.get("2024|REG|5|NYJ")!.map((i) => i.player)).toEqual(["P2"]);
  });
});

describe("asKeyFactors", () => {
  it("cleans, trims, dedupes and caps a string array", () => {
    expect(
      asKeyFactors(["home QB out", "  18mph wind -> under  ", "home QB out", ""]),
    ).toEqual(["home QB out", "18mph wind -> under"]);
  });

  it("splits a single delimited string into factors", () => {
    expect(asKeyFactors("a; b\nc")).toEqual(["a", "b", "c"]);
  });

  it("returns [] for non-string / empty inputs", () => {
    expect(asKeyFactors(null)).toEqual([]);
    expect(asKeyFactors(123)).toEqual([]);
    expect(asKeyFactors([])).toEqual([]);
    expect(asKeyFactors(["", "  "])).toEqual([]);
  });

  it("caps at 8 factors", () => {
    const many = Array.from({ length: 20 }, (_, i) => `f${i}`);
    expect(asKeyFactors(many)).toHaveLength(8);
  });
});

describe("validatePick requires keyFactors", () => {
  const CSV = `game_id,season,game_type,week,gameday,gametime,away_team,home_team,away_moneyline,home_moneyline,spread_line,total_line,under_odds,over_odds,div_game,roof,surface,temp,wind,away_qb_name,home_qb_name,away_coach,home_coach,referee,stadium
2023_01_DET_KC,2023,REG,1,2023-09-07,20:20,DET,KC,140,-160,-4,53,-110,-110,0,outdoors,fieldturf,71,5,Jared Goff,Patrick Mahomes,Dan Campbell,Andy Reid,Carl Cheffers,Arrowhead`;
  const games = parseGames(CSV);
  const cursor: Cursor = { season: 2023, phase: "REG", week: 1 };
  const week: BlindWeek = buildBlindWeek(games, cursor, "");

  const base = {
    gameId: "2023_01_DET_KC",
    atsSide: "away",
    atsSpreadHome: -4,
    moneylineSide: "away",
    totalSide: "under",
    totalLine: 53,
    confidence: 0.6,
    rationale: "DET off a strong camp; wind 5mph negligible.",
  };

  it("accepts a pick with at least one keyFactor", () => {
    const p = validatePick({ ...base, keyFactors: ["road dog +4", "5mph wind neutral"] }, week);
    expect(p).not.toBeNull();
    expect(p!.keyFactors).toEqual(["road dog +4", "5mph wind neutral"]);
  });

  it("rejects a pick missing keyFactors (auditable-reasoning contract)", () => {
    expect(validatePick(base, week)).toBeNull();
    expect(validatePick({ ...base, keyFactors: [] }, week)).toBeNull();
    expect(validatePick({ ...base, keyFactors: ["  "] }, week)).toBeNull();
  });
});
