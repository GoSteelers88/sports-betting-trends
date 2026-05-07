import { prisma } from "@/lib/prisma";

export type ActiveMemory = {
  id: number;
  type: string;
  scope: string;
  rule: string;
  reasoning: string;
  weight: number;
};

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
