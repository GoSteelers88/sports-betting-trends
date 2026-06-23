/**
 * ingest-nfl-history.ts — fetch + cache the nflverse games.csv spine for
 * Experiment No. 5: the private NFL Backtest Learning Loop.
 *
 *   npm run nfl:ingest
 *
 * Writes data/private/nfl-loop/games.csv (gitignored). Re-run any time to
 * refresh; the loop only reads the cached copy so runs are deterministic and
 * offline. Verifies the file parses and the three loop seasons are present.
 */
import fs from "node:fs";
import path from "node:path";
import {
  defaultStateDir,
  gamesCsvPath,
  parseGames,
  LOOP_SEASONS,
} from "../src/lib/nfl-loop";

const SOURCE =
  "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv";

const B = "\x1b[1m";
const R = "\x1b[0m";
const G = "\x1b[32m";
const D = "\x1b[2m";
const C = "\x1b[36m";

async function main() {
  const dir = defaultStateDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = gamesCsvPath(dir);

  console.log(`${C}Fetching nflverse games.csv${R} ${D}${SOURCE}${R}`);
  const res = await fetch(SOURCE);
  if (!res.ok) {
    throw new Error(`fetch failed: HTTP ${res.status} ${res.statusText}`);
  }
  const csv = await res.text();
  if (csv.length < 1000 || !csv.startsWith("game_id,")) {
    throw new Error(
      `unexpected response (len ${csv.length}, head "${csv.slice(0, 40)}") — not the games.csv`,
    );
  }

  // Parse before writing so we never cache a broken file.
  const games = parseGames(csv);
  if (games.length === 0) throw new Error("parsed 0 games — refusing to cache");

  fs.writeFileSync(dest, csv);

  console.log(
    `${G}cached${R} ${games.length} REG/POST games → ${D}${path.relative(process.cwd(), dest)}${R}`,
  );
  for (const season of LOOP_SEASONS) {
    const reg = games.filter((g) => g.season === season && g.gameType === "REG").length;
    const post = games.filter((g) => g.season === season && g.gameType === "POST").length;
    const played = games.filter(
      (g) => g.season === season && g.homeScore != null,
    ).length;
    const total = reg + post;
    const tag =
      total === 0
        ? `${D}(no games yet — future/in-progress season)${R}`
        : `${D}(${played}/${total} played)${R}`;
    console.log(
      `  ${B}${season}${R}: ${reg} REG + ${post} POST = ${total} games ${tag}`,
    );
  }
  console.log(
    `\n${D}Next: ${B}npm run nfl:week${R}${D} to process the next week (pick → grade → learn → advance).${R}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
