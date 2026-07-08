// Smoke test for the agent layer. Runs analyst on the in-scope leagues and prints picks.
// Usage: tsx scripts/smoke-agent.ts [NBA|MLB|WNBA]
import { config } from "dotenv";
config();

import { analyze } from "../src/lib/agent/analyst";
import { IN_SCOPE_LEAGUES, type AgentLeague } from "../src/lib/agent/tools";

async function main() {
  const requested = (process.argv[2] ?? "BOTH").toUpperCase();
  const leagues: AgentLeague[] =
    requested === "BOTH" ? [...IN_SCOPE_LEAGUES] : ([requested] as AgentLeague[]);

  for (const league of leagues) {
    console.log(`\n══════════════ ${league} ══════════════`);
    const t0 = Date.now();
    try {
      const result = await analyze(league);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        `runId=${result.runId}  iters=${result.iterations}  tools=${result.toolsUsed.join(",")}  picks=${result.picks.length}  ${elapsed}s`
      );
      for (const p of result.picks) {
        console.log(
          `  • ${p.matchup} | ${p.market} | ${p.selection} @ ${p.oddsAmerican}  ` +
            `edge=${(p.edge * 100).toFixed(1)}%  stake=${p.kellyStakeUnits}u  conf=${p.confidence}`
        );
        console.log(`    thesis: ${p.thesis}`);
        if (p.graderNotes.length) console.log(`    grader: ${p.graderNotes.join(" | ")}`);
      }
      if (result.picks.length === 0) {
        console.log("  (no picks — agent's final response below)");
        console.log("  ────────────────────────────────────────");
        console.log(result.rawResponseText.split("\n").map(l => "  " + l).join("\n"));
      }
    } catch (err) {
      console.error(`${league} FAILED:`, err);
    }
  }
}

main();
