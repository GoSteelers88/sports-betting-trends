// Devil's Advocate critic. Takes the analyst's picks and tries to kill each
// one. A pick survives only if the critic can't find a strong reason to drop it.
// Runs as a single Sonnet call (one round trip, no tool use) for low latency.

import { getAnthropic, MODELS } from "./client";
import type { GradedPick } from "./grader";
import type { AgentLeague } from "./tools";

export type CritiqueDecision = {
  pickIndex: number; // 0-based index into input array
  verdict: "keep" | "kill" | "weaken";
  reason: string;
  suggestedStakeMultiplier?: number; // for "weaken", e.g. 0.5 to halve
};

export type CritiqueResult = {
  decisions: CritiqueDecision[];
  rawText: string;
  // True when the LLM response could not be parsed into a valid decisions
  // array. The orchestrator treats this as fail-closed: drop ALL picks rather
  // than auto-approve them.
  parseFailed?: boolean;
};

const CRITIC_SYSTEM = `You are a sharp, contrarian sports-betting analyst whose job is to KILL bad picks before they ship.

You will receive an analyst's proposed picks. For each one, your default position is skeptical: assume it's wrong unless the thesis is rock-solid.

Pay special attention to:
- Large model-vs-market gaps (>10pp). 6+ books rarely all miss by 10pp. The analyst's model is probably wrong unless there's a specific, recent reason (key injury, news, weather, lineup change).
- Plus-money longshots with thin theses. Big edges on +200 dogs often mean the model is poorly calibrated for tails.
- Reasoning that cites generic stats (RPG, win rate) rather than specific situational factors.
- Spread/total picks where the model's "expected margin" exceeds the spread by < 2 points (low margin of safety).

Your three verdicts:
- "kill": Drop the pick. Use when the thesis has a specific weakness (model overconfidence, ignored data, math error).
- "weaken": Keep the pick but cut the stake. Use when the edge is real but smaller than claimed. Provide suggestedStakeMultiplier 0.25-0.75.
- "keep": Approve as-is. Reserve for picks with specific, defensible theses.

Be honest. If 4 out of 4 picks should be killed, kill all 4. Discipline matters more than action.

Return ONLY a JSON object, no prose, no markdown:
{
  "decisions": [
    { "pickIndex": 0, "verdict": "keep|kill|weaken", "reason": "...", "suggestedStakeMultiplier": 0.5 }
  ]
}`;

export async function critique(league: AgentLeague, picks: GradedPick[]): Promise<CritiqueResult> {
  if (picks.length === 0) return { decisions: [], rawText: "" };

  const client = getAnthropic();

  const userPayload = JSON.stringify(
    {
      league,
      picks: picks.map((p, i) => ({
        index: i,
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
        signals: p.signals,
      })),
    },
    null,
    2
  );

  const response = await client.messages.create({
    model: MODELS.analyst,
    max_tokens: 2048,
    system: CRITIC_SYSTEM,
    messages: [{ role: "user", content: userPayload }],
  });

  let text = "";
  for (const block of response.content) {
    if (block.type === "text") text += block.text;
  }

  const { decisions, parseFailed } = parseDecisions(text, picks.length);
  // Sanity check: if the critic returned fewer decisions than picks, that's
  // also a fail-closed scenario — we can't trust auto-keep on missing indexes.
  const undercount = decisions.length < picks.length;
  return {
    decisions,
    rawText: text,
    parseFailed: parseFailed || undercount,
  };
}

export function applyCritiqueToPicks(
  picks: GradedPick[],
  decisions: CritiqueDecision[]
): { kept: GradedPick[]; killed: Array<{ pick: GradedPick; reason: string }> } {
  const kept: GradedPick[] = [];
  const killed: Array<{ pick: GradedPick; reason: string }> = [];

  for (let i = 0; i < picks.length; i++) {
    const decision = decisions.find(d => d.pickIndex === i);
    if (!decision) {
      kept.push(picks[i]);
      continue;
    }
    if (decision.verdict === "kill") {
      killed.push({ pick: picks[i], reason: decision.reason });
      continue;
    }
    if (decision.verdict === "weaken") {
      // Clamp to system-prompt range (0.25-0.75). A returned 1.0 should be
      // treated as no-op weaken rather than silently kept at full stake.
      const mult = clamp(decision.suggestedStakeMultiplier ?? 0.5, 0.25, 0.75);
      kept.push({
        ...picks[i],
        kellyStakeUnits: +(picks[i].kellyStakeUnits * mult).toFixed(2),
        graderNotes: [...picks[i].graderNotes, `critic weakened: ${decision.reason} (×${mult})`],
      });
      continue;
    }
    kept.push(picks[i]);
  }
  return { kept, killed };
}

function parseDecisions(
  text: string,
  expectedCount: number
): { decisions: CritiqueDecision[]; parseFailed: boolean } {
  let cleaned = text.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) cleaned = fence[1].trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) cleaned = cleaned.slice(first, last + 1);
  try {
    const parsed = JSON.parse(cleaned) as { decisions?: CritiqueDecision[] };
    const arr = Array.isArray(parsed.decisions) ? parsed.decisions.slice(0, expectedCount) : [];
    return { decisions: arr, parseFailed: !Array.isArray(parsed.decisions) };
  } catch {
    return { decisions: [], parseFailed: true };
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
