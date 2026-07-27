/**
 * clv-prob-points-migrate.ts — add AgentPick.clvProbPoints and backfill every
 * historical row from the stored oddsAmerican + closingOddsAmerican pair.
 *
 * Prisma migrations target the local sqlite `url` and don't flow through the
 * libSQL driver adapter to Turso, so additive DDL goes through the same client
 * the app uses (see kalshi-paper-migrate.ts for the same pattern). Idempotent:
 * re-running skips the ALTER and recomputes the same values.
 *
 * WHY: clvCents stored `pickedOdds - closingOdds`, a raw subtraction of
 * American odds. That is invalid across the ±100 boundary (+100 and −100 are
 * both 50% implied, yet subtract to 200). Three sign-crossing picks ended up
 * carrying 98% of the paper trial's whole CLV total and flipped the
 * pre-registered "avg CLV ≥ +2¢" gate from FAIL to PASS on an artifact.
 *
 *   npx tsx scripts/clv-prob-points-migrate.ts          # migrate + backfill
 *   npx tsx scripts/clv-prob-points-migrate.ts --dry    # report only
 */
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { clvProbPoints } from "@/lib/devig";

const ALTER = `ALTER TABLE "AgentPick" ADD COLUMN "clvProbPoints" REAL`;

async function main() {
  const dry = process.argv.includes("--dry");
  const target = process.env.TURSO_DATABASE_URL ? "Turso" : "local sqlite";
  console.log(`[clv-migrate] target: ${target}${dry ? " (DRY RUN)" : ""}`);

  if (!dry) {
    try {
      await prisma.$executeRawUnsafe(ALTER);
      console.log(`[clv-migrate] applied: ${ALTER}`);
    } catch (e) {
      if (!/duplicate column/i.test(String(e))) throw e;
      console.log("[clv-migrate] column already present — skipping ALTER");
    }
  }

  const rows = await prisma.agentPick.findMany({
    where: { clvCents: { not: null }, closingOddsAmerican: { not: null } },
    select: { id: true, oddsAmerican: true, closingOddsAmerican: true, clvCents: true },
  });
  console.log(`[clv-migrate] ${rows.length} rows with a stored CLV reading`);

  let updated = 0, skipped = 0, signFlips = 0;
  const deltas: number[] = [];
  for (const r of rows) {
    const pp = clvProbPoints(r.oddsAmerican, r.closingOddsAmerican!);
    if (!Number.isFinite(pp)) {
      skipped++;
      continue;
    }
    // The naive figure preserved sign; assert that so a silent semantic flip
    // in the helper can never sail through this backfill unnoticed.
    const oldSign = Math.sign(r.clvCents ?? 0);
    const newSign = Math.sign(+pp.toFixed(4));
    if (oldSign !== 0 && newSign !== 0 && oldSign !== newSign) signFlips++;
    deltas.push(pp);
    if (!dry) {
      await prisma.agentPick.update({
        where: { id: r.id },
        data: { clvProbPoints: +pp.toFixed(4) },
      });
    }
    updated++;
  }

  const mean = deltas.reduce((a, b) => a + b, 0) / (deltas.length || 1);
  const sorted = [...deltas].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : NaN;
  const beat = (100 * deltas.filter((d) => d > 0).length) / (deltas.length || 1);

  console.log(`[clv-migrate] ${dry ? "would update" : "updated"} ${updated}, skipped ${skipped}`);
  console.log(`[clv-migrate] corrected CLV: beat ${beat.toFixed(1)}%  mean ${mean.toFixed(2)}pp  median ${median.toFixed(2)}pp`);
  if (signFlips > 0) {
    console.warn(`[clv-migrate] WARNING: ${signFlips} rows changed SIGN. Raw American subtraction preserves sign, so this means the helper's orientation disagrees with the legacy column — investigate before trusting this backfill.`);
  } else {
    console.log("[clv-migrate] sign preserved on every row (expected — only magnitude was wrong)");
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[clv-migrate] FAILED:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
