// Run the snapshot grader for the given days back. Idempotent.
// Usage: npm run picks:grade -- [daysBack=1]

import { config } from "dotenv";
config();

import { gradeAllSnapshots } from "../src/lib/snapshot-grader";

async function main() {
  const daysBack = parseInt(process.argv[2] ?? "1", 10);
  const report = await gradeAllSnapshots(daysBack);
  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch(err => {
    console.error("FAILED:", err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
