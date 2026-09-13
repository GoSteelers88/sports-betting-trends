// TODAY'S SLATE — the deterministic schedule read.
//
// The bug these tests pin, measured live on 2026-09-12 (Saturday):
// `get_odds` returns every event in a league's snapshot regardless of date. The
// September NBA file held games on October 20 and December 25; the WNBA file
// held September 17–19. Nothing in the chat layer filtered by date, so the desk
// believed the NBA and WNBA were "on tonight", routed a schedule question to an
// empty NBA board, and shipped a matchup-shaped fallback to a calendar question.
//
// Fixtures only — no filesystem, no network, no real clock.

import { describe, it, expect } from "vitest";
import {
  buildTodaySlate,
  etDayKey,
  etClock,
  etShortDate,
  gamesTodayByLeague,
  parseIso,
} from "../slate";
import type { GameOdds } from "@/lib/agent/tools";

// 2026-09-12 19:00 ET = 23:00 UTC.
const NOW = new Date("2026-09-12T23:00:00.000Z");

function ev(
  partial: Partial<GameOdds> & { commenceTime: string; homeTeam: string; awayTeam: string }
): GameOdds {
  return {
    eventId: `${partial.awayTeam}@${partial.homeTeam}`,
    consensus: {
      home: partial.consensus?.home ?? null,
      away: partial.consensus?.away ?? null,
      spread: null,
      total: null,
    },
    bestPrice: { home: null, away: null },
    bookSpread: { home: null, away: null },
    bookCount: 1,
    ...partial,
  } as GameOdds;
}

// The real shapes, trimmed: MLB has today's slate plus tomorrow's; NBA's
// earliest snapshot game is more than a month out; WNBA's is next week; NFL is
// on tomorrow.
const FIXTURE: Record<string, { fetchedAt: string | null; events: GameOdds[] }> = {
  MLB: {
    fetchedAt: "2026-09-12T22:43:46.264Z",
    events: [
      ev({
        commenceTime: "2026-09-12T23:16:00.000Z", // 7:16 PM ET today
        awayTeam: "Philadelphia Phillies",
        homeTeam: "Atlanta Braves",
        consensus: {
          home: { american: -134, impliedProb: 0.57 },
          away: { american: 116, impliedProb: 0.46 },
          spread: null,
          total: null,
        },
      }),
      ev({
        commenceTime: "2026-09-12T20:06:00.000Z", // 4:06 PM ET today (started)
        awayTeam: "Los Angeles Angels",
        homeTeam: "Washington Nationals",
      }),
      ev({
        commenceTime: "2026-09-13T17:36:00.000Z", // tomorrow
        awayTeam: "New York Mets",
        homeTeam: "New York Yankees",
      }),
    ],
  },
  NFL: {
    fetchedAt: "2026-09-12T22:43:00.000Z",
    events: [
      ev({
        commenceTime: "2026-09-13T17:00:00.000Z", // Sunday
        awayTeam: "Baltimore Ravens",
        homeTeam: "Cleveland Browns",
      }),
    ],
  },
  NBA: {
    fetchedAt: "2026-09-12T22:43:25.339Z",
    events: [
      ev({
        commenceTime: "2026-10-20T19:00:00.000Z",
        awayTeam: "Boston Celtics",
        homeTeam: "Detroit Pistons",
      }),
      ev({
        commenceTime: "2026-12-25T17:00:00.000Z",
        awayTeam: "San Antonio Spurs",
        homeTeam: "New York Knicks",
      }),
    ],
  },
  WNBA: {
    fetchedAt: "2026-09-12T22:43:26.240Z",
    events: [
      ev({
        commenceTime: "2026-09-17T23:30:00.000Z",
        awayTeam: "Connecticut Sun",
        homeTeam: "Atlanta Dream",
      }),
    ],
  },
};

const deps = {
  odds: ((lg: string) => FIXTURE[lg] ?? { fetchedAt: null, events: [] }) as never,
  now: NOW,
};

describe("ET day/time helpers", () => {
  it("keys a UTC instant to its America/New_York calendar day", () => {
    // 2026-09-13T01:41Z is 9:41 PM ET on September 12 — still TODAY in ET.
    expect(etDayKey(new Date("2026-09-13T01:41:00.000Z"))).toBe("2026-09-12");
    // 2026-09-13T17:36Z is 1:36 PM ET on September 13 — tomorrow.
    expect(etDayKey(new Date("2026-09-13T17:36:00.000Z"))).toBe("2026-09-13");
  });

  it("formats a start time in ET with a plain ASCII space before AM/PM", () => {
    const t = etClock(new Date("2026-09-12T23:16:00.000Z"));
    expect(t).toBe("7:16 PM ET");
    // Intl can emit U+202F (narrow no-break space) before the meridiem. If that
    // leaks through, a model retyping the time produces a DIFFERENT string and
    // the reply stops matching the payload. Assert the ASCII space explicitly.
    expect(t).not.toMatch(/ | /);
  });

  it("etShortDate names the ET calendar day", () => {
    expect(etShortDate(new Date("2026-10-20T19:00:00.000Z"))).toBe("October 20");
  });

  it("parseIso rejects garbage instead of producing an Invalid Date", () => {
    expect(parseIso("not-a-date")).toBeNull();
    expect(parseIso(null)).toBeNull();
    expect(parseIso(undefined)).toBeNull();
    expect(parseIso("2026-09-12T23:16:00.000Z")?.toISOString()).toBe(
      "2026-09-12T23:16:00.000Z"
    );
  });
});

