// Read-only allowlist: the Lane B tool surface must contain ONLY the named
// read tools — never run_ingest, the orchestrator, grader/critic/bankroll, or
// any DB-write path.

import { describe, it, expect } from "vitest";
import {
  LANE_B_READ_ONLY_TOOLS,
  LANE_B_TOOL_DEFINITIONS,
  LANE_B_STATS_TOOL_DEFINITIONS,
} from "../laneB";
import {
  STATS_TOOL_NAMES,
  PURE_STATS_TOOL_NAMES,
} from "@/lib/agent/tools/stats";

// The full read-only surface = the pick-pipeline read tools + the stats tools.
const FULL_ALLOWLIST = [...LANE_B_READ_ONLY_TOOLS, ...STATS_TOOL_NAMES];

const WRITE_OR_CONTROL = [
  "run_ingest",
  "check_data_health",
  "delegate_to_analyst",
  "create_pick",
  "persist_final_picks",
  "orchestrate",
  "grade",
  "bankroll",
  "critic",
];

describe("Lane B read-only allowlist", () => {
  it("contains exactly the twelve named read tools", () => {
    expect([...LANE_B_READ_ONLY_TOOLS].sort()).toEqual(
      [
        "get_board_edges",
        "get_dream_memory",
        "get_home_run_likes",
        "get_injuries",
        "get_mlb_signals",
        "get_model_probabilities",
        "get_odds",
        "get_player_props",
        "get_prop_projection",
        "get_quant_desk_analysis",
        "get_team_recent_records",
        "get_trend_summary",
      ].sort()
    );
  });

  it("never exposes a write / orchestration / control tool (pipeline OR stats)", () => {
    for (const t of WRITE_OR_CONTROL) {
      expect(FULL_ALLOWLIST).not.toContain(t);
    }
  });

  it("every allowlisted tool (pipeline + stats) is read-only by name (get_*)", () => {
    for (const t of FULL_ALLOWLIST) {
      expect(t.startsWith("get_")).toBe(true);
    }
  });

  it("the stats tools add exactly the eight named read tools", () => {
    expect([...STATS_TOOL_NAMES].sort()).toEqual(
      [
        "get_desk_record",
        "get_parlay_book",
        "get_player_gamelog",
        "get_probable_pitchers",
        "get_props_board",
        "get_standings",
        "get_team_efficiency",
        "get_mlb_team_stats",
      ].sort()
    );
  });

  it("the tool DEFINITIONS handed to the model are a subset of the full allowlist", () => {
    const allowed = new Set<string>(FULL_ALLOWLIST);
    for (const def of LANE_B_TOOL_DEFINITIONS) {
      expect(allowed.has(def.name)).toBe(true);
    }
  });
});

describe("Lane B STATS-MODE tool surface (a league we do NOT bet)", () => {
  it("stats-mode defs are EXACTLY the PURE stat tools (bet-shaped tools stripped)", () => {
    const names = LANE_B_STATS_TOOL_DEFINITIONS.map((d) => d.name).sort();
    expect(names).toEqual([...PURE_STATS_TOOL_NAMES].sort());
    // PURE = all stats tools MINUS the two bet-shaped ones.
    expect(names).not.toEqual([...STATS_TOOL_NAMES].sort());
  });

  // BLOCKER 1 PIN — the load-bearing invariant: stats mode is STRUCTURALLY
  // incapable of surfacing a playable bet. get_props_board (returns +EV plays
  // with book/side/price) and get_parlay_book (open +EV parlays) MUST be absent
  // from the stats-mode tool DEFINITIONS. This test goes red the instant anyone
  // re-adds a bet-shaped tool to the stats surface.
  it("stats mode EXCLUDES the bet-shaped tools: get_props_board AND get_parlay_book", () => {
    const names = new Set(LANE_B_STATS_TOOL_DEFINITIONS.map((d) => d.name));
    expect(names.has("get_props_board")).toBe(false);
    expect(names.has("get_parlay_book")).toBe(false);
  });

  it("stats mode also excludes the pick-pipeline +EV / edge / quant tools", () => {
    const names = new Set(LANE_B_STATS_TOOL_DEFINITIONS.map((d) => d.name));
    expect(names.has("get_board_edges")).toBe(false);
    expect(names.has("get_quant_desk_analysis")).toBe(false);
    expect(names.has("get_home_run_likes")).toBe(false);
    expect(names.has("get_prop_projection")).toBe(false);
  });

  it("stats mode INCLUDES the pure stat tools + the honest desk record", () => {
    const names = new Set(LANE_B_STATS_TOOL_DEFINITIONS.map((d) => d.name));
    // The genuine, play-free stat tools are present…
    expect(names.has("get_standings")).toBe(true);
    expect(names.has("get_team_efficiency")).toBe(true);
    expect(names.has("get_player_gamelog")).toBe(true);
    expect(names.has("get_probable_pitchers")).toBe(true);
    expect(names.has("get_mlb_team_stats")).toBe(true);
    // …and get_desk_record STAYS (league-independent track record, surfaces no play).
    expect(names.has("get_desk_record")).toBe(true);
  });

  it("every stats-mode tool is still read-only by name (get_*)", () => {
    for (const def of LANE_B_STATS_TOOL_DEFINITIONS) {
      expect(def.name.startsWith("get_")).toBe(true);
    }
  });
});
