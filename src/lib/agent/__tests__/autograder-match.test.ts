// Regression tests for the autograder's pick-to-final matcher.
// The bug this guards against: pick #6 ("Texas Rangers vs Arizona
// Diamondbacks", selection "Arizona Diamondbacks") was silently graded
// against a Mets @ D'backs final because the original logic only required
// ONE ESPN team to appear in pick.matchup. matchesPickToFinal now requires
// both, so cross-game contamination cannot happen.

import { describe, it, expect } from "vitest";
import { matchesPickToFinal, teamMatches, gradeMoneyline } from "../autograder";

describe("matchesPickToFinal", () => {
  it("matches when both ESPN teams appear in pick.matchup", () => {
    expect(
      matchesPickToFinal(
        { matchup: "Texas Rangers vs Arizona Diamondbacks", selection: "Arizona Diamondbacks" },
        { homeTeam: "Arizona Diamondbacks", awayTeam: "Texas Rangers" }
      )
    ).toBe(true);
  });

  it("REGRESSION: rejects a Mets @ D'backs final for a Rangers @ D'backs pick", () => {
    // This is the exact case that mis-graded pick #6 in production.
    expect(
      matchesPickToFinal(
        { matchup: "Texas Rangers vs Arizona Diamondbacks", selection: "Arizona Diamondbacks" },
        { homeTeam: "Arizona Diamondbacks", awayTeam: "New York Mets" }
      )
    ).toBe(false);
  });

  it("rejects when only the away team matches", () => {
    expect(
      matchesPickToFinal(
        { matchup: "Boston Red Sox vs Tampa Bay Rays", selection: "Tampa Bay Rays" },
        { homeTeam: "New York Yankees", awayTeam: "Tampa Bay Rays" }
      )
    ).toBe(false);
  });

  it("rejects when the selection isn't one of the ESPN teams", () => {
    // Both teams happen to appear but selection is a third team — paranoid case.
    expect(
      matchesPickToFinal(
        { matchup: "Texas Rangers vs Arizona Diamondbacks", selection: "New York Mets" },
        { homeTeam: "Arizona Diamondbacks", awayTeam: "Texas Rangers" }
      )
    ).toBe(false);
  });

  it("matches home-team selection", () => {
    expect(
      matchesPickToFinal(
        { matchup: "Philadelphia 76ers vs. New York Knicks", selection: "New York Knicks" },
        { homeTeam: "New York Knicks", awayTeam: "Philadelphia 76ers" }
      )
    ).toBe(true);
  });
});

describe("gradeMoneyline", () => {
  const gf = (
    homeTeam: string,
    awayTeam: string,
    homeScore: number,
    awayScore: number,
    league: "NBA" | "MLB" = "NBA"
  ) => ({ league, homeTeam, awayTeam, homeScore, awayScore, date: "2026-06-11" });

  it("grades a home-team pick that won", () => {
    expect(gradeMoneyline("New York Knicks", gf("New York Knicks", "Philadelphia 76ers", 110, 104))).toBe("win");
  });

  it("grades an away-team pick that lost", () => {
    expect(gradeMoneyline("Philadelphia 76ers", gf("New York Knicks", "Philadelphia 76ers", 110, 104))).toBe("loss");
  });

  it("returns null when the selection matches neither team", () => {
    expect(gradeMoneyline("Boston Celtics", gf("New York Knicks", "Philadelphia 76ers", 110, 104))).toBeNull();
  });

  it("REGRESSION: returns null when the selection matches BOTH teams (ambiguous)", () => {
    // "Sox" matches both White Sox and Red Sox once the <4-char token filter
    // drops "sox". The old logic silently graded it as the home team; now it
    // refuses rather than risk a wrong grade corrupting the trial ledger.
    expect(gradeMoneyline("Sox", gf("Chicago White Sox", "Boston Red Sox", 5, 3, "MLB"))).toBeNull();
  });

  it("voids a tie (bad data — NBA/MLB cannot end tied)", () => {
    expect(gradeMoneyline("New York Knicks", gf("New York Knicks", "Philadelphia 76ers", 100, 100))).toBe("void");
  });
});

describe("teamMatches token-aware behavior", () => {
  it("does not collapse Mets and Yankees via the 'New York' prefix", () => {
    expect(teamMatches("New York Mets", "New York Yankees")).toBe(false);
  });

  it("normalizes punctuation and case", () => {
    expect(teamMatches("PHILADELPHIA 76ERS", "Philadelphia 76ers")).toBe(true);
  });
});
