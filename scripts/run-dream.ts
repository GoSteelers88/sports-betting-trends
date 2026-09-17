// Manual dream run.
//   npm run agent:dream            # MODELS.dream (Opus) — what the Monday cron runs
//   npm run agent:dream -- fable   # MODELS.dreamFable — opt-in, one-off
//
// The model arg is a CLI flag rather than an env var to match nfl-dream.ts,
// which selects its walk-completion model the same way.
import { config } from "dotenv";
config();

import { dream } from "../src/lib/agent/dream";
import { MODELS } from "../src/lib/agent/client";

async function main() {
  const args = process.argv.slice(2).map((a) => a.toLowerCase());
  const useFable = args.includes("fable");
  const model = useFable ? MODELS.dreamFable : MODELS.dream;

  console.log(`dream: consolidating on ${model}${useFable ? " (opt-in, not the cron default)" : ""}…`);

  const result = await dream({ model });
  console.log(JSON.stringify(result, null, 2));
}

main();
