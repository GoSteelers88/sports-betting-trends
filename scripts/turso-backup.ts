// Nightly Turso backup. Dumps every key table to a JSON file so a Turso
// outage or accidental schema migration can't lose pick history. The file
// is committed back to the repo (gitignored if you want — but we want it
// versioned for forensics).
//
// Usage: npm run db:backup
//   Output: data/backups/turso-YYYY-MM-DD.json

import { config } from "dotenv";
config();

import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/prisma";

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const outDir = path.resolve(process.cwd(), "data/backups");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `turso-${today}.json`);

  console.log("Dumping AgentPick...");
  const picks = await prisma.agentPick.findMany({ orderBy: { id: "asc" } });
  console.log("Dumping AgentOutcome...");
  const outcomes = await prisma.agentOutcome.findMany({ orderBy: { id: "asc" } });
  console.log("Dumping AgentRun...");
  const runs = await prisma.agentRun.findMany({ orderBy: { id: "asc" } });
  console.log("Dumping AgentMemory...");
  const memories = await prisma.agentMemory.findMany({ orderBy: { id: "asc" } });
  console.log("Dumping AgentDreamRun...");
  const dreamRuns = await prisma.agentDreamRun.findMany({ orderBy: { id: "asc" } });
  console.log("Dumping ModelPickSnapshot...");
  const snapshots = await prisma.modelPickSnapshot.findMany({ orderBy: { id: "asc" } });

  const dump = {
    backupDate: today,
    capturedAt: new Date().toISOString(),
    counts: {
      AgentPick: picks.length,
      AgentOutcome: outcomes.length,
      AgentRun: runs.length,
      AgentMemory: memories.length,
      AgentDreamRun: dreamRuns.length,
      ModelPickSnapshot: snapshots.length,
    },
    AgentPick: picks,
    AgentOutcome: outcomes,
    AgentRun: runs,
    AgentMemory: memories,
    AgentDreamRun: dreamRuns,
    ModelPickSnapshot: snapshots,
  };

  fs.writeFileSync(outFile, JSON.stringify(dump, null, 2));
  console.log(`✓ Wrote backup to ${outFile}`);
  console.log("Counts:", JSON.stringify(dump.counts, null, 2));

  // Cleanup: keep last 30 backups, delete older
  const allBackups = fs.readdirSync(outDir).filter(f => f.startsWith("turso-") && f.endsWith(".json")).sort();
  if (allBackups.length > 30) {
    const toDelete = allBackups.slice(0, allBackups.length - 30);
    for (const f of toDelete) {
      fs.unlinkSync(path.join(outDir, f));
      console.log(`Cleaned old backup: ${f}`);
    }
  }
}

main()
  .catch(err => {
    console.error("FAILED:", err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
