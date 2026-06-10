/**
 * run-pead-paper.ts — one cycle of the PEAD stock paper book (Experiment
 * No. 3, PEAD_PAPER_SPEC.md). Settles 28-day holds, enters new extreme
 * EPS surprises, snapshots the ledger. Orders go to Alpaca PAPER only.
 *
 *   npx tsx scripts/run-pead-paper.ts
 */
import { prisma } from "@/lib/prisma";
import { runPeadCycle } from "@/lib/stocks/peadEngine";
import { PEAD_CONFIG } from "@/lib/stocks/peadLogic";

async function main() {
  const t0 = Date.now();
  console.log(
    `[pead] cycle start — $${PEAD_CONFIG.bookUsd} book, surprise ≥ +${PEAD_CONFIG.minSurprisePct}%, ` +
      `$${PEAD_CONFIG.perPositionUsd}/position, hold ${PEAD_CONFIG.holdCalendarDays}d, vs SPY`,
  );
  const result = await runPeadCycle();
  if (result.skipped === "not-configured") {
    console.log(
      "::warning::[pead] skipped — set ALPACA_PAPER_KEY_ID, ALPACA_PAPER_SECRET, FINNHUB_API_KEY " +
        "(all free signups) to activate Experiment No. 3",
    );
  } else if (result.skipped === "market-closed") {
    console.log("[pead] market closed (holiday?) — nothing to do");
  } else {
    const s = result.stats;
    console.log(
      `[pead] scanned=${result.scanned} qualified=${result.qualified} opened=${result.opened} settled=${result.settled} | ` +
        `equity=$${s.equityUsd.toFixed(2)} realized=$${s.realizedPnlUsd.toFixed(2)} ` +
        `open=${s.openCount} closed=${s.closedCount} | ` +
        `avg excess vs SPY=${s.avgExcessRetPct?.toFixed(2) ?? "—"}pp t=${s.excessTStat?.toFixed(2) ?? "—"} ` +
        `(n=${s.settledWithBenchmark}/${PEAD_CONFIG.killMinSettles}) verdict=${s.verdict} | ${Date.now() - t0}ms`,
    );
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[pead] FAILED:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
