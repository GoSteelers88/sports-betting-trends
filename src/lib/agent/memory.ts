import { prisma } from "@/lib/prisma";

export type ActiveMemory = {
  id: number;
  type: string;
  scope: string;
  rule: string;
  reasoning: string;
  weight: number;
};

export type RecentRecord = {
  windowDays: number;
  total: number;
  wins: number;
  losses: number;
  pushes: number;
  pnlUnits: number;
  roi: number | null;
};

// Pull the agent's record over the last N days (default 7) so the analyst's
// system prompt can include it. Helps the model self-calibrate: a cold streak
// should make it more conservative; a hot streak should not embolden it.
export async function getRecentRecord(
  league: string,
  windowDays = 7
): Promise<RecentRecord> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const rec: RecentRecord = {
    windowDays,
    total: 0,
    wins: 0,
    losses: 0,
    pushes: 0,
    pnlUnits: 0,
    roi: null,
  };
  let totalStake = 0;
  try {
    const outcomes = await prisma.agentOutcome.findMany({
      where: {
        gradedAt: { gte: since },
        result: { in: ["win", "loss", "push"] },
        pick: { league },
      },
      include: { pick: true },
    });
    for (const o of outcomes) {
      rec.total++;
      if (o.result === "win") rec.wins++;
      else if (o.result === "loss") rec.losses++;
      else if (o.result === "push") rec.pushes++;
      rec.pnlUnits += o.unitsPnl ?? 0;
      totalStake += o.pick.kellyStakeUnits;
    }
    if (totalStake > 0) rec.roi = rec.pnlUnits / totalStake;
    rec.pnlUnits = +rec.pnlUnits.toFixed(2);
  } catch {
    // Best-effort — analyst still works without record data
  }
  return rec;
}

export function formatRecordForPrompt(rec: RecentRecord): string {
  if (rec.total === 0) {
    return `(no graded picks in last ${rec.windowDays} days — small-sample mode, be extra conservative)`;
  }
  const decided = rec.wins + rec.losses;
  const winRate = decided > 0 ? `${((rec.wins / decided) * 100).toFixed(1)}%` : "—";
  const roi = rec.roi !== null ? `${(rec.roi * 100).toFixed(1)}%` : "—";
  return `Last ${rec.windowDays} days: ${rec.wins}-${rec.losses}${rec.pushes ? `-${rec.pushes}` : ""} (${winRate} win rate, ${rec.pnlUnits >= 0 ? "+" : ""}${rec.pnlUnits.toFixed(2)}u, ROI ${roi}). Use this honestly: a cold streak means tighten edge requirements; a hot streak does NOT mean loosen them.`;
}

export async function getActiveMemoriesForScope(scope: string): Promise<ActiveMemory[]> {
  const rows = await prisma.agentMemory.findMany({
    where: { active: true, scope: { in: [scope, "ALL"] } },
    orderBy: [{ weight: "desc" }, { updatedAt: "desc" }],
    take: 50,
  });
  return rows.map(r => ({
    id: r.id,
    type: r.type,
    scope: r.scope,
    rule: r.rule,
    reasoning: r.reasoning,
    weight: r.weight,
  }));
}

export function formatMemoriesForPrompt(memories: ActiveMemory[]): string {
  if (memories.length === 0) {
    return "(no learned rules yet — first run)";
  }
  return memories
    .map(
      m =>
        `- id=${m.id} · ${m.type} · ${m.scope} · weight ${m.weight.toFixed(2)}\n  rule: ${m.rule}\n  reasoning: ${m.reasoning}`
    )
    .join("\n");
}

// Latest completed dream's free-form notes — gives the analyst the human-style
// summary of what the consolidator concluded last week, not just the distilled
// rule rows.
export type LatestDreamSummary = {
  startedAt: string;
  picksReviewed: number;
  memoriesAdded: number;
  memoriesRetired: number;
  notes: string | null;
} | null;

export async function getLatestDreamSummary(): Promise<LatestDreamSummary> {
  const dream = await prisma.agentDreamRun.findFirst({
    where: { status: "completed" },
    orderBy: { startedAt: "desc" },
  });
  if (!dream) return null;
  return {
    startedAt: dream.startedAt.toISOString(),
    picksReviewed: dream.picksReviewed,
    memoriesAdded: dream.memoriesAdded,
    memoriesRetired: dream.memoriesRetired,
    notes: dream.notes,
  };
}

// Recent results grouped by team for the analyst's per-team self-awareness.
// Aggregate league record alone wasn't enough signal for the LLM to notice
// the per-team pattern (e.g. Pistons -174 then -184 on consecutive slates,
// both losses) — this surfaces the team trail explicitly.
export type TeamRecentRecord = {
  team: string;
  picks: Array<{
    pickId: number;
    selection: string;
    oddsAmerican: number;
    edge: number;
    gameDate: string;
    result: string;
  }>;
};

export async function getRecentResultsByTeam(
  league: string,
  windowDays = 14
): Promise<TeamRecentRecord[]> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const picks = await prisma.agentPick.findMany({
    where: {
      league,
      gameDate: { gte: since },
      market: "moneyline",
    },
    include: { outcome: true },
    orderBy: { gameDate: "desc" },
  });
  const byTeam = new Map<string, TeamRecentRecord["picks"]>();
  for (const p of picks) {
    if (!p.outcome) continue;
    const list = byTeam.get(p.selection) ?? [];
    list.push({
      pickId: p.id,
      selection: p.selection,
      oddsAmerican: p.oddsAmerican,
      edge: p.edge,
      gameDate: p.gameDate.toISOString().slice(0, 10),
      result: p.outcome.result,
    });
    byTeam.set(p.selection, list);
  }
  // Only surface teams with ≥2 graded picks — singletons don't signal a pattern.
  return [...byTeam.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([team, list]) => ({ team, picks: list }));
}

export function formatTeamRecordsForPrompt(records: TeamRecentRecord[]): string {
  if (records.length === 0) {
    return "(no team has ≥2 graded picks in the window — no per-team patterns to flag)";
  }
  return records
    .map(r => {
      const wins = r.picks.filter(p => p.result === "win").length;
      const losses = r.picks.filter(p => p.result === "loss").length;
      const trail = r.picks
        .slice(0, 5)
        .map(p => `${p.gameDate} ${p.oddsAmerican > 0 ? "+" : ""}${p.oddsAmerican} → ${p.result}`)
        .join(", ");
      return `- ${r.team}: ${wins}-${losses}  [${trail}]`;
    })
    .join("\n");
}
