// Unit tests for the cross-run held-positions guard. Fixtures are the four
// real multi-pick games found in AgentPick on 2026-10-13: two NBA both-sides
// pairs and a cross-feed Packers double must be blocked; the Red Sox split
// doubleheader must NOT be.

import { describe, it, expect } from "vitest";
import { dropHeldGames, sameGame, type HeldPick } from "../held-positions";
import type { GradedPick } from "../grader";

function pick(over: Partial<GradedPick> = {}): GradedPick {
  return {
    matchup: "Atlanta Hawks @ Orlando Magic",
    market: "moneyline",
    selection: "Atlanta Hawks",
    oddsAmerican: 120,
    modelProb: 0.55,
    marketProb: 0.45,
    edge: 0.1,
    kellyStakeUnits: 0.5,
    confidence: 60,
    thesis: "test",
    invalidation: "test",
    signals: [],
    graderOk: true,
    graderNotes: [],
    gameTime: "2026-10-21T23:10:00.000Z",
    eventId: "fd_35937399",
    ...over,
  };
}

function held(over: Partial<HeldPick> = {}): HeldPick {
  return {
    id: 143,
    matchup: "Atlanta Hawks @ Orlando Magic",
    market: "moneyline",
    selection: "Orlando Magic",
    gameDate: new Date("2026-10-21T23:10:00.000Z"),
    eventId: "fd_35937399",
    ...over,
  };
}

describe("dropHeldGames — real 2026 cases", () => {
  it("blocks the opposite side of a held game (NBA #143 Magic → #149 Hawks)", () => {
    const r = dropHeldGames([pick()], [held()]);
    expect(r.kept).toHaveLength(0);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0].reason).toContain("#143");
    expect(r.dropped[0].reason).toContain("OPPOSITE side");
  });

  it("blocks the opposite side (NBA #141 Grizzlies → #144 Jazz)", () => {
    const r = dropHeldGames(
      [pick({ matchup: "Utah Jazz @ Memphis Grizzlies", selection: "Utah Jazz", gameTime: "2026-10-22T00:10:00.000Z", eventId: "fd_35937404" })],
      [held({ id: 141, matchup: "Utah Jazz @ Memphis Grizzlies", selection: "Memphis Grizzlies", gameDate: new Date("2026-10-22T00:10:00.000Z"), eventId: "fd_35937404" })],
    );
    expect(r.kept).toHaveLength(0);
    expect(r.dropped[0].reason).toContain("#141");
  });

  it("blocks a same-side double from a different feed one minute apart (NFL #135 → #136 Packers)", () => {
    const r = dropHeldGames(
      [pick({ matchup: "Green Bay Packers @ Tampa Bay Buccaneers", selection: "Green Bay Packers", gameTime: "2026-10-04T17:01:00.000Z", eventId: "fd_36104917" })],
      [held({ id: 135, matchup: "Green Bay Packers @ Tampa Bay Buccaneers", selection: "Green Bay Packers", gameDate: new Date("2026-10-04T17:00:00.000Z"), eventId: "bv_29511191" })],
    );
    expect(r.kept).toHaveLength(0);
    expect(r.dropped[0].reason).toContain("same side");
  });

  it("keeps game 2 of a split doubleheader (MLB #72 → #74 Red Sox, 5.5h apart)", () => {
    const r = dropHeldGames(
      [pick({ matchup: "Boston Red Sox @ Tampa Bay Rays", selection: "Boston Red Sox", gameTime: "2026-07-17T23:11:00.000Z", eventId: "fd_35816167" })],
      [held({ id: 72, matchup: "Boston Red Sox @ Tampa Bay Rays", selection: "Boston Red Sox", gameDate: new Date("2026-07-17T17:36:00.000Z"), eventId: "fd_35816163" })],
    );
    expect(r.kept).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
  });
});

describe("dropHeldGames — edges", () => {
  it("keeps picks on other games", () => {
    const r = dropHeldGames([pick({ matchup: "Boston Celtics @ Detroit Pistons", selection: "Boston Celtics", eventId: "fd_35928218" })], [held()]);
    expect(r.kept).toHaveLength(1);
  });

  it("never touches props", () => {
    const r = dropHeldGames([pick({ market: "prop", selection: "Trae Young over 24.5 points" })], [held()]);
    expect(r.kept).toHaveLength(1);
  });

  it("ignores held props when judging game lines", () => {
    const r = dropHeldGames([pick()], [held({ market: "prop", selection: "Paolo Banchero over 7.5 rebounds" })]);
    expect(r.kept).toHaveLength(1);
  });

  it("matches across 'vs' and '@' matchup formats with no event ids", () => {
    const r = dropHeldGames(
      [pick({ matchup: "Orlando Magic vs Atlanta Hawks", eventId: undefined })],
      [held({ eventId: null })],
    );
    expect(r.kept).toHaveLength(0);
  });

  it("matches synthetic ids that differ only by a moved start time", () => {
    const r = dropHeldGames(
      [pick({ eventId: "syn:atlanta-hawks-orlando-magic@2026-10-21T23:40:00.000Z", gameTime: "2026-10-21T23:40:00.000Z" })],
      [held({ eventId: "syn:atlanta-hawks-orlando-magic@2026-10-21T23:10:00.000Z" })],
    );
    expect(r.kept).toHaveLength(0);
  });

  it("keeps a rematch of the same teams days later on a different feed", () => {
    const r = dropHeldGames(
      [pick({ gameTime: "2026-10-24T23:10:00.000Z", eventId: "bv_99999999" })],
      [held()],
    );
    expect(r.kept).toHaveLength(1);
  });

  it("does not guess when the new pick has no usable time and no matching id", () => {
    const r = dropHeldGames([pick({ gameTime: undefined, eventId: "bv_1" })], [held()]);
    expect(r.kept).toHaveLength(1);
  });
});

describe("sameGame", () => {
  const base = { matchup: "A Team @ B Team", gameDate: new Date("2026-10-21T23:00:00Z"), eventId: null };
  it("is true on identical ids regardless of time", () => {
    expect(sameGame({ ...base, eventId: "fd_1" }, { ...base, gameDate: new Date("2026-10-25T00:00:00Z"), eventId: "fd_1" })).toBe(true);
  });
  it("is false just outside the 3h window across feeds", () => {
    expect(sameGame({ ...base, eventId: "fd_1" }, { ...base, gameDate: new Date("2026-10-22T02:01:00Z"), eventId: "bv_2" })).toBe(false);
  });
  it("is true just inside the 3h window across feeds", () => {
    expect(sameGame({ ...base, eventId: "fd_1" }, { ...base, gameDate: new Date("2026-10-22T01:59:00Z"), eventId: "bv_2" })).toBe(true);
  });
  it("treats distinct same-feed ids inside the window as the same game (fail-closed)", () => {
    expect(sameGame({ ...base, eventId: "fd_1" }, { ...base, gameDate: new Date("2026-10-22T01:00:00Z"), eventId: "fd_2" })).toBe(true);
  });
});
