// NBA/WNBA game-line picks must sit on a game the model priced. Fixtures use
// the real opening-week ids from the 2026-10-17 odds file.

import { describe, it, expect } from "vitest";
import { dropUnmodeledGameLines, type ModeledGame } from "../model-grounded";
import type { GradedPick } from "../grader";

function pick(over: Partial<GradedPick> = {}): GradedPick {
  return {
    matchup: "Oklahoma City Thunder @ San Antonio Spurs",
    market: "moneyline",
    selection: "San Antonio Spurs",
    oddsAmerican: -132,
    modelProb: 0.7638,
    marketProb: 0.569,
    edge: 0.1948,
    kellyStakeUnits: 0.07,
    confidence: 72,
    thesis: "test",
    invalidation: "test",
    signals: [],
    graderOk: true,
    graderNotes: [],
    gameTime: "2026-10-21T01:30:00.000Z",
    eventId: "fd_35928229",
    ...over,
  };
}

const modeled: ModeledGame[] = [
  { eventId: "fd_35928229", homeTeam: "San Antonio Spurs", awayTeam: "Oklahoma City Thunder", startTime: "2026-10-21T01:30:00.000Z" },
];

describe("dropUnmodeledGameLines", () => {
  it("drops every NBA game line when the model priced nothing (opening week)", () => {
    const r = dropUnmodeledGameLines("NBA", [pick()], []);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0].reason).toMatch(/no NBA model probability/);
  });

  it("keeps a pick on a modeled game, matched by event id", () => {
    const r = dropUnmodeledGameLines("NBA", [pick()], modeled);
    expect(r.kept).toHaveLength(1);
    expect(r.dropped).toEqual([]);
  });

  it("matches across feeds by teams + start time when the ids differ (bv_ vs fd_)", () => {
    const r = dropUnmodeledGameLines("NBA", [pick({ eventId: "bv_123", gameTime: "2026-10-21T01:40:00.000Z" })], modeled);
    expect(r.kept).toHaveLength(1);
  });

  it("drops a pick on a different game even if one team matches", () => {
    const r = dropUnmodeledGameLines(
      "NBA",
      [pick({ matchup: "Denver Nuggets @ Oklahoma City Thunder", selection: "Denver Nuggets", eventId: "fd_x", gameTime: "2026-10-23T01:40:00.000Z" })],
      modeled,
    );
    expect(r.dropped).toHaveLength(1);
  });

  it("leaves props alone, and leaves leagues with their own model path alone", () => {
    expect(dropUnmodeledGameLines("NBA", [pick({ market: "prop" })], []).kept).toHaveLength(1);
    expect(dropUnmodeledGameLines("MLB", [pick()], []).kept).toHaveLength(1);
    expect(dropUnmodeledGameLines("NFL", [pick()], []).kept).toHaveLength(1);
  });

  it("applies to WNBA too", () => {
    expect(dropUnmodeledGameLines("WNBA", [pick()], []).dropped).toHaveLength(1);
  });
});
