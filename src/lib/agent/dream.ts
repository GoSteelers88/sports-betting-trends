// Weekly memory consolidation. Reads recent picks + their graded outcomes,
// asks Claude to merge duplicates, replace stale rules, and surface new
// patterns. Writes back to AgentMemory and records the run in AgentDreamRun.

import { prisma } from "@/lib/prisma";
import { getAnthropic, MODELS } from "./client";

export type DreamResult = {
  dreamRunId: number;
  picksReviewed: number;
  memoriesAdded: number;
  memoriesRetired: number;
  notes: string;
};

const DREAM_LOOKBACK_DAYS = 14;

const DREAM_SYSTEM = `You are an analytical reviewer consolidating an agent's memory store.

You will receive:
- The agent's currently active learnings (with weights and reasoning)
- A list of recent picks the agent made, each with its graded outcome (win/loss/push/pending)

Your job: produce an updated memory store. Specifically:
1. Identify recurring failure patterns (e.g. "underperforms on road favorites in MLB" if multiple losses fit)
2. Identify confirmed wins worth weighting up
3. Mark contradicted or stale rules as retired
4. Merge duplicates
5. Add new rules where evidence justifies them

Each rule must be:
- Specific and actionable (a future analyst should be able to apply it)
- Backed by at least 3 picks of evidence, OR be a refinement of an existing rule
- Honest about uncertainty (use "weight" 0.3-0.5 for tentative, 0.7-0.9 for confirmed)

Return ONLY a JSON object with this exact shape, no markdown:
{
  "add": [
    { "type": "rule|pattern|bias|correction", "scope": "ALL|NBA|MLB|NCAAB", "rule": "...", "reasoning": "...", "weight": 0.7, "evidencePickIds": [1, 5, 9] }
  ],
  "retire": [
    { "id": 12, "reasoning": "contradicted by 4 recent picks (ids 88, 91, 95, 102)" }
  ],
  "notes": "1-2 sentence summary of what changed and why"
}`;

export async function dream(): Promise<DreamResult> {
  const client = getAnthropic();

  const dreamRun = await prisma.agentDreamRun.create({
    data: { status: "running", modelId: MODELS.dream },
  });

  try {
    const since = new Date(Date.now() - DREAM_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

    const picks = await prisma.agentPick.findMany({
      where: { createdAt: { gte: since } },
      include: { outcome: true },
      orderBy: { createdAt: "asc" },
    });

    const memories = await prisma.agentMemory.findMany({
      where: { active: true },
      orderBy: { weight: "desc" },
    });

    const userPayload = JSON.stringify(
      {
        currentMemories: memories.map(m => ({
          id: m.id,
          type: m.type,
          scope: m.scope,
          rule: m.rule,
          reasoning: m.reasoning,
          weight: m.weight,
          createdAt: m.createdAt.toISOString(),
        })),
        recentPicks: picks.map(p => ({
          id: p.id,
          league: p.league,
          matchup: p.matchup,
          market: p.market,
          selection: p.selection,
          oddsAmerican: p.oddsAmerican,
          modelProb: p.modelProb,
          marketProb: p.marketProb,
          edge: p.edge,
          stake: p.kellyStakeUnits,
          confidence: p.confidence,
          thesis: p.thesis,
          outcome: p.outcome
            ? { result: p.outcome.result, unitsPnl: p.outcome.unitsPnl, notes: p.outcome.notes }
            : null,
        })),
      },
      null,
      2
    );

    const response = await client.messages.create({
      model: MODELS.dream,
      max_tokens: 4096,
      system: DREAM_SYSTEM,
      messages: [{ role: "user", content: userPayload }],
    });

    let text = "";
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
    }

    const parsed = parseDreamOutput(text);

    let added = 0;
    let retired = 0;

    for (const a of parsed.add ?? []) {
      await prisma.agentMemory.create({
        data: {
          type: a.type,
          scope: a.scope,
          rule: a.rule,
          reasoning: a.reasoning,
          weight: clamp(a.weight ?? 0.5, 0, 1),
          evidence: JSON.stringify(a.evidencePickIds ?? []),
          active: true,
        },
      });
      added++;
    }

    for (const r of parsed.retire ?? []) {
      const result = await prisma.agentMemory.updateMany({
        where: { id: r.id, active: true },
        data: { active: false },
      });
      if (result.count > 0) retired++;
    }

    await prisma.agentDreamRun.update({
      where: { id: dreamRun.id },
      data: {
        endedAt: new Date(),
        status: "completed",
        picksReviewed: picks.length,
        memoriesAdded: added,
        memoriesRetired: retired,
        notes: parsed.notes ?? null,
      },
    });

    return {
      dreamRunId: dreamRun.id,
      picksReviewed: picks.length,
      memoriesAdded: added,
      memoriesRetired: retired,
      notes: parsed.notes ?? "",
    };
  } catch (err) {
    await prisma.agentDreamRun.update({
      where: { id: dreamRun.id },
      data: {
        endedAt: new Date(),
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

type DreamOutput = {
  add?: Array<{
    type: string;
    scope: string;
    rule: string;
    reasoning: string;
    weight?: number;
    evidencePickIds?: number[];
  }>;
  retire?: Array<{ id: number; reasoning: string }>;
  notes?: string;
};

function parseDreamOutput(text: string): DreamOutput {
  let cleaned = text.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) cleaned = fence[1].trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) cleaned = cleaned.slice(first, last + 1);
  try {
    return JSON.parse(cleaned) as DreamOutput;
  } catch {
    return {};
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
