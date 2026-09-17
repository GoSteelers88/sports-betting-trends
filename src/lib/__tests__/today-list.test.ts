import { describe, it, expect } from "vitest";
import {
  LIVE_WINDOW_MS,
  buildTodayRows,
  etDateKey,
  fmtAgeHours,
  fmtEtDayTime,
  isLiveAgentPick,
  latestBoardFile,
  nextBoardLine,
  rowState,
  runIsStale,
  slateFreshness,
  type AgentPickLike,
  type NflLiveLeg,
} from "../today-list";

// Sat 2026-09-12 22:45Z = 6:45 PM EDT. The launch-day clock.
const NOW = Date.parse("2026-09-12T22:45:00Z");
const H = 3_600_000;

function pick(over: Partial<AgentPickLike> & { id: number }): AgentPickLike {
  return { edge: 0.07, gameDate: null, outcome: null, ...over };
}

function leg(over: Partial<NflLiveLeg> & { legId: string; kickoffUtc: string }): NflLiveLeg {
  return {
    season: 2026,
    week: 1,
    publishedAt: "2026-09-08T14:09:00.447Z",
    matchup: "NYJ @ TEN",
    awayAbbr: "NYJ",
    homeAbbr: "TEN",
    selectedAbbr: "NYJ",
    opponentAbbr: "TEN",
    selectedIsAway: true,
    modelPct: 63.3,
    marketPct: 46.5,
    gapPp: 16.8,
    entryPriceAmerican: 106,
    book: "fanduel",
    snapshotFetchedAt: "2026-09-08T14:09:00.443Z",
    clvEligible: true,
    ...over,
  };
}

describe("isLiveAgentPick", () => {
  it("drops graded picks, keeps ungraded picks inside the 4h window, keeps null-dated picks", () => {
    expect(isLiveAgentPick(pick({ id: 1, outcome: { result: "win" } }), NOW)).toBe(false);
    expect(isLiveAgentPick(pick({ id: 2, gameDate: new Date(NOW - 3 * H).toISOString() }), NOW)).toBe(true);
    expect(isLiveAgentPick(pick({ id: 3, gameDate: new Date(NOW - 5 * H).toISOString() }), NOW)).toBe(false);
    expect(isLiveAgentPick(pick({ id: 4, gameDate: null }), NOW)).toBe(true);
    expect(isLiveAgentPick(pick({ id: 5, gameDate: "not a date" }), NOW)).toBe(true);
  });
});

describe("rowState", () => {
  it("is upcoming before start, in play after, pending with no time", () => {
    expect(rowState(NOW + 1, NOW)).toBe("upcoming");
    expect(rowState(NOW, NOW)).toBe("in play");
    expect(rowState(NOW - H, NOW)).toBe("in play");
    expect(rowState(null, NOW)).toBe("pending");
  });
});

