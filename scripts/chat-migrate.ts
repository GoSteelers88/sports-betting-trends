/**
 * chat-migrate.ts — create the ChatSpendCounter table on the active database
 * (Turso when TURSO_DATABASE_URL is set, else local sqlite). Idempotent.
 *
 * Mirrors scripts/kalshi-paper-migrate.ts: Prisma migrations target the local
 * sqlite `url` and don't flow through the libSQL adapter to Turso, so we apply
 * the additive DDL directly through the same Prisma client the app uses. Column
 * names + types match the Prisma model (prisma/schema.prisma ChatSpendCounter)
 * and the migration SQL exactly.
 *
 *   npx tsx --env-file=.env scripts/chat-migrate.ts
 */
import { prisma } from "@/lib/prisma";

const DDL = [
  `CREATE TABLE IF NOT EXISTS "ChatSpendCounter" (
     "utcDate" TEXT NOT NULL PRIMARY KEY,
     "tokensUsed" INTEGER NOT NULL DEFAULT 0,
     "modelCalls" INTEGER NOT NULL DEFAULT 0,
     "updatedAt" DATETIME NOT NULL
   )`,
];

async function main(): Promise<void> {
  for (const stmt of DDL) {
    await prisma.$executeRawUnsafe(stmt);
  }
  // Verify the table is queryable (and visible to the app's client).
  const rows = await prisma.chatSpendCounter.findMany({ take: 1 });
  console.log(
    `[chat-migrate] ChatSpendCounter ready (current rows visible: ${rows.length}).`,
  );
}

main()
  .catch((err) => {
    console.error("[chat-migrate] failed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
