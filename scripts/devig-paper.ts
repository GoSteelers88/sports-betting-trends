/**
 * De-vig paper book CLI — one cycle: settle finished games, open new +EV plays
 * from the CLV-proof log, snapshot the equity curve. Places NO real bets.
 *
 *   npm run paper:devig          # run a cycle + report
 *   npm run paper:devig -- report  # read-only report (no settle/open)
 *
 * Pre-req: the CLV-proof harness must have logged entries first
 * (ingest:sharp + ingest:odds + ingest:softbooks + clv:proof). The clv-proof
 * cron does this 6x/day; this book consumes its `wouldBet` entries.
 */
import path from "node:path";
import {
  runDevigPaperCycle,
  getDevigLedgerView,
  computeStats,
  loadBook,
  DEVIG_PAPER_CONFIG,
  type DevigPaperStats,
} from "../src/lib/devig-paper";

const B = "\x1b[1m";
const R = "\x1b[0m";
const G = "\x1b[32m";
const RED = "\x1b[31m";
const D = "\x1b[2m";
const C = "\x1b[36m";

function money(n: number): string {
  const s = `$${Math.abs(n).toFixed(2)}`;
  return n < 0 ? `-${s}` : s;
}

function printStats(s: DevigPaperStats) {
  const pnlColor = s.realizedPnlUsd > 0 ? G : s.realizedPnlUsd < 0 ? RED : D;
  console.log(
    `\n${B}De-vig paper book${R}  ${D}($${DEVIG_PAPER_CONFIG.startingBankrollUsd.toLocaleString()} book · +EV ≥ ${(DEVIG_PAPER_CONFIG.evFloor * 100).toFixed(0)}% vs sharp · ¼-Kelly)${R}`,
  );
  console.log(
    `  equity ${B}${money(s.equityUsd)}${R}  ` +
      `realized ${pnlColor}${money(s.realizedPnlUsd)} (${s.roiPct > 0 ? "+" : ""}${s.roiPct}%)${R}  ` +
      `exposure ${money(s.exposureUsd)}`,
  );
  console.log(
    `  bets: ${s.openCount} open · ${s.settledCount} settled  ` +
      `record ${s.wins}-${s.losses}${s.pushes ? `-${s.pushes}` : ""} ` +
      `${s.winRatePct != null ? `(${s.winRatePct}%)` : ""}  ` +
      (s.yieldPct != null ? `yield ${s.yieldPct > 0 ? "+" : ""}${s.yieldPct}% on ${money(s.totalStakedUsd)} staked` : ""),
  );
  if (s.avgEvVsSharp != null) {
    console.log(`  ${D}avg entry EV vs sharp: ${(s.avgEvVsSharp * 100).toFixed(1)}%${R}`);
  }
  if (s.settledCount === 0 && s.openCount === 0) {
    console.log(
      `  ${D}no bets yet — the strategy only fires on +EV ≥ ${(DEVIG_PAPER_CONFIG.evFloor * 100).toFixed(0)}% plays, which are rare. This is the honest book.${R}`,
    );
  }
}

async function main() {
  const dir = path.join(process.cwd(), "data", "processed");
  const mode = (process.argv[2] ?? "cycle").toLowerCase();

  if (mode === "report") {
    printStats(computeStats(loadBook(dir)));
    console.log("");
    return;
  }

  const { opened, settled, skipped, stats } = await runDevigPaperCycle({ dataDir: dir });
  console.log(
    `${C}cycle done${R} — ${G}+${opened} opened${R}, ${settled} settled` +
      (skipped ? `, ${skipped} skipped (started/too-small)` : ""),
  );
  printStats(stats);

  const view = getDevigLedgerView(dir);
  if (view.open.length) {
    console.log(`\n${B}Open bets:${R}`);
    for (const b of view.open) {
      console.log(
        `  ${b.team.padEnd(22)} ${b.oddsAmerican > 0 ? "+" : ""}${b.oddsAmerican}@${(b.book || "").padEnd(10)} ` +
          `${money(b.stakeUsd).padStart(8)}  ${D}EV ${(b.evVsSharp * 100).toFixed(1)}% · ${b.matchup}${R}`,
      );
    }
  }
  if (view.settled.length) {
    console.log(`\n${B}Recently settled:${R}`);
    for (const b of view.settled.slice(0, 10)) {
      const col = b.status === "won" ? G : b.status === "lost" ? RED : D;
      console.log(
        `  ${col}${b.status.toUpperCase().padEnd(5)}${R} ${b.team.padEnd(22)} ${money(b.pnlUsd ?? 0).padStart(9)}  ${D}${b.finalScore ?? ""}${R}`,
      );
    }
  }
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
