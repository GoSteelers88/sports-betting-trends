// Run the orchestrator end-to-end for one or more leagues.
// Usage: npm run agent:run -- NBA   (single)
//        npm run agent:run -- BOTH  (NBA + MLB; legacy default)
//        npm run agent:run -- ALL   (NBA + MLB + WNBA)
//        npm run agent:run -- WNBA  (single, opt-in)
import { config } from "dotenv";
config();

import { orchestrate } from "../src/lib/agent/orchestrator";
import type { AgentLeague } from "../src/lib/agent/tools";

async function main() {
  const requested = (process.argv[2] ?? "BOTH").toUpperCase();
  const leagues: AgentLeague[] =
    requested === "BOTH"
      ? ["NBA", "MLB"]
      : requested === "ALL"
        ? ["NBA", "MLB", "WNBA"]
        : ([requested] as AgentLeague[]);

  for (const league of leagues) {
    console.log(`\n══════════════ ${league} ORCHESTRATOR ══════════════`);
    const t0 = Date.now();
    try {
      const r = await orchestrate(league);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        `runId=${r.runId}  raw=${r.rawAnalystPickCount} → critic killed=${r.killedByCritic.length} → bankroll dropped=${r.droppedByBankroll.length} → kept=${r.finalPicks.length}   total=${r.totalUnits.toFixed(2)}u  ${elapsed}s`
      );
      for (const p of r.finalPicks) {
        console.log(
          `  ✅ ${p.matchup} | ${p.market} | ${p.selection} @ ${p.oddsAmerican}  edge=${(p.edge * 100).toFixed(1)}%  stake=${p.kellyStakeUnits}u`
        );
        console.log(`     ${p.thesis.slice(0, 200)}`);
      }
      for (const k of r.killedByCritic) {
        console.log(`  ❌ KILLED: ${k.pick.matchup} → ${k.reason}`);
      }
      for (const d of r.droppedByBankroll) {
        console.log(`  🚫 BANKROLL DROP: ${d.pick.matchup} → ${d.reason}`);
      }
      for (const f of r.bankrollFlags) {
        console.log(`  ⚠️  ${f}`);
      }
      console.log("\n  Trace:");
      for (const t of r.trace) {
        console.log(`    [${t.step}]`);
      }
    } catch (err) {
      console.error(`${league} FAILED:`, err);
    }
  }
}

main();
