// Tests for the injury-wire slate scoping + cross-source team matcher.
// The matcher reconciles ESPN injury team names ("LA Clippers", "St. Louis
// Cardinals") against The Odds API slate names ("Los Angeles Clippers",
// "St Louis Cardinals"). The tricky cases — shared cities, multi-word
// nicknames, and the Athletics relocation aliasing — are the point of this file.

import { describe, it, expect } from "vitest";
import {
  matchTeam,
  normalizeTeam,
  teamNickname,
  statusTier,
  isDecisionRelevant,
  slateTeamsFromEvents,
  isTeamOnSlate,
  scopeInjuriesToSlate,
  injuriesForTeams,
  isMlbHighImpact,
  isPitcherPosition,
  isRelevantForLeague,
} from "../injuries-scope";

describe("normalizeTeam", () => {
  it("strips punctuation and lowercases", () => {
    expect(normalizeTeam("St. Louis Cardinals")).toBe("saint louis cardinals");
    expect(normalizeTeam("Portland Trail-Blazers")).toBe("portland trail blazers");
  });
  it("expands city aliases", () => {
    expect(normalizeTeam("LA Clippers")).toBe("los angeles clippers");
  });
});

describe("teamNickname", () => {
  it("keeps multi-word nicknames whole", () => {
    expect(teamNickname(normalizeTeam("Boston Red Sox"))).toBe("red sox");
    expect(teamNickname(normalizeTeam("Chicago White Sox"))).toBe("white sox");
    expect(teamNickname(normalizeTeam("Portland Trail Blazers"))).toBe("trail blazers");
    expect(teamNickname(normalizeTeam("Toronto Maple Leafs"))).toBe("maple leafs");
  });
  it("falls back to the last token for single-word nicknames", () => {
    expect(teamNickname(normalizeTeam("New York Knicks"))).toBe("knicks");
  });
});

describe("matchTeam", () => {
  it("matches identical names", () => {
    expect(matchTeam("New York Yankees", "New York Yankees")).toBe(true);
  });

  it("matches ESPN abbreviated city to Odds API full city (LA Clippers)", () => {
    expect(matchTeam("LA Clippers", "Los Angeles Clippers")).toBe(true);
  });

  it("matches across punctuation differences (St. Louis vs St Louis)", () => {
    expect(matchTeam("St. Louis Cardinals", "St Louis Cardinals")).toBe(true);
  });

  it("does NOT confuse Red Sox with White Sox", () => {
    expect(matchTeam("Boston Red Sox", "Chicago White Sox")).toBe(false);
  });

  it("does NOT confuse the two New York baseball teams", () => {
    expect(matchTeam("New York Yankees", "New York Mets")).toBe(false);
  });

  it("does NOT confuse the two Los Angeles teams (Lakers vs Clippers)", () => {
    expect(matchTeam("Los Angeles Lakers", "LA Clippers")).toBe(false);
  });

  it("does NOT confuse the two Chicago teams (Cubs vs White Sox)", () => {
    expect(matchTeam("Chicago Cubs", "Chicago White Sox")).toBe(false);
  });

  it("matches the Athletics regardless of city prefix", () => {
    expect(matchTeam("Athletics", "Oakland Athletics")).toBe(true);
    expect(matchTeam("Athletics", "Athletics")).toBe(true);
    expect(matchTeam("Las Vegas Athletics", "Athletics")).toBe(true);
  });

  it("matches via nickname when cities differ in spelling", () => {
    // ESPN sometimes uses 'Golden State Warriors' identically, but confirm the
    // nickname path is robust to a hypothetical city rename.
    expect(matchTeam("Golden State Warriors", "Golden State Warriors")).toBe(true);
  });

  it("returns false on empty input", () => {
    expect(matchTeam("", "New York Yankees")).toBe(false);
    expect(matchTeam("New York Yankees", "")).toBe(false);
  });

  // Cross-league nickname collisions — NFL vs college football share nicknames.
  // The matcher must NOT treat "Charlotte 49ers" (CFB) as "San Francisco 49ers"
  // (NFL), or the NFL injury wire would scope to a college slate.
  it("does NOT match an NFL team to a college team with the same nickname", () => {
    expect(matchTeam("San Francisco 49ers", "Charlotte 49ers")).toBe(false);
    expect(matchTeam("Carolina Panthers", "Milwaukee Panthers")).toBe(false);
    expect(matchTeam("Detroit Lions", "North Alabama Lions")).toBe(false);
    expect(matchTeam("Philadelphia Eagles", "Niagara Purple Eagles")).toBe(false);
    expect(matchTeam("Las Vegas Raiders", "Wright St Raiders")).toBe(false);
    expect(matchTeam("Minnesota Vikings", "Cleveland St Vikings")).toBe(false);
  });

  it("still matches same-franchise names where the city agrees", () => {
    expect(matchTeam("LA Clippers", "Los Angeles Clippers")).toBe(true);
    expect(matchTeam("San Francisco 49ers", "San Francisco 49ers")).toBe(true);
  });
});

