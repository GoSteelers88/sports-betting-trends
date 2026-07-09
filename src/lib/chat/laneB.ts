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
  IN_SCOPE_LEAGUES,
  type ToolName,
  type InScopeLeague,
} from "@/lib/agent/tools";
import {
  STATS_TOOL_DEFINITIONS,
  STATS_TOOL_NAMES,
  PURE_STATS_TOOL_NAMES,
  PURE_STATS_TOOL_DEFINITIONS,
  buildStatsHandlers,
  type StatsLeague,
  type StatsToolName,
} from "@/lib/agent/tools/stats";
import {
  getActiveMemoriesForScope,
  getLatestDreamSummary,
  getRecentResultsByTeam,
  getDeskRecordSummary,
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

// The read-only allowlist is the pick-pipeline tools PLUS the stats tools
// (src/lib/agent/tools/stats.ts — standings, efficiency, gamelogs, props board,
// pitching, team stats, parlay book, desk record). Every one is a pure data
// read; none can write, ingest, or place a bet.
const ALLOWED = new Set<string>([...LANE_B_READ_ONLY_TOOLS, ...STATS_TOOL_NAMES]);

// Tool definitions we hand the model in BETS mode = the allowlisted pipeline
// tools + all the stats tool defs. The model literally cannot see write tools
// (there are none).
export const LANE_B_TOOL_DEFINITIONS = [
  ...TOOL_DEFINITIONS.filter((t) => ALLOWED.has(t.name)),
  ...STATS_TOOL_DEFINITIONS,
];

// STATS MODE allowlist + defs. A stats-only league (NFL/NHL/NCAAB) has no
// bettable pipeline (get_board_edges / get_quant_desk_analysis are in-scope-only
// and meaningless there). Stats mode exposes ONLY the PURE stat tools — every
// bet-shaped tool is stripped: not just the pick-pipeline edge/quant tools (they
// were never in the stats defs), but ALSO get_props_board and get_parlay_book,
// which surface playable +EV plays / open parlays. This is the STRUCTURAL
// mechanism that makes a stats turn incapable of issuing a bet: nothing on the
// menu can return a book/side/price play. get_desk_record stays (honest,
// league-independent track record — surfaces no play).
const STATS_ONLY_ALLOWED = new Set<string>(PURE_STATS_TOOL_NAMES);
export const LANE_B_STATS_TOOL_DEFINITIONS = [...PURE_STATS_TOOL_DEFINITIONS];

// Mirror the analyst's ≤8 cap, but tighter for a public, latency-sensitive,
// single-question turn. With the "batch your tool calls" instruction in the
// system prompt (persona.ts), 4 model round-trips — each running every tool the
// model requests in that response — covers even the GO-DEEP toolset. Two stacked
// 6-iteration loops (draft + strict regen) were the 504 root cause; the regen is
// now a single no-tools rewrite (regroundLaneB) and this floor is lower.
const MAX_ITERATIONS = 4;

// Cap on the inlined prior-tool-results we feed the no-tools rewrite/finalize.
// The raw per-tool slices are 120k each; a rewrite doesn't need all of it, and
// keeping this bounded protects latency + the token budget. 20k chars (~5k
// tokens) is plenty to re-state the numbers already fetched this turn.
const REGROUND_RESULTS_CAP = 20_000;

// A Lane B turn can call pipeline tools (bets mode) OR stats tools (either
// mode), so toolsUsed spans both name spaces.
export type LaneBToolName = ToolName | StatsToolName;

export type LaneBResult = {
  reply: string;
  toolsUsed: LaneBToolName[];
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
  // BETS mode league is a bettable league; STATS mode league is a stats-only
  // league (NFL/NHL/NCAAB/soccer) OR a bettable one asked purely for stats.
  league: InScopeLeague | StatsLeague,
  userMessage: string,
  recentTurns: Array<{ role: "user" | "assistant"; content: string }> = [],
  client = getAnthropic(),
  // Stricter regeneration instruction appended on a grounding-guard retry.
  extraInstruction?: string,
  // "matchup" = a specific named game; "slate" = a board-level "best play"
  // survey across all of tonight's games.
  scope: "matchup" | "slate" = "matchup",
  // "bets" = full pick pipeline (in-scope leagues only). "stats" = stats tools
  // ONLY, for a league we do NOT bet — structurally cannot issue a play.
  mode: "bets" | "stats" = "bets"
): Promise<LaneBResult> {
  const isStats = mode === "stats";

  // Which tool surface + allowlist this turn uses. Stats mode = stats tools
  // ONLY (no board-edges / quant-desk / props +EV): that IS the mechanism that
  // makes a stats turn incapable of issuing a bet.
  const allowedSet = isStats ? STATS_ONLY_ALLOWED : ALLOWED;
  const toolDefs = isStats
    ? LANE_B_STATS_TOOL_DEFINITIONS
    : LANE_B_TOOL_DEFINITIONS;

  let handlers: Record<string, (input: unknown) => unknown>;

  if (isStats) {
    // Stats-only: skip the in-scope-only memory reads (they assume a bettable
    // league). But DO fetch the remit-wide desk record — get_desk_record stays
    // on the stats-mode menu, and "how's the desk doing?" is a valid question
    // even in a hockey chat. The record spans the whole betting remit
    // (NBA/MLB/WNBA), not this stats league. On DB failure the fetch returns
    // null → get_desk_record degrades to available:false, never breaks.
    const deskRecord = await getDeskRecordSummary(IN_SCOPE_LEAGUES, 30);
    handlers = buildStatsHandlers(deskRecord);
  } else {
    const [memories, latestDream, teamRecords, deskRecord] = await Promise.all([
      getActiveMemoriesForScope(league),
      getLatestDreamSummary(),
      getRecentResultsByTeam(league, 14),
      // Desk record spans the whole betting remit (NBA/MLB/WNBA), not just the
      // league of this turn — a "how's the desk doing?" question wants the book.
      getDeskRecordSummary(IN_SCOPE_LEAGUES, 30),
    ]);

    // Pipeline read-only handlers + the stats handlers (the latter carry the
    // pre-fetched desk record; every other stats tool is a pure file read).
    handlers = {
      ...buildReadOnlyHandlers({
        activeMemories: memories,
        latestDream,
        teamRecords,
      }),
      ...buildStatsHandlers(deskRecord),
    };
  }

  let system = buildLaneBSystemPrompt(league, scope, mode);
  if (extraInstruction) system += `\n\n${extraInstruction}`;

  // Seed with the (sanitized) recent turns the client sent back, then the new
  // question. We cap history defensively.
  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [];
  for (const t of recentTurns.slice(-6)) {
    messages.push({ role: t.role, content: t.content.slice(0, 2000) });
  }
  messages.push({ role: "user", content: userMessage.slice(0, 2000) });

  const toolsUsed: LaneBToolName[] = [];
  const toolResultTexts: string[] = [];
  let iterations = 0;
  let finalText = "";

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const response = await client.messages.create({
      model: MODELS.analyst,
      max_tokens: 1500,
      system,
      tools: toolDefs,
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
          const name = block.name as LaneBToolName;
          let result: unknown;
          if (allowedSet.has(name) && handlers[name]) {
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

  // Empty-reply hole (Fable): if the loop exhausted MAX_ITERATIONS while the last
  // response was STILL stop_reason:"tool_use", finalText is "". checkGrounding("")
  // returns grounded:true VACUOUSLY → a blank reply ships as 200 and the frontend
  // renders "The desk hit a snag". Force ONE no-tools finalize using only what we
  // fetched, so the model MUST emit text (it cannot ask for another tool). If it
  // STILL comes back empty, we return "" and sharp.ts treats it as ungrounded and
  // falls back (belt-and-suspenders) rather than shipping blank.
  let reply = finalText.trim();
  if (!reply) {
    reply = await noToolsAnswer(
      client,
      buildLaneBSystemPrompt(league, scope, mode),
      userMessage,
      toolResultTexts
    );
  }

  return {
    reply: reply.trim(),
    toolsUsed: [...new Set(toolsUsed)],
    toolResultTexts,
    iterations,
  };
}

// ─── The no-tools rewrite primitive (shared by regen + empty-reply finalize) ──
//
// ONE messages.create with NO `tools` param. The model structurally cannot fetch
// → it cannot fabricate a NEW number that then grounds; it can only re-state (or
// omit) numbers already present in `priorToolResultTexts`. The FULL Lane B system
// prompt is used (not enforcement-text-only) so the mode/scope boundaries — most
// importantly the stats-mode "no pick on this league" rule, which checkGrounding
// does NOT verify — survive the rewrite. The already-collected tool results are
// inlined as a USER-role message (kept out of the highest-trust system slot).
async function noToolsAnswer(
  client: ReturnType<typeof getAnthropic>,
  system: string,
  userMessage: string,
  priorToolResultTexts: string[],
  extraSystem?: string
): Promise<string> {
  const fullSystem = extraSystem ? `${system}\n\n${extraSystem}` : system;
  const inlined =
    "TOOL RESULTS FROM THIS TURN (use ONLY numbers present here; if a number " +
    "isn't here, do not state it):\n" +
    priorToolResultTexts.join("\n").slice(0, REGROUND_RESULTS_CAP);

  const resp = await client.messages.create({
    model: MODELS.analyst,
    max_tokens: 1500,
    system: fullSystem,
    // NO `tools` — the whole point. The model cannot fetch, so it cannot invent
    // a new figure that would then pass the grounding re-check.
    messages: [
      { role: "user", content: userMessage.slice(0, 2000) },
      { role: "user", content: inlined },
    ],
  });

  return resp.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
}

// Grounding-enforcement instruction appended to the FULL Lane B system prompt on
// a regen. It reinforces the grounding contract already in the prompt; it does
// NOT replace it (the mode/scope no-bet boundaries must stay).
export const REGROUND_ENFORCEMENT =
  "GROUNDING ENFORCEMENT: your previous draft stated numbers that did not come from a tool result. " +
  "Re-answer using ONLY numbers you can read directly from the tool results provided in this turn. " +
  "If you cannot ground a number, do not state it. If the game has no qualifying edge or you lack the data, " +
  "say plainly: no clean read, no bet — and explain the discipline. Do not invent any figure.";

// Single NO-TOOLS rewrite on a grounding-guard failure. Replaces the old second
// full up-to-6-iteration tool loop (the 504 root cause: two stacked loops + a
// re-run of the 4 Turso pre-fetch reads). Because there are no tools, the model
// cannot fetch a fresh number to fabricate-and-ground; it re-answers off the data
// already read. The caller re-runs checkGrounding on the SAME haystack
// (priorToolResultTexts) and, on a second failure, falls back.
export async function regroundLaneB(
  league: InScopeLeague | StatsLeague,
  userMessage: string,
  priorToolResultTexts: string[],
  mode: "bets" | "stats" = "bets",
  scope: "matchup" | "slate" = "matchup",
  client = getAnthropic()
): Promise<{ reply: string }> {
  const system = buildLaneBSystemPrompt(league, scope, mode);
  const reply = await noToolsAnswer(
    client,
    system,
    userMessage,
    priorToolResultTexts,
    REGROUND_ENFORCEMENT
  );
  return { reply };
}
