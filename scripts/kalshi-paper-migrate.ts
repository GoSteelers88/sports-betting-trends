/**
 * kalshi-paper-migrate.ts — create the paper-trail tables on the active database
 * (Turso when TURSO_DATABASE_URL is set, else local sqlite). Idempotent.
 *
 * We create tables with plain DDL through the same Prisma client the app uses,
 * because Prisma migrations target the local sqlite `url` and don't flow through
 * the libSQL driver adapter to Turso. Column names + types match the Prisma
 * models exactly (timestamps are TEXT/ISO by design).
 *
 *   npx tsx scripts/kalshi-paper-migrate.ts
 */
import { prisma } from "@/lib/prisma";

const DDL = [
  `CREATE TABLE IF NOT EXISTS "KalshiPaperPosition" (
     "id" INTEGER PRIMARY KEY AUTOINCREMENT,
     "ticker" TEXT NOT NULL UNIQUE,
     "eventTicker" TEXT NOT NULL,
     "category" TEXT NOT NULL,
     "title" TEXT NOT NULL,
     "side" TEXT NOT NULL,
     "entryPrice" REAL NOT NULL,
     "contracts" INTEGER NOT NULL,
     "costUsd" REAL NOT NULL,
     "status" TEXT NOT NULL,
     "result" TEXT,
     "pnlUsd" REAL,
     "openedAt" TEXT NOT NULL,
     "closedAt" TEXT,
     "closeTime" TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS "KalshiPaperLedgerSnapshot" (
     "id" INTEGER PRIMARY KEY AUTOINCREMENT,
     "ts" TEXT NOT NULL,
     "cashUsd" REAL NOT NULL,
     "exposureUsd" REAL NOT NULL,
     "equityUsd" REAL NOT NULL,
     "realizedPnlUsd" REAL NOT NULL,
     "openCount" INTEGER NOT NULL,
     "closedCount" INTEGER NOT NULL,
     "wins" INTEGER NOT NULL,
     "losses" INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS "idx_kpp_status" ON "KalshiPaperPosition" ("status")`,
  `CREATE INDEX IF NOT EXISTS "idx_kpls_ts" ON "KalshiPaperLedgerSnapshot" ("ts")`,
];

async function main() {
  const target = process.env.TURSO_DATABASE_URL ? "Turso" : "local sqlite";
  console.log(`[paper-migrate] applying DDL to ${target}...`);
  for (const stmt of DDL) {
    await prisma.$executeRawUnsafe(stmt);
  }
  // Verify
  const posCount = await prisma.kalshiPaperPosition.count();
  const snapCount = await prisma.kalshiPaperLedgerSnapshot.count();
  console.log(`[paper-migrate] OK — KalshiPaperPosition rows=${posCount}, snapshots=${snapCount}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[paper-migrate] FAILED:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
