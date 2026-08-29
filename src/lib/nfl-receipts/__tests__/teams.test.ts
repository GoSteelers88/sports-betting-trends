import { describe, expect, it } from "vitest";
import { FRANCHISES, franchiseKey, sameGame } from "../teams";

describe("franchise bridge (threat T12)", () => {
  it("carries exactly 32 franchises with unique keys and full names", () => {
    expect(FRANCHISES).toHaveLength(32);
    expect(new Set(FRANCHISES.map((f) => f.key)).size).toBe(32);
    expect(new Set(FRANCHISES.map((f) => f.fullName)).size).toBe(32);
  });

  it("resolves all three vocabularies to the same key", () => {
    expect(franchiseKey("KC")).toBe("chiefs"); // nflverse
    expect(franchiseKey("Kansas City Chiefs")).toBe("chiefs"); // Odds API + Pinnacle
    expect(franchiseKey("chiefs")).toBe("chiefs");
    expect(franchiseKey("SF")).toBe("49ers");
    expect(franchiseKey("San Francisco 49ers")).toBe("49ers");
    expect(franchiseKey("WSH")).toBe("commanders");
    expect(franchiseKey("LA")).toBe("rams"); // nflverse legacy
    expect(franchiseKey("LAC")).toBe("chargers");
  });

  it("never fuzzy-matches city prefixes into the wrong nickname", () => {
    expect(franchiseKey("New York Giants")).toBe("giants");
    expect(franchiseKey("New York Jets")).toBe("jets");
    expect(franchiseKey("Los Angeles Rams")).toBe("rams");
    expect(franchiseKey("Los Angeles Chargers")).toBe("chargers");
  });

  it("returns null for the unrecognizable instead of guessing", () => {
    expect(franchiseKey("")).toBeNull();
    expect(franchiseKey("Duke Blue Devils")).toBeNull();
  });
});

describe("sameGame", () => {
  const a = { kickoffUtc: "2026-09-13T17:00:00Z", home: "PHI", away: "KC" };
  it("joins across vocabularies within kickoff tolerance", () => {
    expect(
      sameGame(a, {
        kickoffUtc: "2026-09-13T17:05:00Z",
        home: "Philadelphia Eagles",
        away: "Kansas City Chiefs",
      }),
    ).toBe(true);
  });
  it("rejects a different pairing or a different window", () => {
    expect(
      sameGame(a, { kickoffUtc: "2026-09-13T17:00:00Z", home: "Kansas City Chiefs", away: "Philadelphia Eagles" }),
    ).toBe(false); // home/away swapped is NOT the same proposition
    expect(
      sameGame(a, { kickoffUtc: "2026-09-14T01:00:00Z", home: "Philadelphia Eagles", away: "Kansas City Chiefs" }),
    ).toBe(false);
  });
});
