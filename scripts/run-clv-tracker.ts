// Capture closing line value for pending picks.
//
// Reads pre-scraped FanDuel + Bovada odds from data/processed/latest-odds-api-*.json
// (refreshed by `npm run ingest:odds`). Primary scheduler is agent-clv.yml,
// which runs `ingest:odds` then `picks:clv` every 20 minutes during peak
// game hours. Optional args:
//   tsx scripts/run-clv-tracker.ts            (default 10–90 min pre-game)
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
