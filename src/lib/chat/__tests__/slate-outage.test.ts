// MUST 2 — A DATA OUTAGE IS NOT A QUIET DAY.
//
// `getOdds` never throws for a missing, malformed or stale snapshot: the loader
// returns the fallback `{events: []}` with status "missing" (tools/index.ts:81)
// or the old rows with status "stale" (:104), and attaches a `dataWarning`
// string. Round 1 of buildTodaySlate read only `fetchedAt` and `events`, so an
// unreadable file produced `gameCount: 0` — indistinguishable from a genuinely
// dark league — and the note the schedule prompt tells the model to read aloud
// asserted "nothing on the board today, and no upcoming MLB game in the
// snapshot". On a 15-game Saturday.
//
// The invariant: the desk may say "nothing is on" only when it can SEE that
// nothing is on.

import { describe, it, expect, vi } from "vitest";
import { buildTodaySlate } from "../slate";

const NOW = new Date("2026-09-12T23:00:00.000Z"); // 7:00 PM ET, Saturday

const MISSING = {
  fetchedAt: null,
  events: [],
  dataWarning:
    "DATA ERROR: latest-odds-api-baseball_mlb.json is missing. Numbers may not reflect the current slate.",
};

// A real file, but every row is Wednesday's.
const STALE = {
  fetchedAt: "2026-09-09T22:43:46.264Z",
  events: [
    {
      eventId: "x",
      commenceTime: "2026-09-09T23:16:00.000Z",
      homeTeam: "Atlanta Braves",
      awayTeam: "Philadelphia Phillies",
      consensus: { home: null, away: null, spread: null, total: null },
      bestPrice: { home: null, away: null },
      bookSpread: { home: null, away: null },
      bookCount: 1,
    },
  ],
  dataWarning:
    "DATA WARNING: latest-odds-api-baseball_mlb.json is 72.3h old (stale > 6h). Numbers may not reflect the current slate.",
};

const EMPTY_OK = { fetchedAt: "2026-09-12T22:43:46.264Z", events: [] };

function slateWith(mlb: unknown) {
  return buildTodaySlate({
    now: NOW,
    odds: ((lg: string) => (lg === "MLB" ? mlb : EMPTY_OK)) as never,
  });
}

