// Idempotently seed the durable, pre-validated parlay learnings into
// AgentMemory. Safe to run repeatedly (e.g. on deploy or after a DB reset) —
// each learning is inserted only if no active row with the same rule text
// already exists. The weekly dream also seeds these at the start of its run, so
// this script is mainly for seeding outside the dream cadence.
//
//   npm run agent:seed-parlay
import { config } from "dotenv";
config();

import { seedParlayLearnings, PARLAY_LEARNINGS } from "../src/lib/agent/memory";

async function main() {
  const { inserted, skipped } = await seedParlayLearnings();
  console.log(
    `[seed-parlay-learnings] ${PARLAY_LEARNINGS.length} durable learnings: ` +
      `${inserted} inserted, ${skipped} already present.`,
  );
}

main().catch((e) => {
  console.error("[seed-parlay-learnings] FAILED:", e);
  process.exit(1);
});
