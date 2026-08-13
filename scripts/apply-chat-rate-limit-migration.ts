/**
 * apply-chat-rate-limit-migration.ts — one-shot, idempotent application of
 * prisma/migrations/20260813000000_chat_rate_limit to the production Turso DB.
 *
 *   npx tsx --env-file=.env scripts/apply-chat-rate-limit-migration.ts
 *
 * Why this exists: the Vercel build runs `prisma generate` only (no
 * `migrate deploy`), so schema DDL is applied to Turso out-of-band. The chat
 * rate-limit code FAILS CLOSED without this table — deploying the app before
 * running this would 429 every chat request. Run this FIRST, then deploy.
 *
 * Safe to re-run: exits early if the table already exists. Creates nothing else,
 * drops nothing, touches no existing rows. Ends with a self-cleaning smoke test
 * of the exact upsert shape src/lib/chat/guards.ts uses.
 */
import { createClient } from "@libsql/client";

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN");
  const db = createClient({ url, authToken });

  const existing = await db.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='ChatRateLimit'"
  );
  if (existing.rows.length > 0) {
    console.log("ChatRateLimit table already exists — nothing to do.");
    return;
  }

  await db.execute(`CREATE TABLE "ChatRateLimit" (
    "scope"     TEXT NOT NULL,
    "key"       TEXT NOT NULL,
    "utcDate"   TEXT NOT NULL,
    "count"     INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL,
    PRIMARY KEY ("scope", "key", "utcDate")
  )`);
  await db.execute(`CREATE INDEX "ChatRateLimit_utcDate_idx" ON "ChatRateLimit"("utcDate")`);

  const check = await db.execute(
    "SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name LIKE 'ChatRateLimit%'"
  );
  console.log("Created:", check.rows.map((r) => r.name).join(", "));

  // Smoke the exact upsert shape the guards use, then clean up after ourselves.
  await db.execute(
    `INSERT INTO "ChatRateLimit" ("scope","key","utcDate","count","updatedAt")
     VALUES ('smoke','test','1970-01-01',1,datetime('now'))
     ON CONFLICT("scope","key","utcDate") DO UPDATE SET "count" = "count" + 1, "updatedAt" = datetime('now')`
  );
  const row = await db.execute(`SELECT count FROM "ChatRateLimit" WHERE scope='smoke'`);
  console.log("Upsert smoke count:", row.rows[0]?.count);
  await db.execute(`DELETE FROM "ChatRateLimit" WHERE scope='smoke'`);
  console.log("Smoke row cleaned. Migration applied.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
