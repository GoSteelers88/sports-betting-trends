// Capture closing line value for pending picks. Run periodically (every 30min
// during game-day) to snapshot closing odds before games tip off.
import { config } from "dotenv";
config();

import { captureClv } from "../src/lib/clv-tracker";

async function main() {
  const result = await captureClv();
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch(err => {
    console.error("FAILED:", err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
