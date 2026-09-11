// nfl-model-from-board — the bridge from the published /nfl doctrine board to
// the analyst's get_model_probabilities(NFL) feed. The invariant under test:
// the account's NFL edge can only exist where the doctrine board played.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildNflModelFromBoard,
  fullTeamName,
  latestBoardFile,
} from "../nfl-model-from-board";
import { devigTwoWay } from "../nfl-devig";
import type { PublishedBoard, PublishedLeg } from "../nfl-receipts/board";

const KICKOFF = "2026-09-13T17:00:00Z";
const NOW = Date.parse("2026-09-10T12:00:00Z");

function leg(over: Partial<PublishedLeg>): PublishedLeg {
  return {
    legId: "deadbeef00000001",
    role: "pass",
    gameId: "2026_01_NYJ_TEN",
    matchup: "NYJ @ TEN",
    kickoffUtc: KICKOFF,
    market: "moneyline",
    selection: "TEN ML",
    side: "home",
    point: null,
    entryPriceAmerican: -125,
    entryOtherSideAmerican: 106,
    priceProvenance: {
      book: "draftkings",
      snapshotFile: "snapshots/entry-2026-wk01.json",
      snapshotFetchedAt: "2026-09-08T14:09:00Z",
      oddsApiEventId: "abc123",
    },
    clvEligible: true,
    ...over,
  } as PublishedLeg;
}

function board(legs: PublishedLeg[]): PublishedBoard {
  return {
    schemaVersion: 1,
    season: 2026,
    week: 1,
    publishedAt: "2026-09-08T14:09:00Z",
    entrySnapshotFile: "snapshots/entry-2026-wk01.json",
    entrySnapshotFetchedAt: "2026-09-08T14:09:00Z",
    oddsApiQuotaUsedAtPublish: "1",
    modelBoardSource: "2026-REG-wk1.json",
    legs,
    dropped: [],
  } as unknown as PublishedBoard;
}

describe("fullTeamName", () => {
  it("resolves nflverse abbreviations and full names to the Odds API display name", () => {
    expect(fullTeamName("NYJ")).toBe("New York Jets");
    expect(fullTeamName("GB")).toBe("Green Bay Packers");
    expect(fullTeamName("Green Bay Packers")).toBe("Green Bay Packers");
  });
  it("refuses to guess an unknown spelling", () => {
    expect(fullTeamName("Gotham Knights")).toBeNull();
  });
});

