/**
 * run-paper-trail.ts — one cycle of the Kalshi favorite-longshot paper trail.
 * Settles resolved positions, opens new ones, writes a ledger snapshot.
 * Safe: places NO real orders. Intended for a scheduled GitHub Action.
 *
 *   npx tsx scripts/run-paper-trail.ts
 */
import { prisma } from "@/lib/prisma";
import { runPaperCycle, PAPER_CONFIG } from "@/lib/kalshi/paperEngine";

async function main() {
  const t0 = Date.now();
  console.log(`[paper-trail] cycle start — $${PAPER_CONFIG.startingBankrollUsd} book, favorites ${PAPER_CONFIG.minAsk}–${PAPER_CONFIG.maxAsk}, ≤${PAPER_CONFIG.maxHorizonDays}d`);
  const { settled, opened, scanned, stats } = await runPaperCycle();
  console.log(
    `[paper-trail] scanned=${scanned} settled=${settled} opened=${opened} | ` +
      `equity=$${stats.equityUsd.toFixed(2)} realized=$${stats.realizedPnlUsd.toFixed(2)} ` +
      `ROI=${stats.roiPct.toFixed(2)}% open=${stats.openCount} closed=${stats.closedCount} ` +
      `W/L=${stats.wins}/${stats.losses} (${stats.winRatePct?.toFixed(1) ?? "—"}%) | ${Date.now() - t0}ms`,
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[paper-trail] FAILED:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
