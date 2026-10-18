// The basketball model prices a game only when both teams have the minimum
// counted games, the ratings are current, and the game is inside the horizon.
// The negative control is the real 2026-10-17 shape: preseason-only ratings
// with 4–5 games per team, which produced Spurs 82% over OKC.

import { describe, it, expect } from "vitest";
import { buildBasketballModel, MIN_GAMES_FOR_RATING, type EfficiencyFile, type GameInput } from "../basketball-model";

const NOW = new Date("2026-10-28T15:00:00Z");

function eff(teams: EfficiencyFile["teams"], over: Partial<EfficiencyFile> = {}): EfficiencyFile {
  return {
    fetchedAt: "2026-10-28T14:00:00Z",
    season: "2026-27",
    source: "espn-scoreboard-empirical",
    lookbackDays: 40,
    teams,
    ...over,
  };
}

const rated = (netRtg: number, gamesPlayed = 8) => ({ netRtg, homeNetRtg: netRtg, awayNetRtg: netRtg, gamesPlayed });

const spursThunder: GameInput = {
  eventId: "fd_35928229",
  homeTeam: "San Antonio Spurs",
  awayTeam: "Oklahoma City Thunder",
  startTime: "2026-10-29T01:30:00Z",
};

describe("buildBasketballModel", () => {
  it("prices a game when both teams clear the minimum (formula unchanged)", () => {
    const out = buildBasketballModel({
      source: "test",
      games: [spursThunder],
      efficiency: eff({ "San Antonio Spurs": rated(4), "Oklahoma City Thunder": rated(6) }),
      now: NOW,
    });
    expect(out.status).toBe("ok");
    expect(out.recordCount).toBe(1);
    // margin = (4 − 6) × 0.45 + 1.5 = 0.6; p = logistic(0.6 × 0.105)
    expect(out.data.results[0].expectedMargin).toBe(0.6);
    expect(out.data.results[0].homeWinProb).toBeCloseTo(1 / (1 + Math.exp(-0.063)), 4);
    expect(out.note).toBeUndefined();
  });

  it("NEGATIVE CONTROL: the 10-17 preseason file (4–5 games/team, no belowMinimum) prices nothing", () => {
    const out = buildBasketballModel({
      source: "test",
      games: [spursThunder],
      efficiency: eff({
        "San Antonio Spurs": { netRtg: 5.6, homeNetRtg: 14, awayNetRtg: -7, gamesPlayed: 4 },
        "Oklahoma City Thunder": { netRtg: -4, homeNetRtg: 7, awayNetRtg: -15, gamesPlayed: 4 },
      }),
      now: NOW,
    });
    expect(MIN_GAMES_FOR_RATING).toBe(5);
    expect(out.recordCount).toBe(0);
    expect(out.status).toBe("insufficient-sample");
    expect(out.errors[0]).toMatch(/San Antonio Spurs has 4 counted games \(needs 5\)/);
    expect(out.note).toMatch(/teams need 5/);
  });

  it("names the team that is short, using belowMinimum from the new ingest", () => {
    const out = buildBasketballModel({
      source: "test",
      games: [spursThunder],
      efficiency: eff({ "San Antonio Spurs": rated(4) }, { belowMinimum: { "Oklahoma City Thunder": 3 } }),
      now: NOW,
    });
    expect(out.status).toBe("insufficient-sample");
    expect(out.errors[0]).toMatch(/Oklahoma City Thunder has 3 counted games/);
  });

  it("an empty ratings file (preseason / offseason) is insufficient-sample, not no-data", () => {
    const out = buildBasketballModel({ source: "test", games: [spursThunder], efficiency: eff({}), now: NOW });
    expect(out.status).toBe("insufficient-sample");
    expect(out.recordCount).toBe(0);
  });

  it("refuses a stale ratings file (the July file read on 09-29)", () => {
    const out = buildBasketballModel({
      source: "test",
      games: [spursThunder],
      efficiency: eff(
        { "San Antonio Spurs": rated(-4), "Oklahoma City Thunder": rated(4) },
        { fetchedAt: "2026-07-23T23:34:56Z" },
      ),
      now: NOW,
    });
    expect(out.status).toBe("no-data");
    expect(out.recordCount).toBe(0);
    expect(out.note).toMatch(/h old \(limit 36h\)/);
  });

  it("skips games past the 10-day horizon (pick #134 was 87 days out)", () => {
    const christmas: GameInput = {
      eventId: "bv_xmas",
      homeTeam: "New York Knicks",
      awayTeam: "San Antonio Spurs",
      startTime: "2026-12-25T17:00:00Z",
    };
    const out = buildBasketballModel({
      source: "test",
      games: [spursThunder, christmas],
      efficiency: eff({
        "San Antonio Spurs": rated(4),
        "Oklahoma City Thunder": rated(6),
        "New York Knicks": rated(5),
      }),
      now: NOW,
    });
    expect(out.status).toBe("ok");
    expect(out.data.results.map(r => r.eventId)).toEqual(["fd_35928229"]);
    expect(out.errors[0]).toMatch(/starts in 58 days \(model horizon is 10\)/);
  });

  it("a name that matches nothing in a populated file is no-data (worth re-ingesting), not insufficient-sample", () => {
    const out = buildBasketballModel({
      source: "test",
      games: [{ ...spursThunder, homeTeam: "Seattle SuperSonics" }],
      efficiency: eff({ "San Antonio Spurs": rated(4), "Oklahoma City Thunder": rated(6) }),
      now: NOW,
    });
    expect(out.status).toBe("no-data");
  });
});
