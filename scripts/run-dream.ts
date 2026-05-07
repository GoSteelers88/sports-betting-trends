// Manual dream run. Usage: npm run agent:dream
import { config } from "dotenv";
config();

import { dream } from "../src/lib/agent/dream";

async function main() {
  const result = await dream();
  console.log(JSON.stringify(result, null, 2));
}

main();
