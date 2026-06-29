// Tests for the explicit MLB-franchise allowlist + slate filter.
//
// The baseball_mlb odds endpoint (FanDuel/Bovada) is polluted with non-MLB
// baseball: NPB (Japan), KBO (Korea), CPBL (Taiwan), and NCAA college baseball
// all come back under the same sportKey. isMlbTeam / mlbSlateEvents scope the
// feed to the 30 real MLB franchises so the prop board (and every downstream
// consumer) sees only tonight's actual MLB games — not by the lucky accident
// that foreign/college players aren't in the gamelog.

import { describe, it, expect } from "vitest";
import { MLB_TEAMS, isMlbTeam, mlbSlateEvents, easternDateOf, easternToday } from "../injuries-scope";

describe("MLB_TEAMS", () => {
  it("has exactly the 30 current franchises", () => {
    expect(MLB_TEAMS).toHaveLength(30);
    expect(new Set(MLB_TEAMS).size).toBe(30);
  });
});

describe("isMlbTeam", () => {
  it("is true for real MLB franchises (various naming)", () => {
    expect(isMlbTeam("New York Yankees")).toBe(true);
    expect(isMlbTeam("St. Louis Cardinals")).toBe(true);
    expect(isMlbTeam("St Louis Cardinals")).toBe(true); // no period
    // "Athletics" carries no city in current branding.
    expect(isMlbTeam("Athletics")).toBe(true);
    expect(isMlbTeam("Oakland Athletics")).toBe(true); // legacy alias
  });

  it("is case- and punctuation-insensitive", () => {
    expect(isMlbTeam("new york yankees")).toBe(true);
    expect(isMlbTeam("CHICAGO WHITE SOX")).toBe(true);
  });

  it("keeps the two same-city franchises distinct (real teams, not collisions)", () => {
    expect(isMlbTeam("Chicago Cubs")).toBe(true);
    expect(isMlbTeam("Chicago White Sox")).toBe(true);
    expect(isMlbTeam("New York Mets")).toBe(true);
    expect(isMlbTeam("Los Angeles Angels")).toBe(true);
    expect(isMlbTeam("Los Angeles Dodgers")).toBe(true);
  });

  it("is false for KBO / NPB / CPBL clubs", () => {
    expect(isMlbTeam("LG Twins")).toBe(false); // KBO (vs MLB Minnesota Twins)
    expect(isMlbTeam("Tohoku Rakuten Golden Eagles")).toBe(false); // NPB
    expect(isMlbTeam("CTBC Brothers")).toBe(false); // CPBL
    expect(isMlbTeam("KT Wiz")).toBe(false); // KBO
  });

  it("is false for NCAA college baseball", () => {
    expect(isMlbTeam("Ole Miss Rebels")).toBe(false);
    expect(isMlbTeam("North Carolina Tar Heels")).toBe(false);
    expect(isMlbTeam("Troy Trojans")).toBe(false);
  });

  it("is false for empty / undefined input (never throws)", () => {
    expect(isMlbTeam("")).toBe(false);
    expect(isMlbTeam(undefined as unknown as string)).toBe(false);
    expect(isMlbTeam("   ")).toBe(false);
  });
});

