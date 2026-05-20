import "dotenv/config";
import { prisma as db } from "@/lib/prisma";

async function main() {
  const since = new Date("2026-05-06T00:00:00Z");

  // CLV samples
  const clv = await db.agentPick.findMany({
    where: { clvCents: { not: null } },
    select: { id: true, gameDate: true, matchup: true, selection: true, oddsAmerican: true, closingOddsAmerican: true, clvCents: true, clvCapturedAt: true, outcome: { select: { result: true } } },
    orderBy: { clvCapturedAt: "desc" },
  });
  console.log(`\n=== CLV samples since trial start ===`);
  console.log(`Total captured: ${clv.length}`);
  for (const c of clv) {
    console.log(`  pick#${c.id}  ${c.matchup}  picked=${c.oddsAmerican}  closed=${c.closingOddsAmerican}  CLV=${c.clvCents}¢  capturedAt=${c.clvCapturedAt?.toISOString()}  -> ${c.outcome?.result ?? "pending"}`);
  }

  // Dream runs
  const dreams = await db.agentDreamRun.findMany({
    where: { startedAt: { gte: since } },
    orderBy: { startedAt: "desc" },
  });
  console.log(`\n=== AgentDreamRun rows since trial start ===`);
  console.log(`Total: ${dreams.length}`);
  for (const d of dreams) {
    console.log(`  ${d.startedAt.toISOString()}  status=${d.status}  reviewed=${d.picksReviewed}  added=${d.memoriesAdded}  retired=${d.memoriesRetired}  err=${d.error?.slice(0, 80) ?? "-"}`);
  }

  // AgentMemory rows
  const memories = await db.agentMemory.findMany({
    orderBy: { createdAt: "desc" },
  });
  console.log(`\n=== AgentMemory rows (all) ===`);
  console.log(`Total: ${memories.length}`);
  const byScope = new Map<string, number>();
  const byType = new Map<string, number>();
  const activeCount = memories.filter((m) => m.active).length;
  for (const m of memories) {
    byScope.set(m.scope, (byScope.get(m.scope) ?? 0) + 1);
    byType.set(m.type, (byType.get(m.type) ?? 0) + 1);
  }
  console.log(`Active: ${activeCount}`);
  console.log(`By scope:`, Object.fromEntries(byScope));
  console.log(`By type:`, Object.fromEntries(byType));
  console.log(`\nLast 10 memory rows:`);
  for (const m of memories.slice(0, 10)) {
    console.log(`  [${m.active ? "ON " : "off"}] ${m.type}/${m.scope}  w=${m.weight}  ${m.rule.slice(0, 80)}`);
  }

  await db.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