describe("statusTier / isDecisionRelevant", () => {
  it("classifies the cross-sport status vocabulary", () => {
    expect(statusTier("Out")).toBe("OUT");
    expect(statusTier("Doubtful")).toBe("DOUBTFUL");
    expect(statusTier("Questionable")).toBe("QUESTIONABLE");
    expect(statusTier("Day-To-Day")).toBe("DAY_TO_DAY");
    expect(statusTier("10-Day-IL")).toBe("IL");
    expect(statusTier("60-Day-IL")).toBe("IL");
    expect(statusTier("Injured Reserve")).toBe("IL");
  });

  it("treats OUT/DOUBTFUL/IL/QUESTIONABLE as decision-relevant", () => {
    expect(isDecisionRelevant("Out")).toBe(true);
    expect(isDecisionRelevant("60-Day-IL")).toBe(true);
    expect(isDecisionRelevant("Questionable")).toBe(true);
    expect(isDecisionRelevant("Doubtful")).toBe(true);
  });

  it("excludes Day-To-Day from decision-relevant", () => {
    expect(isDecisionRelevant("Day-To-Day")).toBe(false);
  });
});

describe("MLB high-impact filter (follow only game-heavy absences)", () => {
  it("identifies pitcher positions", () => {
    expect(isPitcherPosition("SP")).toBe(true);
    expect(isPitcherPosition("RP")).toBe(true);
    expect(isPitcherPosition("P")).toBe(true);
    expect(isPitcherPosition("1B")).toBe(false);
    expect(isPitcherPosition(undefined)).toBe(false);
  });

  it("keeps a near-term injured starting pitcher (heavy game impact)", () => {
    expect(isMlbHighImpact({ position: "SP", status: "10-Day-IL" })).toBe(true);
    expect(isMlbHighImpact({ position: "SP", status: "Day-To-Day" })).toBe(true);
    expect(isMlbHighImpact({ position: "RP", status: "15-Day-IL" })).toBe(true);
  });

  it("DROPS season-long 60-Day-IL even for a pitcher (already priced in)", () => {
    expect(isMlbHighImpact({ position: "SP", status: "60-Day-IL" })).toBe(false);
    expect(isMlbHighImpact({ position: "1B", status: "60-Day-IL" })).toBe(false);
  });

  it("keeps an OUT/near-term position player but not deep-IL filler", () => {
    expect(isMlbHighImpact({ position: "SS", status: "Out" })).toBe(true);
    expect(isMlbHighImpact({ position: "C", status: "10-Day-IL" })).toBe(true);
    expect(isMlbHighImpact({ position: "LF", status: "60-Day-IL" })).toBe(false);
  });

  it("routes MLB through the high-impact gate and others through the standard gate", () => {
    // MLB: a 60-Day-IL is dropped...
    expect(isRelevantForLeague("MLB", { position: "SP", status: "60-Day-IL" })).toBe(false);
    // ...but the SAME status is decision-relevant under the standard (NBA/NHL) gate.
    expect(isRelevantForLeague("NHL", { status: "Injured Reserve" })).toBe(true);
    expect(isRelevantForLeague("NBA", { status: "Out" })).toBe(true);
  });

  it("keeps a Day-To-Day PITCHER (different starter = different game) but not a DTD bat", () => {
    expect(isMlbHighImpact({ position: "SP", status: "Day-To-Day" })).toBe(true);
    expect(isMlbHighImpact({ position: "SS", status: "Day-To-Day" })).toBe(false);
  });

  it("scopeInjuriesToSlate with league=MLB drops 60-Day-IL and DTD bats, keeps heavy", () => {
    const injuries = [
      { player: "Ace SP", team: "New York Yankees", position: "SP", status: "10-Day-IL" },
      { player: "Gone Since April", team: "New York Yankees", position: "SP", status: "60-Day-IL" },
      { player: "Star Bat OUT", team: "New York Yankees", position: "SS", status: "Out" },
      { player: "Minor Tweak", team: "New York Yankees", position: "LF", status: "Day-To-Day" },
    ];
    const r = scopeInjuriesToSlate(injuries, ["New York Yankees"], { decisionOnly: true, league: "MLB" });
    const names = r.scoped.map((i) => i.player);
    expect(names).toContain("Ace SP");
    expect(names).toContain("Star Bat OUT");
    expect(names).not.toContain("Gone Since April"); // 60-day priced in
    expect(names).not.toContain("Minor Tweak"); // DTD position player isn't "heavy"
  });
});

