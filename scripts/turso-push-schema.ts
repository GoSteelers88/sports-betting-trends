// Apply all Prisma migrations to the Turso database in order.
// Prisma's `migrate deploy` doesn't support libsql URLs directly, so we
// execute the migration SQL files via the libsql client.

import { config } from "dotenv";
config();

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    console.error("Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN");
    process.exit(1);
  }

  const client = createClient({ url, authToken });

  // Track which migrations have been applied so we can re-run safely
  await client.execute(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );`);

  const migrationsDir = path.resolve(process.cwd(), "prisma", "migrations");
  const folders = fs
    .readdirSync(migrationsDir)
    .filter(f => fs.statSync(path.join(migrationsDir, f)).isDirectory())
    .sort();

  const applied = await client.execute("SELECT name FROM _migrations");
  const appliedSet = new Set(applied.rows.map(r => r.name as string));

  for (const folder of folders) {
    if (appliedSet.has(folder)) {
      console.log(`✓ ${folder} (already applied)`);
      continue;
    }
    const sqlPath = path.join(migrationsDir, folder, "migration.sql");
    if (!fs.existsSync(sqlPath)) {
      console.log(`- ${folder} (no migration.sql, skipping)`);
      continue;
    }
    const sql = fs.readFileSync(sqlPath, "utf8");
    // Strip pure-comment lines, then split on `;` at end of line.
    const stripped = sql
      .split(/\r?\n/)
      .filter(line => !line.trim().startsWith("--"))
      .join("\n");
    const statements = stripped
      .split(/;\s*\r?\n/)
      .map(s => s.trim().replace(/;$/, ""))
      .filter(s => s.length > 0);

    console.log(`→ ${folder} (${statements.length} statements)`);
    for (const stmt of statements) {
      await client.execute(stmt);
    }
    await client.execute({
      sql: "INSERT INTO _migrations (name) VALUES (?)",
      args: [folder],
    });
    console.log(`✓ ${folder} applied`);
  }

  console.log("Done.");
  client.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
