// Weekly memory consolidation. Reads recent picks + their graded outcomes,
// asks Claude to merge duplicates, replace stale rules, and surface new
// patterns. Writes back to AgentMemory and records the run in AgentDreamRun.

import { prisma } from "@/lib/prisma";
import { getAnthropic, MODELS } from "./client";
import { getParlayLedgerView } from "@/lib/parlay-paper";
import {
  PARLAY_LEARNINGS,
  PARLAY_LEARNING_TYPE,
  seedParlayLearnings,
  QUANT_DESK_LEARNING_TYPE,
  seedQuantDeskLearnings,
} from "./memory";
import { readQuantDeskForDream } from "@/lib/quant-desk/dream-input";

export type DreamResult = {
  dreamRunId: number;
  picksReviewed: number;
  memoriesAdded: number;
  memoriesRetired: number;
  notes: string;
};

const DREAM_LOOKBACK_DAYS = 30; // matches the paper-trial window so dream sees the full record

const DREAM_SYSTEM = `You are an analytical reviewer consolidating an agent's memory store.

You will receive:
- The agent's currently active learnings (with weights and reasoning)
- A list of recent picks the agent made, each with its graded outcome (win/loss/push/pending)
- A "pipelineRecord" summary of how the orchestrator has performed across all runs:
  total runs, raw analyst picks, grader-kept, critic-killed, bankroll-dropped,
  final picks shipped, parse-failure runs. Use this to calibrate confidence in
  any rule you propose — small samples (e.g. <30 graded outcomes) deserve
  weight ≤0.5, never higher.
- A "marketModelComparison" of how the model-derived picks (ModelPickSnapshot)
  performed alongside the bot picks. If model picks consistently beat bot
  picks, surface that as a rule for the analyst to lean on those signals.
- A "quantDesk" block: THE QUANT DESK (Benter/Benham/Bloom) — the MLB live paper
  book's equity + CLV (the HEADLINE metric), the private NFL dry-run record, the
  coverage-audit DATA-ACQUISITION BACKLOG (which missing stat would add the most
  edge), and the top DISCOVERED CORRELATIONS (quarantined hypotheses). Reflect on
  it: is the desk getting CLV (beat-rate >=55% and avg >= +2c at n>=50 = real,
  else kill)? Which missing stat should we acquire first? Which discovered
  correlation is worth validating out-of-sample next? Discovered correlations are
  HYPOTHESES — you may NOTE one as worth validating, but NEVER propose promoting
  one into the model in-sample. Treat clvSettledCount < 50 as preliminary.
  NOTE: the quant desk is now ANALYST-VISIBLE — the live MLB analyst calls
  get_quant_desk_analysis each run and treats open plays as a corroborating
  signal. If the desk's open plays and the analyst's MLB picks consistently
  AGREE and that subset out-performs the analyst's solo picks, surface a rule
  to lean on desk corroboration; if they consistently DISAGREE and the desk
  wins on CLV, surface that too. The NFL dry-run now ALSO covers player props
  (QB pass yds/TDs, RB rush yds, WR/TE rec yds/TDs) on the same leak-free
  1-week-a-day loop — reflect on the prop dry-run's edge distribution the same
  way you reflect on the NFL game dry-run (it's a research signal, not a live
  book; ROI is an optimistic upper bound, the edge distribution is the signal).
- A "parlayPerformance" block: the live parlay paper book's realized record
  (Exp 4) — equity, realized P&L, yield, win rate, settled/open counts, avg
  parlay EV — plus the durable parlay learnings we already proved out
  (favorites-not-longshots, the +EV-per-leg floor, distinct-uncorrelated games,
  and how estimation error compounds in a 3-leg parlay). Reflect on it: does the
  live book corroborate or contradict the durable learnings? Treat small samples
  (settled < 30) as preliminary — observe, do not over-claim.

Your job: produce an updated memory store. Specifically:
1. Identify recurring failure patterns (e.g. "underperforms on road favorites in MLB" if multiple losses fit)
2. Identify confirmed wins worth weighting up
3. Mark contradicted or stale rules as retired
4. Merge duplicates
5. Add new rules where evidence justifies them
6. Reflect on parlay performance: if the live parlay book and the durable
   learnings agree, you may ADD a reinforcing rule (cite the book's yield + n).
   If they appear to disagree at a meaningful sample, NOTE it — but be
   conservative below n=30 settled.

Each rule must be:
- Specific and actionable (a future analyst should be able to apply it)
- Backed by at least 3 picks of evidence, OR be a refinement of an existing rule
- Honest about uncertainty (use "weight" 0.3-0.5 for tentative, 0.7-0.9 for confirmed)

HARD CONSTRAINT — do NOT retire rules whose type is "${PARLAY_LEARNING_TYPE}" or
"${QUANT_DESK_LEARNING_TYPE}". Those are durable, pre-validated learnings (parlay
construction and the QUANT DESK doctrine), not window-induced rules; the rolling
30-day pick window cannot contradict them. You may reinforce them by ADDING a new
rule, but never put a "${PARLAY_LEARNING_TYPE}" or "${QUANT_DESK_LEARNING_TYPE}"
rule id in the "retire" array.

Return ONLY a JSON object with this exact shape, no markdown:
{
  "add": [
    { "type": "rule|pattern|bias|correction", "scope": "ALL|NBA|MLB|NCAAB", "rule": "...", "reasoning": "...", "weight": 0.7, "evidencePickIds": [1, 5, 9] }
  ],
  "retire": [
    { "id": 12, "reasoning": "contradicted by 4 recent picks (ids 88, 91, 95, 102)" }
  ],
  "notes": "1-2 sentence summary of what changed and why (include a clause on the parlay book if it has settled parlays)"
}`;

