// Run the picks-logger end-to-end. Reads latest-summary.json and
// latest-player-props.json, upserts ModelPickSnapshot rows.
// Used by the agent-run.yml workflow.

import { config } from "dotenv";
config();

import { logTodaysSnapshots } from "../src/lib/picks-logger";

async function main() {
  const result = await logTodaysSnapshots();
  console.log(JSON.stringify(result, null, 2));
  if (result.errors.length > 0) {
    console.error(`completed with ${result.errors.length} errors`);
  }
}

main()
  .catch(err => {
    console.error("FAILED:", err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
