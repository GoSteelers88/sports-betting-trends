// Drop all tables in the Turso DB and clear migration tracking.
// Use only when you want to re-apply all migrations from scratch.

import { config } from "dotenv";
config();

import { createClient } from "@libsql/client";

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    console.error("Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN");
    process.exit(1);
  }
  const client = createClient({ url, authToken });

  const tables = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestream%'"
  );
  for (const row of tables.rows) {
    const name = row.name as string;
    console.log(`drop table ${name}`);
    await client.execute(`DROP TABLE IF EXISTS "${name}"`);
  }
  console.log("Done.");
  client.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