describe("buildTodayRows", () => {
  it("orders by start time across kinds, then puts undated rows last by edge desc", () => {
    const games = [
      pick({ id: 10, gameDate: new Date(NOW + 2 * H).toISOString(), edge: 0.06 }),
      pick({ id: 11, gameDate: null, edge: 0.08 }),
      pick({ id: 12, gameDate: null, edge: 0.12 }),
    ];
    const props = [pick({ id: 20, gameDate: new Date(NOW - H).toISOString(), edge: 0.09 })];
    const legs = [
      leg({ legId: "a", kickoffUtc: new Date(NOW + 18 * H).toISOString() }),
      leg({ legId: "b", kickoffUtc: new Date(NOW + H).toISOString(), matchup: "GB @ MIN" }),
    ];
    const rows = buildTodayRows(games, props, legs, NOW);
    expect(rows.map((r) => (r.kind === "nfl" ? `nfl:${r.leg.legId}` : `${r.kind}:${r.pick.id}`))).toEqual([
      "prop:20", // in play, started 1h ago
      "nfl:b", // +1h
      "game:10", // +2h
      "nfl:a", // +18h
      "game:12", // undated, edge 0.12
      "game:11", // undated, edge 0.08
    ]);
    expect(rows[0].state).toBe("in play");
    expect(rows[1].state).toBe("upcoming");
    expect(rows[4].state).toBe("pending");
  });

  it("excludes NFL legs whose kickoff is more than 4h gone, and graded agent picks", () => {
    const legs = [
      leg({ legId: "gone", kickoffUtc: new Date(NOW - LIVE_WINDOW_MS - 1).toISOString() }),
      leg({ legId: "edge", kickoffUtc: new Date(NOW - LIVE_WINDOW_MS + 60_000).toISOString() }),
    ];
    const games = [pick({ id: 1, outcome: { result: "loss", unitsPnl: -0.5 } })];
    const rows = buildTodayRows(games, [], legs, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("nfl");
    expect(rows[0].kind === "nfl" && rows[0].leg.legId).toBe("edge");
    expect(rows[0].state).toBe("in play");
  });

  it("returns an empty list on the Tuesday gap: all legs past, nothing from the agent", () => {
    const legs = [leg({ legId: "sun", kickoffUtc: "2026-09-13T17:00:00Z" })];
    expect(buildTodayRows([], [], legs, Date.parse("2026-09-15T15:00:00Z"))).toEqual([]);
  });

  // Launch day, real data shape: 0 agent picks, the two week-1 PLAY legs.
  it("launch day is a two-row list, both upcoming, NYJ first", () => {
    const legs = [
      leg({ legId: "1c8e87c2fc2c7d7d", kickoffUtc: "2026-09-13T20:25:00Z", matchup: "GB @ MIN", selectedAbbr: "GB", opponentAbbr: "MIN" }),
      leg({ legId: "24c69b3f3edbb4b5", kickoffUtc: "2026-09-13T17:00:00Z" }),
    ];
    const rows = buildTodayRows([], [], legs, NOW);
    expect(rows.map((r) => r.kind)).toEqual(["nfl", "nfl"]);
    expect(rows[0].kind === "nfl" && rows[0].leg.selectedAbbr).toBe("NYJ");
    expect(rows.every((r) => r.state === "upcoming")).toBe(true);
  });
});

describe("latestBoardFile", () => {
  it("picks the highest week within a season and the highest season across", () => {
    expect(latestBoardFile(["board-2026-wk01.json", "board-2026-wk02.json"])).toBe("board-2026-wk02.json");
    expect(latestBoardFile(["board-2026-wk02.json", "board-2026-wk01.json"])).toBe("board-2026-wk02.json");
    expect(latestBoardFile(["board-2026-wk01.json", "board-2025-wk18.json"])).toBe("board-2026-wk01.json");
    expect(latestBoardFile(["board-2026-wk09.json", "board-2026-wk10.json"])).toBe("board-2026-wk10.json");
  });

  it("ignores files that are not boards, and returns null with none", () => {
    expect(latestBoardFile(["ledger.json", "closes", "snapshots", "board-2026-wk1.json"])).toBeNull();
    expect(latestBoardFile([])).toBeNull();
    expect(latestBoardFile(["ledger.json", "board-2026-wk01.json"])).toBe("board-2026-wk01.json");
  });
});

describe("etDateKey", () => {
  it("rolls the day at midnight in New York, not UTC", () => {
    expect(etDateKey(Date.parse("2026-09-13T03:59:00Z"))).toBe("2026-09-12"); // 11:59 PM EDT
    expect(etDateKey(Date.parse("2026-09-13T04:00:00Z"))).toBe("2026-09-13"); // 12:00 AM EDT
    expect(etDateKey(NOW)).toBe("2026-09-12");
  });
});

describe("slateFreshness", () => {
  const todayGame = "2026-09-13T01:05:00Z"; // Sat 9:05 PM EDT — today
  const lastNightGame = "2026-09-12T02:10:00Z"; // Fri 10:10 PM EDT — yesterday

  it("is fresh when the snapshot is recent and carries a game today", () => {
    const f = slateFreshness({ fetchedAt: new Date(NOW - 2 * H).toISOString(), commenceTimes: [lastNightGame, todayGame] }, NOW);
    expect(f.stale).toBe(false);
    expect(f.reason).toBeNull();
    expect(f.gamesToday).toBe(1);
    expect(f.ageHours).toBeCloseTo(2, 1);
  });

  // The committed launch-day file: fetchedAt 2026-09-09T00:35Z, Sept 8–9 slate.
  it("flags the committed Sept 9 snapshot as old on Sept 12", () => {
    const f = slateFreshness(
      { fetchedAt: "2026-09-09T00:35:08.018Z", commenceTimes: ["2026-09-09T00:41:00Z", "2026-09-09T23:05:00Z"] },
      NOW,
    );
    expect(f.stale).toBe(true);
    expect(f.reason).toBe("old");
    expect(f.fetchedAt).toBe("2026-09-09T00:35:08.018Z");
    expect(f.ageHours).toBeGreaterThan(36);
  });

  it("flags a recent snapshot with no game dated today (ET)", () => {
    const f = slateFreshness({ fetchedAt: new Date(NOW - H).toISOString(), commenceTimes: [lastNightGame] }, NOW);
    expect(f.stale).toBe(true);
    expect(f.reason).toBe("no-game-today");
    expect(f.gamesToday).toBe(0);
  });

  it("treats a missing or unparseable timestamp as stale, never fresh", () => {
    expect(slateFreshness({ fetchedAt: null, commenceTimes: [todayGame] }, NOW).reason).toBe("no-snapshot");
    expect(slateFreshness({ fetchedAt: "yesterday", commenceTimes: [todayGame] }, NOW).stale).toBe(true);
    expect(slateFreshness({ fetchedAt: "", commenceTimes: [todayGame] }, NOW).stale).toBe(true);
  });

  it("sits exactly on the 36h boundary as fresh, and one second past as old", () => {
    const at = new Date(NOW - 36 * H).toISOString();
    expect(slateFreshness({ fetchedAt: at, commenceTimes: [todayGame] }, NOW).reason).toBeNull();
    const past = new Date(NOW - 36 * H - 60_000).toISOString();
    expect(slateFreshness({ fetchedAt: past, commenceTimes: [todayGame] }, NOW).reason).toBe("old");
  });
});

describe("fmtAgeHours / fmtEtDayTime / runIsStale", () => {
  it("prints ages in the largest honest unit", () => {
    expect(fmtAgeHours(94.2)).toBe("3 days");
    expect(fmtAgeHours(30)).toBe("1 day");
    expect(fmtAgeHours(5.5)).toBe("5 hours");
    expect(fmtAgeHours(1.2)).toBe("1 hour");
    expect(fmtAgeHours(0.5)).toBe("30 minutes");
  });

  it("prints an instant in ET and says so", () => {
    // 2026-09-09T00:35Z is Tuesday Sept 8, 8:35 PM in New York (EDT).
    expect(fmtEtDayTime("2026-09-09T00:35:08.018Z")).toBe("Tue, Sep 8, 8:35 PM ET");
    expect(fmtEtDayTime("2026-09-18T00:15:00Z")).toBe("Thu, Sep 17, 8:15 PM ET");
    expect(fmtEtDayTime("garbage")).toBe("—");
  });

  it("holds a run older than 26h, or a missing one", () => {
    expect(runIsStale(new Date(NOW - 3 * H).toISOString(), NOW)).toBe(false);
    expect(runIsStale(new Date(NOW - 27 * H).toISOString(), NOW)).toBe(true);
    expect(runIsStale(null, NOW)).toBe(true);
  });
});

describe("nextBoardLine", () => {
  const board = { season: 2026, week: 1, lastKickoffUtc: "2026-09-15T00:15:00Z" };
  const week1Slate = [
    "2026-09-10T00:20:00Z",
    "2026-09-13T17:00:00Z",
    "2026-09-13T20:25:00Z",
    "2026-09-14T00:20:00Z",
    "2026-09-15T00:15:00Z",
  ];

  it("names the next week's first kickoff when the slate already carries it", () => {
    const line = nextBoardLine({ latestBoard: board, slateKickoffs: [...week1Slate, "2026-09-18T00:15:00Z"] }, NOW);
    expect(line).toBe("NFL week 2 board publishes at least 12h before Thu, Sep 17, 8:15 PM ET");
  });

  it("never names a kickoff from the current board's week (launch-day slate)", () => {
    const line = nextBoardLine({ latestBoard: board, slateKickoffs: week1Slate }, NOW);
    expect(line).not.toContain("Sep 13");
    expect(line).toContain("week 2");
    expect(line).toContain("has not rolled");
  });

  it("falls back to the week-1 copy when no board was ever published", () => {
    expect(nextBoardLine({ latestBoard: null, slateKickoffs: week1Slate }, NOW)).toBe(
      "NFL week 1 board publishes at least 12h before the Thursday kickoff",
    );
  });

  it("ignores unparseable kickoffs", () => {
    const line = nextBoardLine({ latestBoard: board, slateKickoffs: ["soon", ""] }, NOW);
    expect(line).toContain("has not rolled");
  });
});
