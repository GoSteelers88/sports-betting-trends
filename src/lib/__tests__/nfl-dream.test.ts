import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assembleNflDreamPayload,
  computePropStatRecord,
  consolidateNflDream,
  loadNflDoctrine,
  writeNflDoctrine,
  nflDoctrinePath,
  type DreamFn,
} from "../nfl-dream";
import { gateDoctrineForWeek, pickUserPrompt, propsUserPrompt } from "../nfl-agent";
import type {
  GradedRow,
  GradedPropRow,
  BlindWeek,
} from "../nfl-loop";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function gameRow(over: Partial<GradedRow>): GradedRow {
  return {
    key: over.key ?? `${over.gameId ?? "G"}|${over.market ?? "ats"}`,
    season: over.season ?? 2023,
    phase: "REG",
    week: over.week ?? 1,
    gameId: over.gameId ?? "G",
    matchup: "AWAY @ HOME",
    market: over.market ?? "ats",
    selection: "HOME -3",
    side: over.side ?? "home",
    confidence: over.confidence ?? 0.6,
    result: over.result ?? "win",
    oddsAmerican: over.oddsAmerican ?? -110,
    pnlUnits: over.pnlUnits ?? 0.9091,
    favored: over.favored ?? "favorite",
    homeAway: over.homeAway ?? "home",
    divGame: over.divGame ?? false,
    dome: over.dome ?? false,
    restAdvantage: over.restAdvantage ?? 0,
    wind: over.wind ?? 5,
    temp: over.temp ?? 60,
    gradedAt: "2023-09-08T00:00:00Z",
    ...over,
  };
}

function propRow(over: Partial<GradedPropRow>): GradedPropRow {
  return {
    key: over.key ?? `${over.gameId ?? "G"}|${over.player ?? "P"}|${over.stat ?? "passYds"}`,
    season: over.season ?? 2023,
    phase: "REG",
    week: over.week ?? 1,
    gameId: over.gameId ?? "G",
    player: over.player ?? "Player",
    team: over.team ?? "KC",
    position: over.position ?? "QB",
    stat: over.stat ?? "passYds",
    threshold: over.threshold ?? 250,
    side: over.side ?? "over",
    confidence: over.confidence ?? 0.6,
    actualValue: over.actualValue ?? 300,
    result: over.result ?? "win",
    rationale: over.rationale ?? "x",
    gradedAt: "2023-09-08T00:00:00Z",
    ...over,
  };
}

// A small but representative record spanning two seasons + all three markets.
const GAME_ROWS: GradedRow[] = [
  gameRow({ key: "1|ats", gameId: "1", season: 2023, market: "ats", result: "win", favored: "favorite", homeAway: "home", confidence: 0.7 }),
  gameRow({ key: "2|ats", gameId: "2", season: 2023, market: "ats", result: "loss", pnlUnits: -1, favored: "underdog", homeAway: "away", confidence: 0.65 }),
  gameRow({ key: "3|ats", gameId: "3", season: 2024, market: "ats", result: "win", favored: "favorite", homeAway: "away", confidence: 0.72 }),
  gameRow({ key: "1|ml", gameId: "1", season: 2023, market: "moneyline", result: "win", pnlUnits: 0.8, side: "home", homeAway: "home", confidence: 0.66 }),
  gameRow({ key: "2|ml", gameId: "2", season: 2023, market: "moneyline", result: "loss", pnlUnits: -1, side: "away", homeAway: "away", confidence: 0.6 }),
  gameRow({ key: "1|tot", gameId: "1", season: 2023, market: "total", side: "over", result: "win", confidence: 0.6 }),
  gameRow({ key: "3|tot", gameId: "3", season: 2024, market: "total", side: "under", result: "loss", pnlUnits: -1, confidence: 0.6 }),
];

const PROP_ROWS: GradedPropRow[] = [
  propRow({ key: "1|A|passYds", stat: "passYds", side: "over", result: "win" }),
  propRow({ key: "2|B|passYds", stat: "passYds", side: "under", result: "win" }),
  propRow({ key: "3|C|passYds", stat: "passYds", side: "over", result: "loss" }),
  propRow({ key: "4|D|rushYds", stat: "rushYds", side: "over", result: "win", threshold: 75 }),
  propRow({ key: "5|E|rushYds", stat: "rushYds", side: "over", result: "no-data", actualValue: null }),
];

// ─── computePropStatRecord ───────────────────────────────────────────────────