describe("buildTodaySlate — only games that START today (ET)", () => {
  it("includes today's MLB games and EXCLUDES tomorrow's", () => {
    const slate = buildTodaySlate(deps);
    const mlb = slate.leagues.find((l) => l.league === "MLB")!;
    expect(mlb.gameCount).toBe(2);
    expect(mlb.games.map((g) => g.matchup)).toEqual([
      "Los Angeles Angels @ Washington Nationals",
      "Philadelphia Phillies @ Atlanta Braves",
    ]);
    expect(mlb.games.every((g) => !g.matchup.includes("Mets"))).toBe(true);
  });

  it("sorts today's games by start time and carries the ET clock + moneylines", () => {
    const mlb = buildTodaySlate(deps).leagues.find((l) => l.league === "MLB")!;
    expect(mlb.games[0]!.startEt).toBe("4:06 PM ET");
    expect(mlb.games[1]!.startEt).toBe("7:16 PM ET");
    expect(mlb.games[1]!.homeMoneylineAmerican).toBe(-134);
    expect(mlb.games[1]!.awayMoneylineAmerican).toBe(116);
  });

  it("marks a game whose start has already passed as started", () => {
    const mlb = buildTodaySlate(deps).leagues.find((l) => l.league === "MLB")!;
    expect(mlb.games[0]!.started).toBe(true); // 4:06 PM ET, now is 7:00 PM ET
    expect(mlb.games[1]!.started).toBe(false); // 7:16 PM ET
  });

  it("REGRESSION: an October NBA game does NOT count as tonight's slate", () => {
    const nba = buildTodaySlate(deps).leagues.find((l) => l.league === "NBA")!;
    expect(nba.gameCount).toBe(0);
    expect(nba.games).toEqual([]);
    // …and the desk can say when the board actually opens.
    expect(nba.nextSlateDateEt).toBe("October 20");
    expect(nba.note).toContain("nothing today");
    expect(nba.note).toContain("October 20");
  });

  it("REGRESSION: next week's WNBA slate is not today's either", () => {
    const wnba = buildTodaySlate(deps).leagues.find((l) => l.league === "WNBA")!;
    expect(wnba.gameCount).toBe(0);
    expect(wnba.nextSlateDateEt).toBe("September 17");
  });

  it("reports the NFL schedule (dark today, on tomorrow) without issuing a read", () => {
    const nfl = buildTodaySlate(deps).leagues.find((l) => l.league === "NFL")!;
    expect(nfl.gameCount).toBe(0);
    expect(nfl.nextSlateDateEt).toBe("September 13");
  });

  it("states the refresh time per league and the date up top", () => {
    const slate = buildTodaySlate(deps);
    expect(slate.dateEt).toBe("Saturday, September 12, 2026");
    expect(slate.dayKeyEt).toBe("2026-09-12");
    expect(slate.gameCount).toBe(2);
    const mlb = slate.leagues.find((l) => l.league === "MLB")!;
    expect(mlb.linesRefreshedEt).toBe("6:43 PM ET on September 12");
    expect(mlb.note).toContain("6:43 PM ET");
  });

  it("the top-level note names the live leagues AND the dark ones", () => {
    const note = buildTodaySlate(deps).note;
    expect(note).toContain("MLB");
    expect(note).toContain("Dark today");
    expect(note).toContain("NBA");
    expect(note).toContain("WNBA");
  });

  it("an unreadable league feed degrades to a dark row, never a throw", () => {
    const slate = buildTodaySlate({
      now: NOW,
      odds: ((lg: string) => {
        if (lg === "NBA") throw new Error("boom");
        return FIXTURE[lg] ?? { fetchedAt: null, events: [] };
      }) as never,
    });
    const nba = slate.leagues.find((l) => l.league === "NBA")!;
    expect(nba.gameCount).toBe(0);
    expect(nba.note).toContain("not readable");
    // The rest of the board still reports.
    expect(slate.leagues.find((l) => l.league === "MLB")!.gameCount).toBe(2);
  });

  it("an undated row is DROPPED, never defaulted into today", () => {
    const slate = buildTodaySlate({
      now: NOW,
      odds: (() => ({
        fetchedAt: null,
        events: [
          ev({ commenceTime: "", awayTeam: "A", homeTeam: "B" }),
          ev({ commenceTime: "garbage", awayTeam: "C", homeTeam: "D" }),
        ],
      })) as never,
    });
    expect(slate.gameCount).toBe(0);
  });
});

describe("gamesTodayByLeague", () => {
  it("counts only today's games, per league", () => {
    const counts = gamesTodayByLeague(deps);
    expect(counts.get("MLB")).toBe(2);
    expect(counts.get("NBA")).toBe(0);
    expect(counts.get("WNBA")).toBe(0);
    expect(counts.get("NFL")).toBe(0);
  });
});
