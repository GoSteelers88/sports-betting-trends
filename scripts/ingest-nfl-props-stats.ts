/**
 * ingest-nfl-props-stats.ts — fetch + cache nflverse player_stats_<season>.csv
 * for Experiment No. 5: the private NFL Backtest Learning Loop props layer.
 *
 *   npm run nfl:ingest-props-stats
 *
 * Writes data/private/nfl-loop/player_stats.csv (gitignored). Fetches the
 * per-season assets for each LOOP_SEASON (2023, 2024, 2025), concatenates them
 * (each keeps its own header row; parsePlayerStats handles multi-header CSVs),
 * parses before writing (never caches a broken file), and verifies ≥1 row per
 * fetched season. Re-run any time to refresh.
 *
 * Source: https://github.com/nflverse/nflverse-data/releases/download/player_stats/
 */
import fs from "node:fs";
import path from "node:path";
import {
  defaultStateDir,
  playerStatsCsvPath,
  parsePlayerStats,
  LOOP_SEASONS,
} from "../src/lib/nfl-loop";

// nflverse split these across two releases. Seasons through 2024 stayed as
// per-season assets on the `player_stats` release; from 2025 the current-season
// week-level files live on `stats_player` as stats_player_week_<season>.csv.
// Pointing only at the legacy base 404s for every modern season — which is why
// player_stats.csv held nothing past 2024 (verified 2026-09-17).
const LEGACY_BASE =
  "https://github.com/nflverse/nflverse-data/releases/download/player_stats";
const CURRENT_BASE =
  "https://github.com/nflverse/nflverse-data/releases/download/stats_player";

function seasonAssetUrl(season: number): string {
  return season >= 2025
    ? `${CURRENT_BASE}/stats_player_week_${season}.csv`
    : `${LEGACY_BASE}/player_stats_${season}.csv`;
}

// Seasons fetched IN ADDITION to LOOP_SEASONS, so live props can be graded
// against real box scores. LOOP_SEASONS is the walk-forward TRAINING window and
// is deliberately left alone: 2025 is the held-out validation season and must
// appear in neither list. A live season here is never walked by the backtest —
// fullSchedule() is driven by LOOP_SEASONS, not by this.
const LIVE_SEASONS = [2026];

// The HOLDOUT season. 2025 is deliberately absent from LOOP_SEASONS so the
// walk-forward trainer can never touch it — that stays true. But a holdout has
// to be GRADED, and grading prop picks needs 2025 box scores; without them
// every prop in a 2025 validation run scores "no-data" and the run proves
// nothing.
//
// Caching them cannot leak: buildPlayerContexts is gated to
// `season === cursor.season && week < cursor.week` (nfl-loop.ts — "THE LEAKAGE
// GATE (strict <)"), so a 2025 cursor never sees its own week and a 2024 cursor
// never sees 2025 at all. Answers for the grader, never for the model.
const HOLDOUT_SEASONS = [2025];

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
    console.log(`  ${Y}404${R} ${D}— no player_stats asset for ${season} yet (skipping)${R}`);
    return null;
  }
  if (!res.ok) {
    throw new Error(
      `fetch failed for ${season}: HTTP ${res.status} ${res.statusText}`,
    );
  }
  const csv = await res.text();
  const head = csv.slice(0, 80);
  if (csv.length < 500 || !head.includes("player_id")) {
    throw new Error(
      `unexpected response for ${season} (len ${csv.length}, head "${head}") — not player_stats CSV`,
    );
  }
  return csv;
}

async function main() {
  const dir = defaultStateDir();
  fs.mkdirSync(dir, { recursive: true });
  const dest = playerStatsCsvPath(dir);

  const parts: string[] = [];
  const fetchedSeasons: number[] = [];

  for (const season of [...LOOP_SEASONS, ...HOLDOUT_SEASONS, ...LIVE_SEASONS]) {
    const csv = await fetchSeason(season);
    if (csv == null) continue;
    // Ensure each season chunk ends with a newline so concatenation doesn't
    // merge the last row of one season with the header of the next.
    parts.push(csv.endsWith("\n") ? csv : csv + "\n");
    fetchedSeasons.push(season);
  }

  if (fetchedSeasons.length === 0) {
    throw new Error(
      "no player_stats seasons fetched — every per-season asset 404'd. " +
        "Check the nflverse player_stats release URLs.",
    );
  }

  const combined = parts.join("");

  // Parse before writing so we never cache a broken file.
  const rows = parsePlayerStats(combined);
  if (rows.length === 0) {
    throw new Error("parsed 0 player stat rows — refusing to cache");
  }

  // Verify ≥1 row per fetched season (catch a season where the CSV had a
  // header but no data rows — would be a silent failure otherwise).
  for (const season of fetchedSeasons) {
    const seasonRows = rows.filter((r) => r.season === season);
    if (seasonRows.length === 0) {
      throw new Error(
        `season ${season} was fetched but parsed 0 rows — refusing to cache a broken file`,
      );
    }
  }

  fs.writeFileSync(dest, combined);

  console.log(
    `\n${G}cached${R} ${rows.length} player stat rows → ${D}${path.relative(process.cwd(), dest)}${R}`,
  );
  for (const season of LOOP_SEASONS) {
    const sRows = rows.filter((r) => r.season === season);
    if (sRows.length === 0) {
      console.log(
        `  ${B}${season}${R}: ${D}(no rows — future/unreleased season)${R}`,
      );
      continue;
    }
    const qbs = sRows.filter((r) => r.position === "QB").length;
    const rbs = sRows.filter((r) => r.position === "RB").length;
    const wrs = sRows.filter((r) => r.position === "WR").length;
    const tes = sRows.filter((r) => r.position === "TE").length;
    const weeks = new Set(sRows.map((r) => `${r.gameType}-${r.week}`)).size;
    console.log(
      `  ${B}${season}${R}: ${sRows.length} rows across ${weeks} week slots ` +
        `${D}(QB ${qbs} / RB ${rbs} / WR ${wrs} / TE ${tes})${R}`,
    );
  }
  console.log(
    `\n${D}Player contexts are now available in the blind input. ` +
      `Run ${B}npm run nfl:week${R}${D} to use them.${R}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
