import { describe, expect, it } from "vitest";
import {
  buildNflSlate,
  SLATE_LOOKBACK_MS,
  SLATE_WEEK_SPAN_MS,
} from "../site-slate";
import type { SharpEvent } from "../../../scripts/scrape-pinnacle";

const NOW = Date.parse("2026-09-09T12:00:00Z");

function ev(over: Partial<SharpEvent>): SharpEvent {
  return {
    id: "pin_1",
    sport_key: "americanfootball_nfl",
    sport_title: "NFL",
    commence_time: "2026-09-13T17:00:00Z",
    home_team: "Philadelphia Eagles",
    away_team: "Kansas City Chiefs",
    moneyline: { home: -180, away: 155 },
    spread: { point: -3.5, home: -105, away: -108 },
    total: { point: 47.5, over: -110, under: -104 },
    ...over,
  };
}

describe("buildNflSlate", () => {
  it("windows to one NFL week: keeps in-progress and this week, drops past and next week", () => {
    const live = new Date(NOW - 3600_000).toISOString(); // anchor: earliest upcoming
    const slate = buildNflSlate(
      [
        ev({ id: "past", commence_time: new Date(NOW - SLATE_LOOKBACK_MS - 60_000).toISOString() }),
        ev({ id: "live", commence_time: live }),
        ev({ id: "sun", commence_time: "2026-09-13T17:00:00Z" }),
        ev({
          id: "next-week",
          commence_time: new Date(Date.parse(live) + SLATE_WEEK_SPAN_MS + 60_000).toISOString(),
        }),
      ],
      NOW,
    );
    expect(slate.gameCount).toBe(2);
    expect(slate.games.map((g) => g.kickoffUtc)).toEqual(
      [...slate.games.map((g) => g.kickoffUtc)].sort(), // chronological
    );
  });

  it("pre-season: anchors on the opening kickoff instead of sitting empty", () => {
    const early = Date.parse("2026-08-29T16:00:00Z"); // 12 days before TNF
    const slate = buildNflSlate(
      [
        ev({ id: "tnf", commence_time: "2026-09-10T00:20:00Z" }),
        ev({ id: "sun", commence_time: "2026-09-13T17:00:00Z" }),
        ev({ id: "wk2", commence_time: "2026-09-17T00:20:00Z" }), // next week's TNF
      ],
      early,
    );
    expect(slate.games.map((g) => g.kickoffUtc)).toEqual([
      "2026-09-10T00:20:00Z",
      "2026-09-13T17:00:00Z",
    ]);
  });

  it("devigs the moneyline: fair probs sum to 1, favorite above implied-fair midpoint", () => {
    const slate = buildNflSlate([ev({})], NOW);
    const g = slate.games[0];
    expect(g.fairHomeProb).not.toBeNull();
    expect(g.fairHomeProb! + g.fairAwayProb!).toBeCloseTo(1, 10);
    expect(g.fairHomeProb!).toBeGreaterThan(0.5); // -180 home favorite
    expect(g.fairHomeProb!).toBeLessThan(0.7);
  });

  it("a game without a moneyline carries null fair probs, not a guess", () => {
    const slate = buildNflSlate([ev({ moneyline: undefined })], NOW);
    expect(slate.games[0].fairHomeProb).toBeNull();
    expect(slate.games[0].fairAwayProb).toBeNull();
  });

  it("exposes the SlateOddsFile-compatible events alias for injury scoping", () => {
    const slate = buildNflSlate([ev({})], NOW);
    expect(slate.events).toEqual([
      { home_team: "Philadelphia Eagles", away_team: "Kansas City Chiefs" },
    ]);
  });
});