describe("a MISSING odds file is never reported as a dark league", () => {
  it("REGRESSION: the MLB note must NOT say 'nothing on the board today'", () => {
    const mlb = slateWith(MISSING).leagues.find((l) => l.league === "MLB")!;
    expect(mlb.note).not.toContain("nothing on the board today");
    expect(mlb.note).not.toContain("nothing today");
  });

  it("the note says the desk cannot SEE the board", () => {
    const mlb = slateWith(MISSING).leagues.find((l) => l.league === "MLB")!;
    expect(mlb.note).toMatch(/can'?t see|not readable|can't confirm/i);
  });

  it("the payload carries the warning so the model can state it", () => {
    const mlb = slateWith(MISSING).leagues.find((l) => l.league === "MLB")!;
    expect(mlb.feedStatus).toBe("warned");
    expect(mlb.feedWarning).toBeTruthy();
    // Desk voice — never the raw filename.
    expect(mlb.feedWarning).toContain("the MLB odds snapshot");
    expect(mlb.feedWarning).not.toContain(".json");
  });

  it("the TOP-LEVEL note never flatly claims an empty day when a feed is unreadable", () => {
    const slate = slateWith(MISSING);
    expect(slate.gameCount).toBe(0);
    expect(slate.note).not.toMatch(/^Nothing on the board anywhere today/);
    expect(slate.note).toMatch(/can'?t see|couldn'?t read|unreadable/i);
  });

  it("logs one per-turn warning so [chat/turn] can be correlated at 3am", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      slateWith(MISSING);
      const lines = warn.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.includes("chat/slate") && l.includes("MLB"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("a STALE odds file whose rows are all from a past day is not a dark league", () => {
  it("REGRESSION: does not print 'no upcoming MLB game in the snapshot' on a game day", () => {
    const mlb = slateWith(STALE).leagues.find((l) => l.league === "MLB")!;
    expect(mlb.gameCount).toBe(0);
    expect(mlb.note).not.toContain("no upcoming");
    expect(mlb.note).not.toContain("nothing today");
    expect(mlb.feedStatus).toBe("warned");
  });

  it("still reports when the lines were last refreshed", () => {
    const mlb = slateWith(STALE).leagues.find((l) => l.league === "MLB")!;
    expect(mlb.linesRefreshedEt).toBe("6:43 PM ET on September 9");
    expect(mlb.note).toContain("September 9");
  });
});

describe("a genuinely dark league is still reported as dark", () => {
  it("a healthy, empty feed keeps the honest 'nothing today' note", () => {
    const nba = slateWith(EMPTY_OK).leagues.find((l) => l.league === "NBA")!;
    expect(nba.feedStatus).toBe("ok");
    expect(nba.feedWarning).toBeNull();
    expect(nba.note).toContain("nothing");
  });

  it("a healthy feed WITH games today is unaffected", () => {
    const slate = buildTodaySlate({
      now: NOW,
      odds: (() => ({
        fetchedAt: "2026-09-12T22:43:46.264Z",
        events: [
          {
            eventId: "x",
            commenceTime: "2026-09-12T23:16:00.000Z",
            homeTeam: "Atlanta Braves",
            awayTeam: "Philadelphia Phillies",
            consensus: {
              home: { american: -134, impliedProb: 0.57 },
              away: { american: 116, impliedProb: 0.46 },
              spread: null,
              total: null,
            },
            bestPrice: { home: null, away: null },
            bookSpread: { home: null, away: null },
            bookCount: 1,
          },
        ],
      })) as never,
    });
    const mlb = slate.leagues.find((l) => l.league === "MLB")!;
    expect(mlb.gameCount).toBe(1);
    expect(mlb.feedStatus).toBe("ok");
    expect(mlb.note).toContain("1 game on the board today");
  });

  it("a league WITH games today but a stale feed still lists them, flagged", () => {
    const slate = buildTodaySlate({
      now: NOW,
      odds: (() => ({
        ...STALE,
        events: [
          { ...STALE.events[0]!, commenceTime: "2026-09-12T23:16:00.000Z" },
        ],
      })) as never,
    });
    const mlb = slate.leagues.find((l) => l.league === "MLB")!;
    expect(mlb.gameCount).toBe(1);
    expect(mlb.feedStatus).toBe("warned");
    expect(mlb.note).toContain("1 game on the board today");
    expect(mlb.note).toContain("72.3 hours");
  });
});

// ─── SHOULD 4 — the slate read takes a DAY ───────────────────────────────────

import { resolveSlateDay } from "../slate";

const SUNDAY_BOARD = {
  fetchedAt: "2026-09-12T22:43:46.264Z",
  events: [
    {
      eventId: "sat",
      commenceTime: "2026-09-12T23:16:00.000Z", // Sat 7:16 PM ET
      homeTeam: "Atlanta Braves",
      awayTeam: "Philadelphia Phillies",
      consensus: {
        home: { american: -134, impliedProb: 0.57 },
        away: { american: 116, impliedProb: 0.46 },
        spread: null,
        total: null,
      },
      bestPrice: { home: null, away: null },
      bookSpread: { home: null, away: null },
      bookCount: 1,
    },
    {
      eventId: "sun",
      commenceTime: "2026-09-13T17:36:00.000Z", // Sun 1:36 PM ET
      homeTeam: "New York Yankees",
      awayTeam: "New York Mets",
      consensus: {
        home: { american: -184, impliedProb: 0.65 },
        away: { american: 154, impliedProb: 0.39 },
        spread: null,
        total: null,
      },
      bestPrice: { home: null, away: null },
      bookSpread: { home: null, away: null },
      bookCount: 1,
    },
  ],
};

describe("resolveSlateDay", () => {
  it("defaults to today", () => {
    expect(resolveSlateDay(NOW, undefined)).toMatchObject({
      dayKeyEt: "2026-09-12",
      offsetDays: 0,
      label: "today",
    });
  });

  it("resolves tomorrow", () => {
    expect(resolveSlateDay(NOW, "tomorrow")).toMatchObject({
      dayKeyEt: "2026-09-13",
      offsetDays: 1,
      label: "tomorrow",
    });
  });

  it("resolves a weekday to its NEXT occurrence (today counts as itself)", () => {
    // NOW is a Saturday.
    expect(resolveSlateDay(NOW, "Sunday").dayKeyEt).toBe("2026-09-13");
    expect(resolveSlateDay(NOW, "sunday").offsetDays).toBe(1);
    expect(resolveSlateDay(NOW, "Saturday").offsetDays).toBe(0);
    expect(resolveSlateDay(NOW, "Friday").offsetDays).toBe(6);
    expect(resolveSlateDay(NOW, "on Tuesday").offsetDays).toBe(3);
  });

  it("an UNRECOGNISED day word degrades to today, never to a guessed date", () => {
    for (const junk of ["", "   ", "whenever", "the 14th", "next month", "xyz"]) {
      expect(resolveSlateDay(NOW, junk).offsetDays).toBe(0);
    }
  });

  it("resolves against the ET day, not UTC", () => {
    // 2026-09-13T02:00Z is 10 PM ET on Saturday the 12th.
    const lateSat = new Date("2026-09-13T02:00:00.000Z");
    expect(resolveSlateDay(lateSat, "today").dayKeyEt).toBe("2026-09-12");
    expect(resolveSlateDay(lateSat, "tomorrow").dayKeyEt).toBe("2026-09-13");
  });
});

describe("REGRESSION — a tomorrow question reads tomorrow's rows, not a denial", () => {
  // MEASURED 2026-09-12 21:23 ET: the desk said Sunday's board "isn't live yet"
  // while the MLB snapshot held 9 rows dated 2026-09-13 ET.
  it("day:'tomorrow' returns the Sunday game and NOT Saturday's", () => {
    const slate = buildTodaySlate({
      now: NOW,
      day: "tomorrow",
      odds: ((lg: string) => (lg === "MLB" ? SUNDAY_BOARD : EMPTY_OK)) as never,
    });
    const mlb = slate.leagues.find((l) => l.league === "MLB")!;
    expect(mlb.gameCount).toBe(1);
    expect(mlb.games[0]!.matchup).toBe("New York Mets @ New York Yankees");
    expect(mlb.games[0]!.startEt).toBe("1:36 PM ET");
    expect(mlb.games[0]!.homeMoneylineAmerican).toBe(-184);
  });

  it("echoes back the day it actually read, so the reply can name it", () => {
    const slate = buildTodaySlate({
      now: NOW,
      day: "Sunday",
      odds: ((lg: string) => (lg === "MLB" ? SUNDAY_BOARD : EMPTY_OK)) as never,
    });
    expect(slate.requestedDay).toBe("tomorrow");
    expect(slate.isToday).toBe(false);
    expect(slate.dateEt).toBe("Sunday, September 13, 2026");
    expect(slate.dayKeyEt).toBe("2026-09-13");
    // nowEt stays the real clock.
    expect(slate.nowEt).toBe("7:00 PM ET");
  });

  it("today is unchanged and still returns Saturday's game", () => {
    const slate = buildTodaySlate({
      now: NOW,
      odds: ((lg: string) => (lg === "MLB" ? SUNDAY_BOARD : EMPTY_OK)) as never,
    });
    const mlb = slate.leagues.find((l) => l.league === "MLB")!;
    expect(slate.isToday).toBe(true);
    expect(mlb.gameCount).toBe(1);
    expect(mlb.games[0]!.matchup).toBe("Philadelphia Phillies @ Atlanta Braves");
  });

  it("a future day with nothing on it says so for THAT day, not for today", () => {
    const slate = buildTodaySlate({
      now: NOW,
      day: "Friday",
      odds: ((lg: string) => (lg === "MLB" ? SUNDAY_BOARD : EMPTY_OK)) as never,
    });
    const mlb = slate.leagues.find((l) => l.league === "MLB")!;
    expect(mlb.gameCount).toBe(0);
    expect(mlb.note).toContain("Friday");
    expect(mlb.note).not.toContain("nothing today");
  });
});
