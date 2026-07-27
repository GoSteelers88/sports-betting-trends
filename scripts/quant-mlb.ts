/**
 * quant-mlb.ts — drive THE QUANT DESK · MLB desk.
 *
 *   npm run quant:mlb           # one full cycle: settle → close → open → snapshot
 *   npm run quant:mlb report    # read-only: book stats + the live opportunity board
 *
 * Doctrine (Benter / Benham / Bloom): model the mispricings, size ¼-Kelly with a
 * drawdown rail, judge by CLV. Places NOTHING real — JSON paper book at
 * data/processed/quant-desk-mlb-book.json.
 */
import { runMlbQuantCycle, reportMlbQuant } from "../src/lib/quant-desk/mlb-runner";
import { QUANT_DESK_CONFIG, isPlayable, rejectReason } from "../src/lib/quant-desk/engine";

const B = "\x1b[1m";
const R = "\x1b[0m";
const G = "\x1b[32m";
const RED = "\x1b[31m";
const Y = "\x1b[33m";
const D = "\x1b[2m";
const C = "\x1b[36m";

function usd(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}
function pct(n: number | null): string {
  return n == null ? "  -  " : `${(n * 100).toFixed(1)}%`;
}

function printStats(stats: ReturnType<typeof reportMlbQuant>["stats"]): void {
  const pnlC = stats.realizedPnlUsd > 0 ? G : stats.realizedPnlUsd < 0 ? RED : D;
  console.log(`\n${B}THE QUANT DESK · MLB${R} ${D}($${stats.startingBankrollUsd.toLocaleString()} paper book)${R}`);
  console.log(`  Equity        ${B}${usd(stats.equityUsd)}${R}   ${pnlC}${stats.realizedPnlUsd >= 0 ? "+" : ""}${usd(stats.realizedPnlUsd)}${R} realized  (${pnlC}${stats.roiPct >= 0 ? "+" : ""}${stats.roiPct}%${R} ROI)`);
  console.log(`  Record        ${B}${stats.wins}-${stats.losses}${stats.pushes ? `-${stats.pushes}` : ""}${R}   yield ${stats.yieldPct == null ? D + "—" + R : (stats.yieldPct >= 0 ? G : RED) + (stats.yieldPct >= 0 ? "+" : "") + stats.yieldPct + "%" + R}`);
  console.log(`  Open exposure ${usd(stats.exposureUsd)}  ${D}(${stats.openCount} open)${R}   avg edge ${pct(stats.avgEdge)}`);
  console.log(`  ${C}CLV (HEADLINE)${R}  beat-rate ${B}${pct(stats.clvBeatRatePct == null ? null : stats.clvBeatRatePct / 100)}${R}  avg ${stats.avgClvProbPoints == null ? D + "—" + R : (stats.avgClvProbPoints >= 0 ? G : RED) + (stats.avgClvProbPoints >= 0 ? "+" : "") + stats.avgClvProbPoints + "pp" + R}  ${D}(n=${stats.clvSettledCount})${R}`);
  const dd = stats.drawdownPct;
  const ddTone = dd >= QUANT_DESK_CONFIG.maxDrawdown ? RED : dd > 0 ? Y : D;
  console.log(`  Drawdown      ${ddTone}${(dd * 100).toFixed(1)}%${R} from peak ${usd(stats.peakEquityUsd)}  ${dd >= QUANT_DESK_CONFIG.maxDrawdown ? RED + "[RAIL ACTIVE — opens paused]" + R : ""}`);
}

async function main(): Promise<void> {
  const mode = (process.argv[2] ?? "run").toLowerCase();

  if (mode === "report") {
    const { stats, opps } = reportMlbQuant();
    printStats(stats);
    const playable = opps.filter((o) => isPlayable(o)).sort((a, b) => b.edge - a.edge);
    console.log(`\n  ${B}Live opportunity board${R} ${D}(${opps.length} scanned, ${playable.length} playable ≥${(QUANT_DESK_CONFIG.edgeFloor * 100).toFixed(0)}% edge)${R}`);
    if (playable.length === 0) {
      console.log(`    ${D}no plays — an empty board is the honest result of an efficient market${R}`);
    }
    for (const o of playable.slice(0, 20)) {
      console.log(
        `    ${G}+${(o.edge * 100).toFixed(1)}%${R} ${o.fair.selection.padEnd(34)} ${D}model ${pct(o.fair.modelFairProb)} vs mkt ${pct(o.line.devigMarketProb)} @ ${o.line.priceAmerican > 0 ? "+" : ""}${o.line.priceAmerican} (${o.line.book})${o.fair.estimate ? " ~est" : ""}${R}`,
      );
    }
    // Show a few rejected-near-misses for transparency.
    const nearMiss = opps
      .filter((o) => !isPlayable(o) && o.edge >= QUANT_DESK_CONFIG.edgeFloor * 0.5)
      .sort((a, b) => b.edge - a.edge)
      .slice(0, 5);
    if (nearMiss.length) {
      console.log(`\n  ${D}Near-misses (rejected):${R}`);
      for (const o of nearMiss) {
        console.log(`    ${Y}${(o.edge * 100).toFixed(1)}%${R} ${o.fair.selection.padEnd(30)} ${D}${rejectReason(o)}${R}`);
      }
    }
    console.log();
    return;
  }

  console.log(`${C}Running MLB quant cycle…${R}`);
  const res = await runMlbQuantCycle();
  console.log(
    `  settled ${G}${res.settled}${R}  ·  closes refreshed ${res.refreshedCloses}  ·  ` +
      `scanned ${res.oppsScanned} (${res.playable} playable)  ·  ${G}opened ${res.opened}${R}` +
      `${res.railActive ? `  ${RED}[DRAWDOWN RAIL ACTIVE — no opens]${R}` : ""}`,
  );
  printStats(res.stats);
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
