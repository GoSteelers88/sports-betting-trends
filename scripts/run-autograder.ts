// Manual auto-grader run. Usage: npm run agent:grade -- [daysBack]
import { config } from "dotenv";
config();

import { autoGradeYesterday } from "../src/lib/agent/autograder";
import { notifyGraderReport } from "../src/lib/agent/notify";

async function main() {
  const daysBack = parseInt(process.argv[2] ?? "1", 10);
  const report = await autoGradeYesterday(daysBack);
  console.log(JSON.stringify(report, null, 2));
  await notifyGraderReport(report);
}

main();
