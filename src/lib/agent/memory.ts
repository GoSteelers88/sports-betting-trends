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
      (m, i) =>
        `${i + 1}. [${m.type} · ${m.scope} · weight ${m.weight.toFixed(2)}] ${m.rule}\n   reasoning: ${m.reasoning}`
    )
    .join("\n");
}
