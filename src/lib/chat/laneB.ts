// Lane B — the CONSTRAINED, READ-ONLY live-analysis turn for "The Sharp".
//
// This reuses the desk's own tool layer (buildToolHandlers + TOOL_DEFINITIONS)
// and hydrates deps the same way analyst.ts does — but it exposes ONLY a
// read-only subset of tools. It is structurally incapable of creating an
// AgentPick, dispatching a workflow, or calling runners.ts: those paths are not
// in this module's import graph at all, and the tool allowlist below is the
// single source of truth for what the chat can touch.

import { getAnthropic, MODELS } from "@/lib/agent/client";
import {
  TOOL_DEFINITIONS,
  buildToolHandlers,
  type ToolName,
} from "@/lib/agent/tools";
import {
  getActiveMemoriesForScope,
  getLatestDreamSummary,
  getRecentResultsByTeam,
} from "@/lib/agent/memory";
import { buildLaneBSystemPrompt } from "./persona";

// ─── The read-only allowlist (load-bearing) ──────────────────────────────────
//
// The ONLY tools Lane B may call. Every one is a pure data READ. Explicitly
// excluded: run_ingest, the orchestrator, grader/critic/bankroll, and ANY
// DB-write path. If a future tool is added to TOOL_DEFINITIONS, it does NOT
// reach chat unless its name is added here on purpose.
export const LANE_B_READ_ONLY_TOOLS: readonly ToolName[] = [
  "get_odds",
  "get_model_probabilities",
  "get_board_edges",
  "get_injuries",
  "get_player_props",
  "get_prop_projection",
  "get_home_run_likes",
  "get_mlb_signals",
  "get_quant_desk_analysis",
  "get_team_recent_records",
  "get_dream_memory",
  "get_trend_summary",
] as const;

const ALLOWED = new Set<string>(LANE_B_READ_ONLY_TOOLS);

// Tool definitions filtered to the allowlist — this is what we hand the model,
// so it literally cannot see write tools (there are none in TOOL_DEFINITIONS,
// but this also future-proofs against any added later).
export const LANE_B_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter((t) =>
  ALLOWED.has(t.name)
);

// Mirror the analyst's ≤8 cap, but tighter for a public, latency-sensitive,
// single-question turn.
const MAX_ITERATIONS = 6;

export type LaneBResult = {
  reply: string;
  toolsUsed: ToolName[];
  // The raw tool-result payloads collected this turn, used by the grounding
  // guard to verify every numeric claim traces back to data we actually read.
  toolResultTexts: string[];
  iterations: number;
};

// Build a tool-handler map restricted to the allowlist. Even if the model
// hallucinates a write-tool name, there's no handler for it and we return an
// explicit error block rather than executing anything.
function buildReadOnlyHandlers(
  deps: Parameters<typeof buildToolHandlers>[0]
): Record<string, (input: unknown) => unknown> {
  const full = buildToolHandlers(deps);
  const ro: Record<string, (input: unknown) => unknown> = {};
  for (const name of LANE_B_READ_ONLY_TOOLS) {
    if (full[name]) ro[name] = full[name];
  }
  return ro;
}

// Run the constrained Lane B turn for a specific league. The user's question is
// passed through; the system prompt enforces the grounding contract and the
// discipline. Injected client for tests.
export async function runLaneB(
  league: "NBA" | "MLB",
  userMessage: string,
  recentTurns: Array<{ role: "user" | "assistant"; content: string }> = [],
  client = getAnthropic(),
  // Stricter regeneration instruction appended on a grounding-guard retry.
  extraInstruction?: string,
  // "matchup" = a specific named game; "slate" = a board-level "best play"
  // survey across all of tonight's games.
  scope: "matchup" | "slate" = "matchup"
): Promise<LaneBResult> {
  const [memories, latestDream, teamRecords] = await Promise.all([
    getActiveMemoriesForScope(league),
    getLatestDreamSummary(),
    getRecentResultsByTeam(league, 14),
  ]);

  const handlers = buildReadOnlyHandlers({
    activeMemories: memories,
    latestDream,
    teamRecords,
  });

  let system = buildLaneBSystemPrompt(league, scope);
  if (extraInstruction) system += `\n\n${extraInstruction}`;

  // Seed with the (sanitized) recent turns the client sent back, then the new
  // question. We cap history defensively.
  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [];
  for (const t of recentTurns.slice(-6)) {
    messages.push({ role: t.role, content: t.content.slice(0, 2000) });
  }
  messages.push({ role: "user", content: userMessage.slice(0, 2000) });

  const toolsUsed: ToolName[] = [];
  const toolResultTexts: string[] = [];
  let iterations = 0;
  let finalText = "";

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const response = await client.messages.create({
      model: MODELS.analyst,
      max_tokens: 1500,
      system,
      tools: LANE_B_TOOL_DEFINITIONS,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: messages as any,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "tool_use") {
      const toolResults: Array<{
        type: "tool_result";
        tool_use_id: string;
        content: string;
      }> = [];

      for (const block of response.content) {
        if (block.type === "tool_use") {
          const name = block.name as ToolName;
          let result: unknown;
          if (ALLOWED.has(name) && handlers[name]) {
            toolsUsed.push(name);
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              result = handlers[name](block.input as any);
            } catch (err) {
              result = { error: err instanceof Error ? err.message : String(err) };
            }
          } else {
            // Not on the allowlist — refuse to execute, tell the model.
            result = {
              error: `tool ${name} is not available in this chat. Only read-only data tools are permitted.`,
            };
          }
          const serialized = JSON.stringify(result);
          toolResultTexts.push(serialized);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: serialized.slice(0, 120_000),
          });
        }
      }

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    for (const block of response.content) {
      if (block.type === "text") finalText += block.text;
    }
    break;
  }

  return {
    reply: finalText.trim(),
    toolsUsed: [...new Set(toolsUsed)],
    toolResultTexts,
    iterations,
  };
}
