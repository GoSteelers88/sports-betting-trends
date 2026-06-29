// Read-only allowlist: the Lane B tool surface must contain ONLY the named
// read tools — never run_ingest, the orchestrator, grader/critic/bankroll, or
// any DB-write path.

import { describe, it, expect } from "vitest";
import {
  LANE_B_READ_ONLY_TOOLS,
  LANE_B_TOOL_DEFINITIONS,
} from "../laneB";

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

  it("never exposes a write / orchestration / control tool", () => {
    for (const t of WRITE_OR_CONTROL) {
      expect(LANE_B_READ_ONLY_TOOLS as readonly string[]).not.toContain(t);
    }
  });

  it("every allowlisted tool is read-only by name (get_*)", () => {
    for (const t of LANE_B_READ_ONLY_TOOLS) {
      expect(t.startsWith("get_")).toBe(true);
    }
  });

  it("the tool DEFINITIONS handed to the model are a subset of the allowlist", () => {
    const allowed = new Set<string>(LANE_B_READ_ONLY_TOOLS);
    for (const def of LANE_B_TOOL_DEFINITIONS) {
      expect(allowed.has(def.name)).toBe(true);
    }
  });
});
