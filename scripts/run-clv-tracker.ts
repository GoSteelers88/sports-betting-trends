// Capture closing line value for pending picks.
//
// The primary path is now /api/cron/clv-capture firing every 5 minutes via
// Vercel Cron, using a tight 2–12 minute pre-tip-off window. This script
// remains as a manual / CI fallback. Optional args:
//   tsx scripts/run-clv-tracker.ts            (default 2–12 min pre-game)
//   tsx scripts/run-clv-tracker.ts 5 30       (custom min/max in minutes)
import { config } from "dotenv";
config();

import { captureClv } from "../src/lib/clv-tracker";

async function main() {
  const minBeforeStart = process.argv[2] ? parseInt(process.argv[2], 10) : undefined;
  const maxBeforeStart = process.argv[3] ? parseInt(process.argv[3], 10) : undefined;
  const result = await captureClv({ minBeforeStart, maxBeforeStart });
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch(err => {
    console.error("FAILED:", err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
