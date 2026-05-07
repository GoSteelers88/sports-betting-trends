import crypto from "node:crypto";
import { getAnthropic, MODELS } from "./client";
import {
  TOOL_DEFINITIONS,
  TOOL_HANDLERS,
  ToolName,
  AgentLeague,
} from "./tools";
import { getActiveMemoriesForScope, formatMemoriesForPrompt } from "./memory";
import { gradePicks, GradedPick } from "./grader";
import { prisma } from "@/lib/prisma";

// ─── Pick shape returned by the analyst ────────────────────────────────────

export type AnalystPick = {
  matchup: string;
  market: "moneyline" | "spread" | "total" | "prop";
  selection: string;
  oddsAmerican: number;
  modelProb: number; // 0-1
  marketProb: number; // 0-1
  edge: number; // modelProb - marketProb
  kellyStakeUnits: number; // capped 1/4 Kelly, max 2u
  confidence: number; // 1-100
  thesis: string;
  invalidation: string;
  signals: string[];
  // ISO 8601 datetime for the actual game (commence_time from the odds feed).
  // Required so the autograder + idempotency unique key target the right game,
  // not the pick's persistence-time. Optional in older payloads — falls back
  // to today UTC midnight if missing (with a warning logged).
  gameTime?: string;
};

export type AnalyzeResult = {
  runId: string;
  league: AgentLeague;
  modelId: string;
  picks: GradedPick[];
  toolsUsed: ToolName[];
  rawResponseText: string;
  iterations: number;
};

// ─── Prompts ───────────────────────────────────────────────────────────────

function systemPrompt(league: AgentLeague, memoryBlock: string): string {
  return `You are a sharp, disciplined sports-betting analyst working on ${league}.

Your job: produce a small ranked list of bets for today's slate, each with explicit reasoning, EV, and an invalidation level. Quality over quantity. Pass on slates with no edge.

You have tools that read today's odds, in-house model probabilities, injuries, player props, and league trend summaries. Always start by calling tools — never invent numbers. Call multiple tools in parallel when independent.

When picking, follow these rules:
- Only recommend a bet if your modelProb exceeds the market's implied prob by ≥ 3% (300 bps). Otherwise pass.
- Use 1/4 Kelly for stake sizing, capped at 2 units per bet. Kelly = (b·p - q)/b where b = decimal odds - 1.
- Each pick must have: matchup, market, selection, oddsAmerican, modelProb, marketProb, edge, kellyStakeUnits, confidence (1-100), thesis (2-4 sentences), invalidation (one sentence), signals (array of short strings), AND gameTime (ISO 8601 from get_odds tool's commence_time field).
- Round modelProb and marketProb to 4 decimals; round kellyStakeUnits to 2 decimals.
- Always copy gameTime exactly from the get_odds tool's commenceTime for that event. This is critical for grading.

Past learnings from prior dreams (apply unless they contradict today's specific data):
${memoryBlock}

When you are done analyzing, return ONLY a JSON object on the final assistant turn with this exact shape — no prose, no markdown fences:
{ "picks": [ ...AnalystPick objects... ] }

If you find no qualifying bets, return { "picks": [] }.`;
}

const MAX_ITERATIONS = 8;

// ─── Analyst run ───────────────────────────────────────────────────────────

