// Smoke test: write a row through Prisma+Turso, read it back, delete it.
// Confirms the libSQL adapter is wired correctly end-to-end.

import { config } from "dotenv";
config();

import { prisma } from "../src/lib/prisma";

async function main() {
  console.log("inserting test pick...");
  const pick = await prisma.agentPick.create({
    data: {
      runId: "smoke_turso",
      league: "NBA",
      gameDate: new Date(),
      matchup: "Smoke Test vs Turso",
      market: "moneyline",
      selection: "Smoke Test",
      oddsAmerican: -110,
      modelProb: 0.55,
      marketProb: 0.524,
      edge: 0.026,
      kellyStakeUnits: 0.5,
      confidence: 60,
      thesis: "If you can read this from Turso, the adapter is working end-to-end and we have shared state across local/Railway/Actions.",
      invalidation: "schema mismatch or auth failure",
      signals: JSON.stringify(["smoke", "turso"]),
      toolsUsed: JSON.stringify([]),
      modelId: "smoke",
    },
  });
  console.log(`inserted pick #${pick.id}`);

  const fetched = await prisma.agentPick.findUnique({ where: { id: pick.id } });
  console.log(`fetched: ${fetched?.matchup}`);

  await prisma.agentPick.delete({ where: { id: pick.id } });
  console.log(`cleaned up pick #${pick.id}`);

  const count = await prisma.agentPick.count();
  console.log(`total picks in Turso: ${count}`);
}

main()
  .catch(err => {
    console.error("FAILED:", err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
