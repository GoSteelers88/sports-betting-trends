/**
 * quant-nfl-dryrun.ts — the QUIET NFL DRY-RUN (private report only).
 *
 *   npm run quant:nfl:dryrun           # run the dry-run over cached weeks + report
 *   npm run quant:nfl:dryrun report    # read-only report of the persisted book
 *
 * NFL has no tuned model here, so the fair value is a TRANSPARENT, leak-safe Elo
 * power rating (dry-run). nflverse lines are ~closing → entry==close → CLV ≈ 0 by
 * construction. The point is to prove the desk's machinery on real historical
 * games and measure the model-vs-market EDGE distribution. PRIVATE: nothing here
 * is user-facing. Book lives under data/private/nfl-loop/quant/.
 *
 * Also runs the LEARNING layer's coverage audit + correlation discovery so the
 * private artifacts the dream reflects on stay fresh.
 */
import { runNflDryRun, reportNflDryRun } from "../src/lib/quant-desk/nfl-runner";
import { runResearch } from "../src/lib/quant-desk/research/research-runner";
import { QUANT_DESK_CONFIG } from "../src/lib/quant-desk/engine";
import type { QuantStats } from "../src/lib/quant-desk/engine";

const B = "\x1b[1m";
const R = "\x1b[0m";
const G = "\x1b[32m";
const RED = "\x1b[31m";
const Y = "\x1b[33m";
const D = "\x1b[2m";
const C = "\x1b[36m";

function usd(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
}
function pct(n: number | null): string {
  return n == null ? "—" : `${(n * 100).toFixed(1)}%`;
}

function printStats(stats: QuantStats): void {
  const pnlC = stats.realizedPnlUsd > 0 ? G : stats.realizedPnlUsd < 0 ? RED : D;
  console.log(`\n${B}QUANT DESK · NFL DRY-RUN (private)${R} ${D}($${stats.startingBankrollUsd.toLocaleString()} paper, Elo dry-run vs nflverse ~close)${R}`);
  console.log(`  Record   ${B}${stats.wins}-${stats.losses}${stats.pushes ? `-${stats.pushes}` : ""}${R}  win ${pct(stats.winRatePct == null ? null : stats.winRatePct / 100)}`);
  console.log(`  P&L      ${pnlC}${stats.realizedPnlUsd >= 0 ? "+" : ""}${usd(stats.realizedPnlUsd)}${R}  ROI ${pnlC}${stats.roiPct >= 0 ? "+" : ""}${stats.roiPct}%${R}  yield ${stats.yieldPct == null ? D + "—" + R : stats.yieldPct + "%"}`);
  console.log(`  Avg edge ${pct(stats.avgEdge)}  ${D}(model-vs-market; the distribution is the point)${R}`);
  console.log(`  ${C}CLV${R}      beat-rate ${pct(stats.clvBeatRatePct == null ? null : stats.clvBeatRatePct / 100)}  avg ${stats.avgClvCents == null ? "—" : stats.avgClvCents + "¢"}  ${D}(≈0 by construction — entry==close)${R}`);
  console.log(`  Peak ${usd(stats.peakEquityUsd)}  max drawdown seen ${(stats.drawdownPct * 100).toFixed(1)}%`);
}

function main(): void {
  const mode = (process.argv[2] ?? "run").toLowerCase();

  if (mode === "report") {
    printStats(reportNflDryRun());
    console.log(`\n  ${D}Private dry-run. nflverse lines are ~closing — treat any positive ROI as an optimistic upper bound.${R}\n`);
    return;
  }

  console.log(`${C}Running NFL dry-run backtest over cached weeks…${R}`);
  const res = runNflDryRun();
  console.log(
    `  weeks ${B}${res.weeksProcessed}${R}  ·  scanned ${res.oppsScanned} (${res.playable} playable @ ≥${(QUANT_DESK_CONFIG.edgeFloor * 100).toFixed(0)}% edge)  ·  recorded ${B}${res.betsRecorded}${R} bets` +
      `${res.railSkips ? `  ${Y}(${res.railSkips} rail-skipped)${R}` : ""}`,
  );
  printStats(res.stats);

  console.log(`\n${C}Refreshing the learning layer (coverage audit + correlation discovery)…${R}`);
  const research = runResearch();
  const cov = research.coverage;
  console.log(`  coverage audit: ${G}${cov.summary.covered} covered${R}, ${Y}${cov.summary.synthesized} synthesized${R}, ${RED}${cov.summary.missing} missing${R}`);
  console.log(`  ${B}top data-acquisition backlog:${R}`);
  for (const item of cov.backlog.filter((b) => b.status !== "covered").slice(0, 6)) {
    const tone = item.status === "missing" ? RED : Y;
    console.log(`    ${tone}[${item.status}]${R} ${item.sport} ${item.market.padEnd(30)} ${D}impact:${item.impact} diff:${item.difficulty} → ${item.unlocks}${R}`);
  }
  const nfl = research.nflScan;
  console.log(`  NFL correlation scan: ${nfl.nSamples} samples → ${nfl.hypotheses.length} quarantined hypotheses ${D}(${nfl.note})${R}`);
  for (const h of nfl.hypotheses.slice(0, 5)) {
    console.log(`    ${C}${h.feature}${R} r=${(h.target === "residual" ? h.rResidual : h.rOutcome)} vs ${h.target} ${D}(p=${h.pValue}, n=${h.n}) — QUARANTINED${R}`);
  }
  console.log(`\n  ${D}Discovered correlations are HYPOTHESES until out-of-sample validated. The live model is unchanged.${R}\n`);
}

main();