describe("buildNflModelFromBoard", () => {
  it("a PLAY leg carries its calibrated probability on the played side", () => {
    const b = board([
      leg({
        role: "play",
        selection: "NYJ ML",
        side: "away",
        entryPriceAmerican: 106,
        entryOtherSideAmerican: -125,
        calibratedConfidence: 0.6331,
        edge: 0.1656,
        verdict: "PLAY",
      } as Partial<PublishedLeg>),
    ]);
    const out = buildNflModelFromBoard(b, "board-2026-wk01.json", NOW);
    expect(out.status).toBe("ok");
    expect(out.recordCount).toBe(1);
    const g = out.data.results[0];
    expect(g.homeTeam).toBe("Tennessee Titans");
    expect(g.awayTeam).toBe("New York Jets");
    expect(g.awayWinProb).toBeCloseTo(0.6331, 4);
    expect(g.homeWinProb).toBeCloseTo(1 - 0.6331, 4);
    expect(g.verdict).toBe("PLAY");
    expect(g.eventId).toBe("abc123");
    expect(g.notes[0]).toMatch(/doctrine: PLAY NYJ ML/);
  });

  it("a PASS leg is pinned to the power-devig market — zero edge by construction", () => {
    const b = board([
      leg({
        role: "pass",
        calibratedConfidence: 0.6331,
        verdict: "PASS",
        passReason: "edge 2.3% < floor 5.0%",
      } as Partial<PublishedLeg>),
    ]);
    const out = buildNflModelFromBoard(b, "board-2026-wk01.json", NOW);
    const g = out.data.results[0];
    const fairHome = devigTwoWay(-125, 106).byMethod.power;
    expect(g.homeWinProb).toBeCloseTo(fairHome, 4);
    expect(g.awayWinProb).toBeCloseTo(1 - fairHome, 4);
    expect(g.verdict).toBe("PASS");
    expect(g.notes.join(" ")).toMatch(/PASS TEN ML — edge 2.3% < floor 5.0%/);
    expect(g.notes.join(" ")).toMatch(/pinned to the de-vigged/);
    // The calibrated read is kept for reference but never becomes the probability.
    expect(g.notes.join(" ")).toMatch(/reference only: calibrated 63.3%/);
  });

  it("control legs are never a model read", () => {
    const b = board([
      leg({
        role: "control",
        legId: "c0ffee0000000001",
        matchup: "Dallas Cowboys @ New York Giants",
        selection: "CONTROL[deadbeef00000001]:away",
        side: "away",
        gameId: "2026_01_DAL_NYG",
        verdict: "CONTROL",
      } as Partial<PublishedLeg>),
    ]);
    const out = buildNflModelFromBoard(b, "board-2026-wk01.json", NOW);
    expect(out.recordCount).toBe(0);
    expect(out.status).toBe("no-games");
  });

  it("a game whose kickoff has passed is dropped — a played game is not a forecast", () => {
    const b = board([leg({ kickoffUtc: "2026-09-10T00:20:00Z" })]);
    // 12h after that kickoff.
    const out = buildNflModelFromBoard(b, "board-2026-wk01.json", Date.parse("2026-09-10T12:20:00Z"));
    expect(out.recordCount).toBe(0);
  });

  it("a PASS leg with no two-sided entry price is skipped and reported, never guessed", () => {
    const b = board([leg({ entryPriceAmerican: null, entryOtherSideAmerican: null })]);
    const out = buildNflModelFromBoard(b, "board-2026-wk01.json", NOW);
    expect(out.recordCount).toBe(0);
    expect(out.errors[0]).toMatch(/no two-sided entry price/);
  });

  it("an unrecognised team is a reported join failure, not a fuzzy match", () => {
    const b = board([leg({ matchup: "XYZ @ TEN" })]);
    const out = buildNflModelFromBoard(b, "board-2026-wk01.json", NOW);
    expect(out.recordCount).toBe(0);
    expect(out.errors[0]).toMatch(/unrecognised team name/);
  });

  it("probabilities always sum to 1 and the envelope matches the NBA/WNBA/NHL reader path", () => {
    const b = board([leg({}), leg({ gameId: "g2", legId: "deadbeef00000002", matchup: "GB @ MIN", selection: "MIN ML" })]);
    const out = buildNflModelFromBoard(b, "board-2026-wk01.json", NOW);
    expect(out.data.results.length).toBe(2);
    for (const g of out.data.results) {
      expect(g.homeWinProb + g.awayWinProb).toBeCloseTo(1, 6);
      expect(typeof g.homeTeam).toBe("string");
      expect(typeof g.awayTeam).toBe("string");
    }
    expect(out.data.generatedAt).toBe(new Date(NOW).toISOString());
    expect(out.season).toBe(2026);
    expect(out.week).toBe(1);
  });
});

describe("latestBoardFile", () => {
  it("picks the highest (season, week)", () => {
    expect(
      latestBoardFile([
        { file: "board-2026-wk01.json", season: 2026, week: 1 },
        { file: "board-2026-wk03.json", season: 2026, week: 3 },
        { file: "board-2025-wk18.json", season: 2025, week: 18 },
      ]),
    ).toBe("board-2026-wk03.json");
    expect(latestBoardFile([])).toBeNull();
  });
});

describe("against the committed week-1 board (frozen anchor)", () => {
  const p = path.join(process.cwd(), "data", "processed", "nfl-live", "board-2026-wk01.json");
  const exists = fs.existsSync(p);
  it.skipIf(!exists)("every doctrine PLAY on the board is the ONLY place the model carries edge", () => {
    const b = JSON.parse(fs.readFileSync(p, "utf8")) as PublishedBoard;
    // Evaluate at the board's publish time so no week-1 game has kicked off.
    const out = buildNflModelFromBoard(b, "board-2026-wk01.json", Date.parse(b.publishedAt));
    const plays = b.legs.filter((l) => l.role === "play" && l.market === "moneyline");
    const modelPlays = out.data.results.filter((r) => r.verdict === "PLAY");
    expect(modelPlays.length).toBe(plays.length);
    // Real (non-control) moneyline legs all map — no team-name join failures.
    const real = b.legs.filter((l) => l.market === "moneyline" && l.role !== "control");
    expect(out.recordCount).toBe(real.length);
    expect(out.errors).toEqual([]);
    // A PASS game's probability equals its own market fair value (edge 0).
    for (const r of out.data.results.filter((x) => x.verdict === "PASS")) {
      const src = real.find((l) => l.priceProvenance?.oddsApiEventId === r.eventId)!;
      const fairSide = devigTwoWay(src.entryPriceAmerican!, src.entryOtherSideAmerican!).byMethod.power;
      const modelSide = src.side === "home" ? r.homeWinProb : r.awayWinProb;
      expect(Math.abs(modelSide - fairSide)).toBeLessThan(1e-3);
    }
  });
});