describe("computePropStatRecord", () => {
  const rec = computePropStatRecord(PROP_ROWS);

  it("tallies per stat with decisive n and no-data excluded from win rate", () => {
    const passYds = rec.find((r) => r.stat === "passYds")!;
    expect(passYds.wins).toBe(2);
    expect(passYds.losses).toBe(1);
    expect(passYds.n).toBe(3);
    expect(passYds.winRate).toBeCloseTo(0.6667, 3);

    const rushYds = rec.find((r) => r.stat === "rushYds")!;
    expect(rushYds.wins).toBe(1);
    expect(rushYds.noData).toBe(1);
    expect(rushYds.n).toBe(1); // the no-data row is excluded from decisive
    expect(rushYds.winRate).toBeCloseTo(1, 3);
  });

  it("reconstructs over-share from side+result", () => {
    const passYds = rec.find((r) => r.stat === "passYds")!;
    // over-win (went over) + under-win (went under) + over-loss (went under)
    // → 1 of 3 decisive went over
    expect(passYds.overShare).toBeCloseTo(0.3333, 3);
  });

  it("empty input → empty record", () => {
    expect(computePropStatRecord([])).toEqual([]);
  });
});

// ─── assembleNflDreamPayload ─────────────────────────────────────────────────

describe("assembleNflDreamPayload", () => {
  const payload = assembleNflDreamPayload(
    GAME_ROWS,
    PROP_ROWS,
    "weekly memo here",
    "2026-06-14T00:00:00Z",
  );

  it("records summary counts + seasons", () => {
    expect(payload.recordSummary.gameRows).toBe(GAME_ROWS.length);
    expect(payload.recordSummary.propRows).toBe(PROP_ROWS.length);
    expect(payload.recordSummary.seasons).toEqual([2023, 2024]);
  });

  it("overall-by-market section present for all three markets", () => {
    const m = payload.recordSummary.overallByMarket;
    expect(m.ats.record).toBe("2-1-0"); // 2 win, 1 loss
    expect(m.ats.n).toBe(3);
    expect(m.moneyline.record).toBe("1-1-0");
    expect(m.total.record).toBe("1-1-0");
  });

  it("calibration section present (delegated to computeStatRecord)", () => {
    expect(payload.statRecord.calibration.length).toBeGreaterThan(0);
    // gap is the weighted mean |realized − predicted| in pp (or null)
    expect(
      payload.recordSummary.calibrationGapPp === null ||
        typeof payload.recordSummary.calibrationGapPp === "number",
    ).toBe(true);
  });

  it("situational splits present (favoriteVsDog + homeVsAway)", () => {
    const labels = payload.statRecord.splits.favoriteVsDog.map((s) => s.label);
    expect(labels).toContain("favorite");
    expect(labels).toContain("underdog");
    expect(payload.statRecord.splits.homeVsAway.length).toBeGreaterThan(0);
  });

  it("prop record section present + per stat", () => {
    const stats = payload.propRecord.map((p) => p.stat);
    expect(stats).toContain("passYds");
    expect(stats).toContain("rushYds");
  });

  it("parlay section present (settled count + yield shape)", () => {
    expect(payload.parlayStats).toBeDefined();
    expect(typeof payload.recordSummary.parlay.settled).toBe("number");
    expect(payload.recordSummary.parlay.roiPct).toBeDefined();
  });

  it("carries the weekly memo through for continuity", () => {
    expect(payload.currentWeeklyMemo).toBe("weekly memo here");
  });
});

// ─── doctrine round-trip ─────────────────────────────────────────────────────

describe("doctrine writer/reader round-trip", () => {
  let tmp: string;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("write → load returns the lessons body + coverage, absent → empty + null", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nfl-dream-"));
    const absent = loadNflDoctrine(tmp);
    expect(absent.text).toBe(""); // absent degrades cleanly
    expect(absent.coverage).toBeNull();

    const lessons = "## Markets\n- ATS is the lean (n=420). Validate live.";
    writeNflDoctrine(tmp, "2026-06-14T00:00:00Z", lessons, GAME_ROWS);

    const loaded = loadNflDoctrine(tmp);
    expect(loaded.text).toContain("## Markets");
    expect(loaded.text).toContain("ATS is the lean");
    // the header carries the honesty caveat
    expect(loaded.text).toContain("OPTIMISTIC UPPER BOUNDS");
    // coverage round-trips: GAME_ROWS max is 2024 REG wk1
    expect(loaded.coverage).toEqual({
      season: 2024,
      phase: "REG",
      week: 1,
      generatedAt: "2026-06-14T00:00:00Z",
    });
    expect(fs.existsSync(nflDoctrinePath(tmp))).toBe(true);
  });

  it("is idempotent (re-write overwrites in place)", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nfl-dream-"));
    writeNflDoctrine(tmp, "2026-06-14T00:00:00Z", "first", GAME_ROWS);
    writeNflDoctrine(tmp, "2026-06-15T00:00:00Z", "second", GAME_ROWS);
    const loaded = loadNflDoctrine(tmp);
    expect(loaded.text).toContain("second");
    expect(loaded.text).not.toContain("first");
  });
});