export async function analyze(league: AgentLeague): Promise<AnalyzeResult> {
  const client = getAnthropic();
  const runId = `run_${crypto.randomBytes(8).toString("hex")}`;
  const memories = await getActiveMemoriesForScope(league);
  const sys = systemPrompt(league, formatMemoriesForPrompt(memories));

  const messages: Array<{
    role: "user" | "assistant";
    content: unknown;
  }> = [
    {
      role: "user",
      content: `Analyze today's ${league} slate and return your picks as JSON.`,
    },
  ];

  const toolsUsed: ToolName[] = [];
  let iterations = 0;
  let finalText = "";

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const response = await client.messages.create({
      model: MODELS.analyst,
      max_tokens: 4096,
      system: sys,
      tools: TOOL_DEFINITIONS,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: messages as any,
    });

    // Push assistant turn so the next iteration sees it
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
          toolsUsed.push(name);
          const handler = TOOL_HANDLERS[name];
          let result: unknown = { error: `unknown tool: ${name}` };
          if (handler) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              result = handler(block.input as any);
            } catch (err) {
              result = { error: err instanceof Error ? err.message : String(err) };
            }
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result).slice(0, 200_000),
          });
        }
      }

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // Final turn — collect text
    for (const block of response.content) {
      if (block.type === "text") finalText += block.text;
    }
    break;
  }

  const parsed = parsePicks(finalText);
  const graded = gradePicks(parsed);

  // NOTE: persistence intentionally moved to the orchestrator's persistFinalPicks()
  // call, which runs AFTER the critic + bankroll guard. This prevents picks the
  // critic killed (or bankroll dropped) from polluting the dream agent's
  // training data and the dashboard's pick count.
  return {
    runId,
    league,
    modelId: MODELS.analyst,
    picks: graded,
    toolsUsed,
    rawResponseText: finalText,
    iterations,
  };
}

// Persist the final picks (post-critic, post-bankroll). Idempotent across
// retries via @@unique([league, gameDate, market, selection]) — duplicate
// inserts are silently skipped. Counts of inserted vs skipped returned for
// observability.
export async function persistFinalPicks(args: {
  runId: string;
  league: string;
  finalPicks: GradedPick[];
  toolsUsed: ToolName[];
}): Promise<{ ids: number[]; skipped: number }> {
  const ids: number[] = [];
  let skipped = 0;
  for (const p of args.finalPicks) {
    // Use the actual game time (commenceTime from odds feed) so:
    //   1. the autograder's 36h proximity match targets the right game day
    //   2. the @@unique key correctly distinguishes doubleheaders (same matchup,
    //      different times) from re-runs of the same pick.
    let gameDate: Date;
    if (p.gameTime) {
      const parsed = new Date(p.gameTime);
      gameDate = Number.isFinite(parsed.getTime()) ? parsed : fallbackGameDate();
    } else {
      console.warn(`persistFinalPicks: pick missing gameTime, falling back to today UTC midnight: ${p.matchup}`);
      gameDate = fallbackGameDate();
    }
    try {
      const created = await prisma.agentPick.create({
        data: {
          runId: args.runId,
          league: args.league,
          gameDate,
          matchup: p.matchup,
          market: p.market,
          selection: p.selection,
          oddsAmerican: p.oddsAmerican,
          modelProb: p.modelProb,
          marketProb: p.marketProb,
          edge: p.edge,
          kellyStakeUnits: p.kellyStakeUnits,
          confidence: p.confidence,
          thesis: p.thesis,
          invalidation: p.invalidation,
          signals: JSON.stringify(p.signals),
          toolsUsed: JSON.stringify(args.toolsUsed),
          modelId: MODELS.analyst,
        },
      });
      ids.push(created.id);
    } catch (err) {
      // Prisma throws P2002 on unique-constraint violation — that's our
      // idempotency working as intended. Other errors propagate.
      const code = (err as { code?: string })?.code;
      if (code === "P2002") {
        skipped++;
        continue;
      }
      throw err;
    }
  }
  return { ids, skipped };
}

// Fallback when an analyst pick is missing gameTime — pin to today UTC noon
// so we end up in the right calendar day rather than midnight (which lands
// in yesterday for west-coast viewers). Should be rare with the updated prompt.
function fallbackGameDate(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12));
}

// Strip optional ```json fences and parse
function parsePicks(text: string): AnalystPick[] {
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  // Find first '{' to last '}' to isolate JSON if model added stray text
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) cleaned = cleaned.slice(first, last + 1);

  try {
    const parsed = JSON.parse(cleaned) as { picks?: AnalystPick[] };
    return Array.isArray(parsed.picks) ? parsed.picks : [];
  } catch {
    return [];
  }
}