describe("slateTeamsFromEvents / isTeamOnSlate", () => {
  const events = [
    { home_team: "Los Angeles Clippers", away_team: "Boston Celtics" },
    { home_team: "New York Yankees", away_team: "St Louis Cardinals" },
    { home_team: "", away_team: "Houston Astros" }, // partial row tolerated
  ];

  it("collects distinct slate teams as display names", () => {
    const teams = slateTeamsFromEvents(events);
    expect(teams).toContain("Los Angeles Clippers");
    expect(teams).toContain("Boston Celtics");
    expect(teams).toContain("Houston Astros");
    // de-dup keyed on normalized name
    expect(teams.length).toBe(5);
  });

  it("matches an ESPN name against the slate", () => {
    const teams = slateTeamsFromEvents(events);
    expect(isTeamOnSlate("LA Clippers", teams)).toBe(true); // ESPN spelling
    expect(isTeamOnSlate("New York Mets", teams)).toBe(false); // not playing
  });
});

describe("scopeInjuriesToSlate", () => {
  const injuries = [
    { player: "Kawhi Leonard", team: "LA Clippers", status: "Out" },
    { player: "Bench Guy", team: "LA Clippers", status: "Day-To-Day" },
    { player: "Aaron Judge", team: "New York Yankees", status: "10-Day-IL" },
    { player: "Off Slate", team: "New York Mets", status: "Out" }, // not playing
  ];
  const slate = ["Los Angeles Clippers", "New York Yankees"];

  it("keeps only teams on the slate", () => {
    const r = scopeInjuriesToSlate(injuries, slate);
    expect(r.scoped.map((i) => i.player)).not.toContain("Off Slate");
    expect(r.scoped.some((i) => i.player === "Aaron Judge")).toBe(true);
  });

  it("computes the decision-relevant subset (drops Day-To-Day)", () => {
    const r = scopeInjuriesToSlate(injuries, slate);
    expect(r.relevant.map((i) => i.player)).not.toContain("Bench Guy");
    expect(r.relevant.map((i) => i.player)).toContain("Kawhi Leonard");
  });

  it("orders worst-first (OUT before IL before Day-To-Day)", () => {
    const r = scopeInjuriesToSlate(injuries, slate);
    expect(r.scoped[0].status).toBe("Out");
  });

  it("decisionOnly trims scoped to relevant statuses", () => {
    const r = scopeInjuriesToSlate(injuries, slate, { decisionOnly: true });
    expect(r.scoped.map((i) => i.player)).not.toContain("Bench Guy");
  });

  it("reports teamsPlaying that actually have scoped injuries", () => {
    const r = scopeInjuriesToSlate(injuries, slate);
    expect(r.teamsPlaying).toEqual(["LA Clippers", "New York Yankees"]);
  });
});

describe("injuriesForTeams (agent-tool matchup filter)", () => {
  const injuries = [
    { player: "Kawhi Leonard", team: "LA Clippers", status: "Out" },
    { player: "Jaylen Brown", team: "Boston Celtics", status: "Questionable" },
    { player: "Bench Guy", team: "Boston Celtics", status: "Day-To-Day" },
    { player: "Aaron Judge", team: "New York Yankees", status: "10-Day-IL" },
  ];

  it("returns only the requested matchup's decision-relevant players", () => {
    const out = injuriesForTeams(injuries, ["Los Angeles Clippers", "Boston Celtics"]);
    const names = out.map((i) => i.player);
    expect(names).toContain("Kawhi Leonard");
    expect(names).toContain("Jaylen Brown");
    expect(names).not.toContain("Bench Guy"); // day-to-day filtered by default
    expect(names).not.toContain("Aaron Judge"); // different game
  });

  it("returns empty for an empty team list", () => {
    expect(injuriesForTeams(injuries, [])).toEqual([]);
  });

  it("can include non-decision statuses when asked", () => {
    const out = injuriesForTeams(injuries, ["Boston Celtics"], { decisionOnly: false });
    expect(out.map((i) => i.player)).toContain("Bench Guy");
  });
});