// ─── consolidateNflDream (mocked Opus seam — no real spend) ───────────────────

describe("consolidateNflDream", () => {
  let tmp: string;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("runs the seam, writes the doctrine, returns structured result", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nfl-dream-"));
    let sawPayload = false;
    const stub: DreamFn = async (payload) => {
      // the seam receives the assembled payload (proves the wiring)
      sawPayload = payload.recordSummary.gameRows === GAME_ROWS.length;
      return "## Markets\n- lean ATS. Validate live.";
    };

    const result = await consolidateNflDream({
      dir: tmp,
      gameRows: GAME_ROWS,
      propRows: PROP_ROWS,
      weeklyMemo: "memo",
      dreamFn: stub,
      nowIso: "2026-06-14T00:00:00Z",
    });

    expect(sawPayload).toBe(true);
    expect(result).not.toBeNull();
    expect(result!.lessons).toContain("lean ATS");
    expect(result!.keyMetrics.gameRows).toBe(GAME_ROWS.length);
    // the file was actually written
    expect(loadNflDoctrine(tmp).text).toContain("lean ATS");
  });

  it("no-ops politely on an empty record (no seam call, null result)", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nfl-dream-"));
    let called = false;
    const stub: DreamFn = async () => {
      called = true;
      return "should not be written";
    };

    const result = await consolidateNflDream({
      dir: tmp,
      gameRows: [],
      propRows: [],
      dreamFn: stub,
    });

    expect(called).toBe(false);
    expect(result).toBeNull();
    expect(fs.existsSync(nflDoctrinePath(tmp))).toBe(false);
  });

  it("respects write:false (returns result without writing the file)", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nfl-dream-"));
    const stub: DreamFn = async () => "ephemeral doctrine";
    const result = await consolidateNflDream({
      dir: tmp,
      gameRows: GAME_ROWS,
      propRows: PROP_ROWS,
      dreamFn: stub,
      write: false,
    });
    expect(result!.lessons).toBe("ephemeral doctrine");
    expect(fs.existsSync(nflDoctrinePath(tmp))).toBe(false);
  });
});

// ─── prompt injection — doctrine threads into the pick/prop prompts ──────────

function blindWeek(over: Partial<BlindWeek> = {}): BlindWeek {
  return {
    season: 2025,
    phase: "REG",
    week: 5,
    lessons: "rolling weekly memo",
    games: [
      {
        gameId: "2025_05_AAA_BBB",
        season: 2025,
        gameType: "REG",
        week: 5,
        kickoff: "2025-10-05 13:00",
        away: "AAA",
        home: "BBB",
        awayRecord: "2-2",
        homeRecord: "3-1",
        market: {
          spreadLineHome: -3,
          totalLine: 44,
          awayMoneyline: 130,
          homeMoneyline: -150,
          overOdds: -110,
          underOdds: -110,
        },
        context: {
          awayRest: 7,
          homeRest: 7,
          divGame: false,
          roof: "outdoors",
          surface: "grass",
          temp: 60,
          wind: 5,
          awayQb: "QB A",
          homeQb: "QB B",
          awayCoach: "C A",
          homeCoach: "C B",
          referee: "Ref",
          stadium: "Stadium",
        },
        injuries: { away: [], home: [] },
      },
    ],
    playerContexts: [
      {
        player: "Star QB",
        position: "QB",
        team: "BBB",
        gamesPlayed: 4,
        injuryStatus: null,
        seasonAvg: {
          passYds: 280,
          passTDs: 2,
          rushYds: 10,
          rushTDs: 0,
          recYds: null,
          recTDs: null,
          receptions: null,
          targets: null,
        },
      },
    ],
    ...over,
  };
}

