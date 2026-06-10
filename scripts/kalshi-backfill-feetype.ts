/**
 * kalshi-backfill-feetype.ts — one-time backfill of `feeType` on existing
 * KalshiPaperPosition rows (rows created before fee instrumentation existed).
 * askAtEntry is NOT backfillable — the entry-time ask is gone — so the taker
 * counterfactual accrues from new entries only. Idempotent: only touches
 * rows where feeType is null.
 *
 *   npx tsx scripts/kalshi-backfill-feetype.ts
 */
import { prisma } from "@/lib/prisma";
import { fetchSeriesFeeType } from "@/lib/kalshi/marketData";

async function main() {
  const rows = await prisma.kalshiPaperPosition.findMany({
    where: { feeType: null },
    select: { id: true, eventTicker: true },
  });
  console.log(`[feetype-backfill] ${rows.length} rows missing feeType`);
  let updated = 0;
  for (const row of rows) {
    const feeType = await fetchSeriesFeeType(row.eventTicker);
    if (!feeType) continue; // retryable on a future run
    await prisma.kalshiPaperPosition.update({ where: { id: row.id }, data: { feeType } });
    updated++;
    await new Promise((r) => setTimeout(r, 80));
  }
  console.log(`[feetype-backfill] updated ${updated}/${rows.length}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[feetype-backfill] FAILED:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
