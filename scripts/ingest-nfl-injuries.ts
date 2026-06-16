/**
 * ingest-nfl-injuries.ts — fetch + cache the nflverse weekly injury reports for
 * the private NFL Backtest Learning Loop.
 *
 *   npm run nfl:ingest-injuries
 *
 * Writes data/private/nfl-loop/injuries.csv (gitignored). Injury REPORTS are
 * published pre-game, so this is a leak-safe pre-game source — but the parser
 * (src/lib/nfl-loop.ts: parseInjuries) keeps ONLY report fields, and this CSV
 * carries no scores/results at all.
 *
 * The combined `injuries.csv` release asset 404s, so we fetch the per-season
 * assets `injuries_<season>.csv` for each loop season and concatenate them
 * (each keeps its own header row; parseInjuries re-reads headers, so the
 * concatenation parses cleanly). We parse before writing so we never cache a
 * broken file. Re-run any time to refresh; the loop only reads the cached copy.
 */
import fs from "node:fs";
import path from "node:path";
import {
  defaultStateDir,
  injuriesCsvPath,
  parseInjuries,
  LOOP_SEASONS,
} from "../src/lib/nfl-loop";

const RELEASE_BASE =
  "https://github.com/nflverse/nflverse-data/releases/download/injuries";

function seasonAssetUrl(season: number): string {
  return `${RELEASE_BASE}/injuries_${season}.csv`;
}

const B = "\x1b[1m";
const R = "\x1b[0m";
const G = "\x1b[32m";
const Y = "\x1b[33m";
const D = "\x1b[2m";
const C = "\x1b[36m";

async function fetchSeason(season: number): Promise<string | null> {
  const url = seasonAssetUrl(season);
  console.log(`${C}Fetching${R} ${D}${url}${R}`);
  const res = await fetch(url);
  if (res.status === 404) {
    // A future/not-yet-released season — skip rather than fail the whole ingest.
    console.log(`  ${Y}404${R} ${D}— no injuries asset for ${season} yet (skipping)${R}`);
    return null;
  }
  if (!res.ok) {
    throw new Error(`fetch failed for ${season}: HTTP ${res.status} ${res.statusText}`);
  }
  const csv = await res.text();
  const head = csv.slice(0, 40);
  if (csv.length < 200 || !head.startsWith("season,")) {
    throw new Error(
      `unexpected response for ${season} (len ${csv.length}, head "${head}") — not the injuries CSV`,
    );
  }
  return csv;
}

async function main() {
  const dir = defaultStateDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = injuriesCsvPath(dir);

  const parts: string[] = [];
  let fetched = 0;
  for (const season of LOOP_SEASONS) {
    const csv = await fetchSeason(season);
    if (csv == null) continue;
    parts.push(csv.endsWith("\n") ? csv : csv + "\n");
    fetched++;
  }

  if (fetched === 0) {
    throw new Error(
      "no injury seasons fetched — every per-season asset 404'd. " +
        "Check the nflverse injuries release URLs.",
    );
  }

  const combined = parts.join("");

  // Parse before writing so we never cache a broken file.
  const rows = parseInjuries(combined);
  if (rows.length === 0) {
    throw new Error("parsed 0 injury rows — refusing to cache");
  }

  fs.writeFileSync(dest, combined);

  console.log(
    `\n${G}cached${R} ${rows.length} injury-report rows → ${D}${path.relative(process.cwd(), dest)}${R}`,
  );
  for (const season of LOOP_SEASONS) {
    const sRows = rows.filter((r) => r.season === season);
    if (sRows.length === 0) {
      console.log(`  ${B}${season}${R}: ${D}(no rows — future/unreleased season)${R}`);
      continue;
    }
    const out = sRows.filter((r) => r.status === "Out").length;
    const doubtful = sRows.filter((r) => r.status === "Doubtful").length;
    const quest = sRows.filter((r) => r.status === "Questionable").length;
    const teams = new Set(sRows.map((r) => r.team)).size;
    console.log(
      `  ${B}${season}${R}: ${sRows.length} rows across ${teams} teams ` +
        `${D}(Out ${out} / Doubtful ${doubtful} / Questionable ${quest})${R}`,
    );
  }
  console.log(
    `\n${D}Injuries are now attached per-game (scoped to each game's two teams) ` +
      `in the blind input. Run ${B}npm run nfl:week${R}${D} to use them.${R}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