describe("doctrine prompt injection", () => {
  const DOCTRINE = "## Markets\n- Be MORE selective on road favorites of 7+ (n=120). Validate live.";

  it("pick prompt includes the doctrine, clearly labeled, when present", () => {
    const prompt = pickUserPrompt(blindWeek(), DOCTRINE);
    expect(prompt).toContain("DURABLE CROSS-SEASON DOCTRINE");
    expect(prompt).toContain("road favorites of 7+");
    // still carries the rolling weekly memo separately
    expect(prompt).toContain("rolling weekly memo");
  });

  it("pick prompt degrades cleanly when doctrine is absent (no label, no crash)", () => {
    const prompt = pickUserPrompt(blindWeek(), "");
    expect(prompt).not.toContain("DURABLE CROSS-SEASON DOCTRINE");
    expect(prompt).toContain("rolling weekly memo"); // weekly memo still present
  });

  it("props prompt includes the doctrine when present", () => {
    const prompt = propsUserPrompt(blindWeek(), DOCTRINE);
    expect(prompt).toContain("DURABLE CROSS-SEASON DOCTRINE");
    expect(prompt).toContain("road favorites of 7+");
  });

  it("props prompt degrades cleanly when doctrine is absent", () => {
    const prompt = propsUserPrompt(blindWeek(), "");
    expect(prompt).not.toContain("DURABLE CROSS-SEASON DOCTRINE");
  });
});

// ─── leak guard: doctrine never injected into a covered (past) week ──────────
// The invariant: a pick for cursor week N may use ONLY data from weeks < N. A
// doctrine consolidated through 2025 POST wk22 must therefore be GATED OUT of any
// pick at or before that bound (a backtest re-run), and injected only AFTER it.

describe("doctrine leak guard (cursorAfterCoverage gate)", () => {
  let tmp: string;
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("gates the doctrine OUT for a past-week re-run, IN for a future week", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nfl-dream-"));

    // Doctrine consolidated from a record whose latest game is 2025 POST wk22.
    const covRows: GradedRow[] = [
      gameRow({ key: "z|ats", gameId: "z", season: 2025, phase: "POST", week: 22 }),
      gameRow({ key: "a|ats", gameId: "a", season: 2023, phase: "REG", week: 1 }),
    ];
    const lessons = "## Markets\n- road favorites of 7+ underperformed ATS (n=120). Validate live.";
    writeNflDoctrine(tmp, "2026-06-14T00:00:00Z", lessons, covRows);

    const loaded = loadNflDoctrine(tmp);
    expect(loaded.coverage).toEqual({
      season: 2025,
      phase: "POST",
      week: 22,
      generatedAt: "2026-06-14T00:00:00Z",
    });

    // RE-RUN of an early past week (2023 REG wk1) → NO doctrine (blind prompt clean).
    const past = blindWeek({ season: 2023, phase: "REG", week: 1 });
    const pastGate = gateDoctrineForWeek(loaded, past);
    expect(pastGate).toBe("");
    expect(pickUserPrompt(past, pastGate)).not.toContain("DURABLE CROSS-SEASON DOCTRINE");

    // The covered bound itself (2025 POST wk22) is NOT strictly-after → still gated out.
    const atBound = blindWeek({ season: 2025, phase: "POST", week: 22 });
    expect(gateDoctrineForWeek(loaded, atBound)).toBe("");

    // FORWARD picks (2026 REG wk1) → doctrine IS injected (legitimately leak-free).
    const future = blindWeek({ season: 2026, phase: "REG", week: 1 });
    const futureGate = gateDoctrineForWeek(loaded, future);
    expect(futureGate).not.toBe("");
    expect(pickUserPrompt(future, futureGate)).toContain("DURABLE CROSS-SEASON DOCTRINE");
    expect(pickUserPrompt(future, futureGate)).toContain("road favorites of 7+");
  });

  it("respects REG-before-POST phase ordering at the season boundary", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nfl-dream-"));
    // Coverage bound = 2025 REG wk18.
    const covRows: GradedRow[] = [
      gameRow({ key: "r|ats", gameId: "r", season: 2025, phase: "REG", week: 18 }),
    ];
    writeNflDoctrine(tmp, "2026-06-14T00:00:00Z", "## Markets\n- lean ATS (n=200). Validate live.", covRows);
    const loaded = loadNflDoctrine(tmp);

    // Same season, POST phase > REG phase → strictly after → injected.
    const post = blindWeek({ season: 2025, phase: "POST", week: 19 });
    expect(gateDoctrineForWeek(loaded, post)).not.toBe("");

    // Same season, an EARLIER REG week → not after → gated out.
    const earlierReg = blindWeek({ season: 2025, phase: "REG", week: 5 });
    expect(gateDoctrineForWeek(loaded, earlierReg)).toBe("");
  });
});
