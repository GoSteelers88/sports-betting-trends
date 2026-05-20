// Run the orchestrator end-to-end for one or more leagues.
// Usage: npm run agent:run -- NBA
//        npm run agent:run -- MLB
//        npm run agent:run -- BOTH   (NBA + MLB; default)
//
// Scope tightened to NBA + MLB on 2026-05-20. BOTH and ALL both expand to
// [NBA, MLB] now; passing WNBA/NHL/NCAAB explicitly will hit the scope guard
// in orchestrate() and throw OutOfScopeLeagueError.
import { config } from "dotenv";
config();

import { orchestrate } from "../src/lib/agent/orchestrator";
import { IN_SCOPE_LEAGUES, type AgentLeague } from "../src/lib/agent/tools";

async function main() {
  const requested = (process.argv[2] ?? "BOTH").toUpperCase();
  const leagues: AgentLeague[] =
    requested === "BOTH" || requested === "ALL"
      ? [...IN_SCOPE_LEAGUES]
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