describe("mlbSlateEvents", () => {
  const mixedFeed = [
    {
      home_team: "Boston Red Sox",
      away_team: "New York Yankees",
      commence_time: "2026-06-14T23:10:00Z",
    },
    {
      home_team: "KT Wiz",
      away_team: "LG Twins",
      commence_time: "2026-06-14T09:30:00Z",
    },
    {
      home_team: "Troy Trojans",
      away_team: "Ole Miss Rebels",
      commence_time: "2026-06-14T18:00:00Z",
    },
  ];

  it("keeps only events where BOTH teams are MLB", () => {
    const out = mlbSlateEvents(mixedFeed);
    expect(out).toHaveLength(1);
    expect(out[0].home_team).toBe("Boston Red Sox");
    expect(out[0].away_team).toBe("New York Yankees");
  });

  it("drops an event with one MLB + one non-MLB team", () => {
    const feed = [
      // MLB home, NPB away — must be dropped (both sides must be MLB).
      {
        home_team: "Los Angeles Dodgers",
        away_team: "Tohoku Rakuten Golden Eagles",
        commence_time: "2026-06-14T20:00:00Z",
      },
    ];
    expect(mlbSlateEvents(feed)).toEqual([]);
  });

  it("date-scopes when onDateUtc is supplied", () => {
    const out = mlbSlateEvents(mixedFeed, { onDateUtc: "2026-06-14" });
    expect(out).toHaveLength(1); // the Red Sox/Yankees game is on that UTC date
  });

  it("drops an MLB event on a different UTC date", () => {
    const feed = [
      {
        home_team: "Boston Red Sox",
        away_team: "New York Yankees",
        commence_time: "2026-06-15T01:00:00Z", // June 15 UTC
      },
    ];
    expect(mlbSlateEvents(feed, { onDateUtc: "2026-06-14" })).toEqual([]);
    // ...but kept when no date filter is requested.
    expect(mlbSlateEvents(feed)).toHaveLength(1);
  });

  it("onDateEt scopes by US-Eastern game-date, not UTC (correct MLB game day)", () => {
    // A 02:00Z game on June 15 is actually June 14 ~10pm ET — a late West-coast
    // game that belongs to the June 14 slate. UTC-date would wrongly drop it.
    const lateGame = [
      { home_team: "Los Angeles Dodgers", away_team: "San Francisco Giants", commence_time: "2026-06-15T02:00:00Z" },
    ];
    expect(mlbSlateEvents(lateGame, { onDateEt: "2026-06-14" })).toHaveLength(1); // kept — it's a June 14 ET game
    expect(mlbSlateEvents(lateGame, { onDateUtc: "2026-06-14" })).toEqual([]); // UTC would wrongly drop it
  });

  it("onDateEt drops a genuine next-day game (no tomorrow's team showing as tonight)", () => {
    const feed = [
      { home_team: "Boston Red Sox", away_team: "New York Yankees", commence_time: "2026-06-14T17:30:00Z" }, // today ET
      { home_team: "Texas Rangers", away_team: "Houston Astros", commence_time: "2026-06-16T00:05:00Z" }, // June 15 ET (8:05pm)
    ];
    const out = mlbSlateEvents(feed, { onDateEt: "2026-06-14" });
    expect(out).toHaveLength(1);
    expect(out[0].home_team).toBe("Boston Red Sox");
  });

  it("easternDateOf + easternToday return YYYY-MM-DD strings", () => {
    expect(easternDateOf("2026-06-15T02:00:00Z")).toBe("2026-06-14"); // 10pm ET prior day
    expect(easternDateOf("2026-06-14T17:30:00Z")).toBe("2026-06-14"); // 1:30pm ET
    expect(easternDateOf(undefined)).toBeNull();
    expect(easternToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("does not date-filter when onDateUtc is omitted (caller decides)", () => {
    const feed = [
      { home_team: "Athletics", away_team: "Seattle Mariners", commence_time: "2026-06-14T02:00:00Z" },
      { home_team: "Texas Rangers", away_team: "Houston Astros", commence_time: "2026-06-20T23:00:00Z" },
    ];
    expect(mlbSlateEvents(feed)).toHaveLength(2);
  });

  it("returns [] for empty / garbage input (never throws)", () => {
    expect(mlbSlateEvents([])).toEqual([]);
    expect(mlbSlateEvents(undefined as unknown as [])).toEqual([]);
    expect(
      mlbSlateEvents([{ home_team: undefined, away_team: undefined }]),
    ).toEqual([]);
    expect(
      mlbSlateEvents([null as unknown as { home_team?: string }]),
    ).toEqual([]);
  });
});
