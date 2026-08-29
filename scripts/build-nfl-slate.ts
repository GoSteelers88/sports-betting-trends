/**
 * build-nfl-slate.ts — write the committed NFL week board the dashboard
 * renders (data/processed/nfl-slate.json) from the Pinnacle sharp scrape.
 *
 *   npx tsx scripts/scrape-pinnacle.ts --leagues nfl   # refresh the feed first
 *   npx tsx scripts/build-nfl-slate.ts
 *
 * Refuses to write from a stale scrape (>90 min) — a silently old board is
 * worse than yesterday's board staying put. NOT part of the receipts pipeline:
 * entry prices and closes never come from this file.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { buildNflSlate } from "../src/lib/nfl-receipts/site-slate";
import type { SharpEvent } from "./scrape-pinnacle";

const MAX_SCRAPE_AGE_MIN = 90;

function main(): void {
  const root = process.cwd();
  const srcPath = path.join(
    root,
    "data",
    "processed",
    "latest-sharp-pinnacle-americanfootball_nfl.json",
  );
  if (!fs.existsSync(srcPath)) {
    console.error("no Pinnacle NFL scrape on disk — run: npx tsx scripts/scrape-pinnacle.ts --leagues nfl");
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(srcPath, "utf8")) as {
    fetchedAt: string;
    events: SharpEvent[];
  };
  const ageMin = (Date.now() - Date.parse(raw.fetchedAt)) / 60_000;
  if (!Number.isFinite(ageMin) || ageMin > MAX_SCRAPE_AGE_MIN) {
    console.error(
      `Pinnacle scrape is ${ageMin.toFixed(0)} min old (> ${MAX_SCRAPE_AGE_MIN}) — refusing to build a stale board; previous nfl-slate.json left in place`,
    );
    process.exit(1);
  }

  const slate = buildNflSlate(raw.events, Date.now());
  const outPath = path.join(root, "data", "processed", "nfl-slate.json");
  fs.writeFileSync(outPath, JSON.stringify(slate, null, 2) + "\n");
  console.log(`nfl-slate.json: ${slate.gameCount} games in window → ${outPath}`);
}

main();
