/**
 * ingest-injuries.ts — Fetches current injury reports for every league we
 * cover from the ESPN public API (free, no API key).
 *
 * Data sources:
 *   https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries
 *   https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries
 *   https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/injuries
 *   https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/injuries
 *
 * Output (one file per league, same shape):
 *   data/processed/injuries-nba.json
 *   data/processed/injuries-nfl.json
 *   data/processed/injuries-nhl.json
 *   data/processed/injuries-mlb.json
 *
 * Every league is fetched on every run; a league returning empty (offseason,
 * upstream hiccup) is tolerated and written as an empty list rather than
 * aborting the others.
 *
 * Usage: npm run ingest:injuries
 */

import fs from "node:fs";
import path from "node:path";

// Load .env (best-effort)
try {
  const envFile = path.resolve(process.cwd(), ".env");
  const lines = fs.readFileSync(envFile, "utf8").split("\n");
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
} catch { /* no .env */ }

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InjuryPlayer = {
  player: string;
  team: string;
  position: string;
  status: string;    // "Out", "Doubtful", "Questionable", "Day-To-Day", "10-Day-IL", etc.
  injuryType: string;
  returnDate: string;
};

export type InjuryOutput = {
  fetchedAt: string;
  sport: string;
  players: InjuryPlayer[];
};

// ESPN injury API response shape.
// Structure: data.injuries[] = teams, each team.injuries[] = players.
type EspnPlayerInjury = {
  status?: string;
  shortComment?: string;
  longComment?: string;
  athlete?: {
    displayName?: string;
    position?: { abbreviation?: string };
  };
  type?: { description?: string; name?: string };
  details?: {
    type?: string;          // e.g. "Achilles"
    returnDate?: string;
    fantasyStatus?: { description?: string };
  };
};

type EspnInjuryResponse = {
  injuries?: Array<{
    displayName?: string;   // team name
    injuries?: EspnPlayerInjury[];
  }>;
};

type LeagueSpec = {
  /** Output file slug + InjuryOutput.sport value. */
  sport: string;
  /** ESPN URL path segment for the sport (e.g. "basketball"). */
  espnSport: string;
  /** ESPN URL path segment for the league (e.g. "nba"). */
  espnLeague: string;
};

const LEAGUES: LeagueSpec[] = [
  { sport: "nba", espnSport: "basketball", espnLeague: "nba" },
  { sport: "nfl", espnSport: "football", espnLeague: "nfl" },
  { sport: "nhl", espnSport: "hockey", espnLeague: "nhl" },
  { sport: "mlb", espnSport: "baseball", espnLeague: "mlb" },
];

// ---------------------------------------------------------------------------
// Status filtering
// ---------------------------------------------------------------------------

// Substrings (uppercased) that mark a status as roster-relevant. Covers the
// cross-sport vocabulary ESPN uses:
//   NBA/NFL/NHL → OUT / DOUBTFUL / QUESTIONABLE / DAY-TO-DAY / IR / INJURED RESERVE
//   MLB         → 10-DAY-IL / 15-DAY-IL / 60-DAY-IL / 7-DAY IL  (all contain "IL")
//                 plus OUT / DAY-TO-DAY
// Excluded on purpose: suspension, paternity, developmental list, bereavement —
// not injury-driven volatility for our purposes.
const INCLUDE_STATUS_TOKENS = [
  "OUT",
  "DOUBTFUL",
  "QUESTIONABLE",
  "DAY-TO-DAY",
  "DAY TO DAY",
  "INJURED RESERVE",
  "IR",
  "-IL",
  " IL",
];

const EXCLUDE_STATUS_TOKENS = ["SUSPENSION", "PATERNITY", "DEVELOPMENTAL", "BEREAVEMENT"];

function isIncludedStatus(status: string): boolean {
  const s = status.toUpperCase();
  if (!s) return false;
  if (EXCLUDE_STATUS_TOKENS.some((t) => s.includes(t))) return false;
  return INCLUDE_STATUS_TOKENS.some((t) => s.includes(t));
}

// ---------------------------------------------------------------------------
// Fetch / parse
// ---------------------------------------------------------------------------

export function parseInjuryResponse(data: EspnInjuryResponse): InjuryPlayer[] {
  const players: InjuryPlayer[] = [];
  // Outer array is teams; inner array is player injuries per team.
  for (const teamEntry of data.injuries ?? []) {
    const team = (teamEntry.displayName ?? "").trim();
    if (!team) continue;

    for (const inj of teamEntry.injuries ?? []) {
      const player = (inj.athlete?.displayName ?? "").trim();
      if (!player) continue;

      const position = (inj.athlete?.position?.abbreviation ?? "").trim();
      const status = (inj.status ?? "").trim();
      const injuryType = (
        inj.details?.type ??
        inj.type?.description ??
        inj.shortComment ??
        inj.longComment ??
        ""
      ).trim();
      const returnDate = (inj.details?.returnDate ?? "").trim();

      if (!isIncludedStatus(status)) continue;

      players.push({ player, team, position, status, injuryType, returnDate });
    }
  }
  return players;
}

async function fetchInjuries(spec: LeagueSpec): Promise<InjuryPlayer[]> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${spec.espnSport}/${spec.espnLeague}/injuries`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "sports-betting-trends/1.0" },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      console.warn(`  [injuries] HTTP ${res.status} for ${spec.espnLeague}`);
      return [];
    }

    const data = (await res.json()) as EspnInjuryResponse;
    return parseInjuryResponse(data);
  } catch (err) {
    console.warn(`  [injuries] Fetch failed (${spec.espnLeague}): ${(err as Error).message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Atomic write helper
// ---------------------------------------------------------------------------

function writeAtomic(filePath: string, data: unknown): void {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    try { fs.unlinkSync(filePath); } catch { /* ok */ }
    fs.renameSync(tmp, filePath);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const root = process.cwd();
  const outDir = path.join(root, "data", "processed");
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`[injuries] Fetching ${LEAGUES.map((l) => l.sport.toUpperCase()).join(", ")} injury reports from ESPN...`);

  // Fetch every league in parallel. A single failure resolves to [] (handled
  // in fetchInjuries) and never blocks the others.
  const results = await Promise.all(LEAGUES.map((spec) => fetchInjuries(spec)));

  const fetchedAt = new Date().toISOString();
  const counts: Record<string, number> = {};

  LEAGUES.forEach((spec, i) => {
    const players = results[i];
    const output: InjuryOutput = { fetchedAt, sport: spec.sport, players };
    writeAtomic(path.join(outDir, `injuries-${spec.sport}.json`), output);
    counts[spec.sport] = players.length;
  });

  console.log(
    `[injuries] ${LEAGUES.map((l) => `${l.sport.toUpperCase()}: ${counts[l.sport]}`).join(" | ")}`
  );

  // Print notable absences for verification (OUT / DOUBTFUL / IL across all sports).
  const all = LEAGUES.flatMap((spec, i) =>
    results[i].map((p) => ({ ...p, sport: spec.sport.toUpperCase() }))
  );
  const notable = all
    .filter((p) => {
      const s = p.status.toUpperCase();
      return s.includes("OUT") || s.includes("DOUBTFUL") || s.includes("IL");
    })
    .slice(0, 8);
  for (const p of notable) {
    console.log(`  ${p.sport} [${p.team}] ${p.player} (${p.position}) — ${p.status}: ${p.injuryType || "injury"}`);
  }
}

main().catch((err) => {
  console.error("[injuries] Fatal:", err);
  process.exit(1);
});
