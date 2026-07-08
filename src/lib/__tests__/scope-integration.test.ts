// Scope-integration invariants.
//
// The funding trial is CLV-gated. A league that is IN_SCOPE (the pipeline
// generates picks for it) but is NOT wired into CLV capture, injury data, and
// prop grading will silently contaminate the trial: its picks count toward
// sample size + ROI while being invisible to the CLV beat-rate / avg-CLV gates.
// That is exactly why WNBA was stripped in 2026-05 and re-added (fully wired)
// in 2026-06. These tests make "a league we pick must be a league we can hold
// accountable" a red test at commit time, not 3am archaeology.

import { describe, it, expect } from "vitest";
import { IN_SCOPE_LEAGUES, INJURY_FILE, getPlayerProps } from "../agent/tools";
import { INJURY_FILE as HEALTH_INJURY_FILE } from "../agent/health";
import { LEAGUE_TO_SPORT } from "../clv-tracker";
import { PROP_GRADING_LEAGUES, SCOREBOARD, SUMMARY } from "../prop-grading";

describe("scope integration — every in-scope league is fully accountable", () => {
  it.each(IN_SCOPE_LEAGUES)("%s is CLV-accountable (LEAGUE_TO_SPORT has a sport key)", (league) => {
    // Missing here → captureClv() maps the league to undefined → closing-odds
    // file "missing" → clvCents stays null forever while the pick still counts
    // toward the trial. This is the primary contamination guard.
    expect(LEAGUE_TO_SPORT[league], `${league} not in clv-tracker LEAGUE_TO_SPORT`).toBeTruthy();
  });

  it.each(IN_SCOPE_LEAGUES)("%s has an injury feed wired (INJURY_FILE is non-null)", (league) => {
    // null is reserved for out-of-scope leagues with no ESPN feed (NCAAB).
    // An in-scope league with null injuries ships picks injury-blind.
    expect(INJURY_FILE[league], `${league} has no injury file — picks would be injury-blind`).not.toBeNull();
  });

  it.each(IN_SCOPE_LEAGUES)("%s can be graded (is a PropGradingLeague with scoreboard + summary URLs)", (league) => {
    // Moneyline + prop grading both resolve league → ESPN URL through these
    // maps. A cast that compiles but hits an undefined URL 404s at runtime.
    expect(
      (PROP_GRADING_LEAGUES as readonly string[]).includes(league),
      `${league} is not a PropGradingLeague — grading falls through to unmatched`,
    ).toBe(true);
    expect(SCOREBOARD[league as keyof typeof SCOREBOARD]).toMatch(/^https?:\/\//);
    expect(SUMMARY[league as keyof typeof SUMMARY]).toMatch(/^https?:\/\//);
  });

  it.each(IN_SCOPE_LEAGUES)("get_player_props(%s) degrades cleanly (no throw; well-formed shape)", (league) => {
    // Absence of a props feed must be available:false, never a throw and never
    // a fabricated pick. WNBA has no feed yet — this is its live path.
    const res = getPlayerProps(league);
    expect(res).toHaveProperty("available");
    expect(typeof res.available).toBe("boolean");
    expect(Array.isArray(res.topProps)).toBe(true);
  });

  it("get_player_props(WNBA) returns available:false until a WNBA props feed exists", () => {
    const res = getPlayerProps("WNBA");
    expect(res.available).toBe(false);
    expect(res.topProps).toEqual([]);
  });

  it("the tools and health INJURY_FILE maps stay in lockstep (no silent divergence)", () => {
    // health.ts once had MLB:null while tools served injuries-mlb.json — a real
    // bug. They are two copies of the same fact; this pins them together.
    expect(HEALTH_INJURY_FILE).toEqual(INJURY_FILE);
  });
});
