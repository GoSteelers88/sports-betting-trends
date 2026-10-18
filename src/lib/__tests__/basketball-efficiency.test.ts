// Ratings count only regular-season / play-in / playoff games, and a team is
// rated only after the minimum. Fixture shape mirrors ESPN's scoreboard event.

import { describe, it, expect } from "vitest";
import { buildTeamEfficiency, type EspnScoreboardEvent } from "../basketball-efficiency";
import { isCountableEspnEvent, nbaSeasonLabel } from "../espn-season";

let nextId = 1;
function game(
  home: string,
  away: string,
  hs: number,
  as: number,
  opts: { type?: number | null; year?: number; date?: string; completed?: boolean; id?: string } = {},
): EspnScoreboardEvent {
  return {
    id: opts.id ?? String(nextId++),
    date: opts.date ?? "2026-10-21T23:00Z",
    season: opts.type === null ? undefined : { type: opts.type ?? 2, year: opts.year ?? 2027 },
    competitions: [
      {
        status: { type: { completed: opts.completed ?? true } },
        competitors: [
          { homeAway: "home", score: String(hs), team: { displayName: home } },
          { homeAway: "away", score: String(as), team: { displayName: away } },
        ],
      },
    ],
  };
}

const isExhibition = (n: string) => /\b(stars|stripes|world)\b/i.test(n);
const build = (events: EspnScoreboardEvent[], minGames = 5) =>
  buildTeamEfficiency(events, { minGames, isExhibition });

describe("isCountableEspnEvent", () => {
  it("counts regular season, postseason and play-in; not preseason or off-season", () => {
    expect([1, 2, 3, 4, 5].map(type => isCountableEspnEvent({ season: { type } }))).toEqual([
      false, true, true, false, true,
    ]);
  });
  it("fails closed when the season type is missing", () => {
    expect(isCountableEspnEvent({})).toBe(false);
  });
});

describe("buildTeamEfficiency", () => {
  it("ignores preseason games entirely (the 2026-10-17 opener file was 67 of them)", () => {
    const events = Array.from({ length: 6 }, () => game("San Antonio Spurs", "Oklahoma City Thunder", 130, 100, { type: 1 }));
    const r = build(events);
    expect(r.teams).toEqual({});
    expect(r.belowMinimum).toEqual({});
    expect(r.gamesCounted).toBe(0);
    expect(r.gamesExcluded).toBe(6);
    expect(r.lastGameAt).toBeNull();
  });

  it("rates a team only once it has the minimum, and lists the rest", () => {
    const events = [
      ...Array.from({ length: 5 }, (_, i) => game("Boston Celtics", "Detroit Pistons", 110 + i, 100, { date: `2026-10-2${i}T23:00Z` })),
      game("Miami Heat", "Orlando Magic", 99, 101),
    ];
    const r = build(events);
    expect(Object.keys(r.teams).sort()).toEqual(["Boston Celtics", "Detroit Pistons"]);
    expect(r.belowMinimum).toEqual({ "Miami Heat": 1, "Orlando Magic": 1 });
    expect(r.teams["Boston Celtics"].gamesPlayed).toBe(5);
    expect(r.teams["Boston Celtics"].netRtg).toBe(12); // (10+11+12+13+14)/5
    expect(r.teams["Boston Celtics"].homeNetRtg).toBe(12);
    expect(r.teams["Detroit Pistons"].awayNetRtg).toBe(-12);
    expect(r.lastGameAt).toBe("2026-10-24T23:00Z");
    expect(r.seasonYear).toBe(2027);
    expect(nbaSeasonLabel(r.seasonYear!)).toBe("2026-27");
  });

  it("mixes preseason and regular season by counting only the regular season", () => {
    const events = [
      ...Array.from({ length: 4 }, () => game("New York Knicks", "Brooklyn Nets", 140, 90, { type: 1 })),
      ...Array.from({ length: 5 }, () => game("New York Knicks", "Brooklyn Nets", 100, 102)),
    ];
    const r = build(events);
    expect(r.teams["New York Knicks"].gamesPlayed).toBe(5);
    expect(r.teams["New York Knicks"].netRtg).toBe(-2);
    expect(r.gamesExcluded).toBe(4);
  });

  it("drops All-Star games (season type 2), incomplete games and repeated event ids", () => {
    const events = [
      game("Team Stripes", "Team Stars", 150, 140),
      game("Boston Celtics", "Detroit Pistons", 100, 90, { completed: false }),
      game("Boston Celtics", "Detroit Pistons", 100, 90, { id: "dup" }),
      game("Boston Celtics", "Detroit Pistons", 100, 90, { id: "dup" }),
    ];
    const r = build(events, 1);
    expect(r.gamesCounted).toBe(1);
    expect(r.teams["Boston Celtics"].gamesPlayed).toBe(1);
    expect(r.teams["Team Stripes"]).toBeUndefined();
  });

  it("does not count an untyped event", () => {
    const r = build([game("Boston Celtics", "Detroit Pistons", 100, 90, { type: null })], 1);
    expect(r.gamesCounted).toBe(0);
    expect(r.gamesExcluded).toBe(1);
  });
});
