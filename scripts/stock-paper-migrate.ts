/**
 * stock-paper-migrate.ts — create the PEAD paper-book tables on the active
 * database (Turso when TURSO_DATABASE_URL is set, else local sqlite).
 * Idempotent; same plain-DDL approach as kalshi-paper-migrate.ts.
 *
 *   npx tsx scripts/stock-paper-migrate.ts
 */
import { prisma } from "@/lib/prisma";

const DDL = [
  `CREATE TABLE IF NOT EXISTS "StockPaperPosition" (
     "id" INTEGER PRIMARY KEY AUTOINCREMENT,
     "symbol" TEXT NOT NULL,
     "reportDate" TEXT NOT NULL,
     "epsEstimate" REAL NOT NULL,
     "epsActual" REAL NOT NULL,
     "surprisePct" REAL NOT NULL,
     "side" TEXT NOT NULL,
     "qty" REAL NOT NULL,
     "entryPrice" REAL NOT NULL,
     "costUsd" REAL NOT NULL,
     "entrySpy" REAL,
     "exitPrice" REAL,
     "exitSpy" REAL,
     "pnlUsd" REAL,
     "excessRetPct" REAL,
     "status" TEXT NOT NULL,
     "openedAt" TEXT NOT NULL,
     "exitDue" TEXT NOT NULL,
     "closedAt" TEXT,
     "entryOrderId" TEXT,
     "exitOrderId" TEXT
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "uq_spp_symbol_report"
     ON "StockPaperPosition" ("symbol", "reportDate")`,
  `CREATE INDEX IF NOT EXISTS "idx_spp_status" ON "StockPaperPosition" ("status")`,
  `CREATE TABLE IF NOT EXISTS "StockPaperSnapshot" (
     "id" INTEGER PRIMARY KEY AUTOINCREMENT,
     "ts" TEXT NOT NULL,
     "equityUsd" REAL NOT NULL,
     "cashUsd" REAL NOT NULL,
     "exposureUsd" REAL NOT NULL,
     "realizedPnlUsd" REAL NOT NULL,
     "openCount" INTEGER NOT NULL,
     "closedCount" INTEGER NOT NULL,
     "avgExcessRetPct" REAL
   )`,
  `CREATE INDEX IF NOT EXISTS "idx_sps_ts" ON "StockPaperSnapshot" ("ts")`,
];

async function main() {
  const target = process.env.TURSO_DATABASE_URL ? "Turso" : "local sqlite";
  console.log(`[stock-migrate] applying DDL to ${target}...`);
  for (const stmt of DDL) {
    await prisma.$executeRawUnsafe(stmt);
  }
  const posCount = await prisma.stockPaperPosition.count();
  const snapCount = await prisma.stockPaperSnapshot.count();
  console.log(`[stock-migrate] OK — StockPaperPosition rows=${posCount}, snapshots=${snapCount}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("[stock-migrate] FAILED:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