export async function dream(): Promise<DreamResult> {
  const client = getAnthropic();

  const dreamRun = await prisma.agentDreamRun.create({
    data: { status: "running", modelId: MODELS.dream },
  });

  try {
    // Ensure the durable parlay learnings exist before we read the active
    // memory set — idempotent, so re-runs are no-ops. This guarantees the
    // analyst (and this consolidation) always have the validated parlay rules
    // in AgentMemory, even on a fresh DB or before the first weekly dream.
    await seedParlayLearnings();
    // Same for the durable QUANT DESK doctrine (non-retirable guardrails).
    await seedQuantDeskLearnings();

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

    // Pipeline-record snapshot: tells the dream agent how its decisions have
    // shaped output volume, so it can calibrate rule confidence and refuse to
    // make claims on small samples.
    const runs = await prisma.agentRun.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
    });
    const runStats = runs.reduce(
      (acc, r) => ({
        runs: acc.runs + 1,
        rawAnalystPicks: acc.rawAnalystPicks + r.rawAnalystPicks,
        graderKept: acc.graderKept + r.graderKept,
        criticKilled: acc.criticKilled + r.criticKilled,
        criticWeakened: acc.criticWeakened + r.criticWeakened,
        bankrollDropped: acc.bankrollDropped + r.bankrollDropped,
        finalShipped: acc.finalShipped + r.finalPickCount,
        parseFailedRuns: acc.parseFailedRuns + (r.parseFailed ? 1 : 0),
      }),
      { runs: 0, rawAnalystPicks: 0, graderKept: 0, criticKilled: 0, criticWeakened: 0, bankrollDropped: 0, finalShipped: 0, parseFailedRuns: 0 }
    );

    // Model snapshot performance across the same window
    const modelSnapshots = await prisma.modelPickSnapshot.findMany({
      where: { createdAt: { gte: since }, result: { not: null } },
    });
    const modelStats = modelSnapshots.reduce(
      (acc, s) => ({
        total: acc.total + 1,
        wins: acc.wins + (s.result === "win" ? 1 : 0),
        losses: acc.losses + (s.result === "loss" ? 1 : 0),
        bySource: { ...acc.bySource, [s.source]: (acc.bySource[s.source] ?? 0) + (s.result === "win" ? 1 : 0) },
      }),
      { total: 0, wins: 0, losses: 0, bySource: {} as Record<string, number> }
    );

    // Parlay paper book (Exp 4) record + the durable learnings. Best-effort:
    // a missing/corrupt book degrades to a stub so the consolidation never
    // fails on a side input. This is a READ — the dream reflects on the book,
    // it never opens or settles parlays.
    const parlayPerformance = readParlayPerformance();

    // THE QUANT DESK block — the desk's learning brain reads its own ledger +
    // CLV, the NFL dry-run, the coverage backlog, and the discovered
    // correlations. Best-effort: never fails the dream on a side input.
    let quantDesk: ReturnType<typeof readQuantDeskForDream> | { note: string } ;
    try {
      quantDesk = readQuantDeskForDream();
    } catch {
      quantDesk = { note: "Quant desk artifacts unavailable this run — reflecting on doctrine only." };
    }

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
        pipelineRecord: runStats,
        marketModelComparison: modelStats,
        parlayPerformance,
        quantDesk,
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
      // Defense-in-depth: never retire a durable parlay-learning row, even if
      // the LLM ignores the system-prompt constraint. The updateMany's WHERE
      // excludes that type, so a stray id targeting one is a guaranteed no-op.
      const result = await prisma.agentMemory.updateMany({
        where: {
          id: r.id,
          active: true,
          type: { notIn: [PARLAY_LEARNING_TYPE, QUANT_DESK_LEARNING_TYPE] },
        },
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

// Read the parlay paper book's record (Exp 4) plus the durable learnings, in a
// shape the dream LLM can reflect on. Best-effort: any failure to read the book
// degrades to a stub with the learnings still attached, so the dream always has
// the validated lessons even before the live book has settled parlays.
function readParlayPerformance() {
  const durableLearnings = PARLAY_LEARNINGS.map(l => ({ rule: l.rule, weight: l.weight }));
  try {
    const view = getParlayLedgerView();
    return {
      note:
        "Exp 4 parlay paper book — realized record below. Metric is YIELD (P&L/staked), not win rate (most parlays lose by design). Treat settled < 30 as preliminary.",
      stats: {
        equityUsd: view.stats.equityUsd,
        realizedPnlUsd: view.stats.realizedPnlUsd,
        yieldPct: view.stats.yieldPct,
        roiPct: view.stats.roiPct,
        winRatePct: view.stats.winRatePct,
        settledCount: view.stats.settledCount,
        openCount: view.stats.openCount,
        wins: view.stats.wins,
        losses: view.stats.losses,
        voids: view.stats.voids,
        avgParlayEv: view.stats.avgParlayEv,
      },
      config: view.config,
      durableLearnings,
    };
  } catch {
    return {
      note: "Parlay paper book unavailable this run — reflecting on durable learnings only.",
      stats: null,
      config: null,
      durableLearnings,
    };
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
