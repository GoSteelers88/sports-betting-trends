/**
 * ingest-injuries.ts — Fetches current NBA/NFL injury reports from ESPN public API
 *
 * Data sources (free, no API key):
 *   https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries
 *   https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries
 *
 * Output:
 *   data/processed/injuries-nba.json
 *   data/processed/injuries-nfl.json
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
  status: string;    // "Out", "Doubtful", "Questionable", "Day-To-Day", etc.
  injuryType: string;
  returnDate: string;
};

export type InjuryOutput = {
  fetchedAt: string;
  sport: string;
  players: InjuryPlayer[];
};

// ESPN injury API response shape
// Structure: data.injuries[] = teams, each team.injuries[] = players
type EspnPlayerInjury = {
  status?: string;
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

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

const INCLUDE_STATUSES = ["OUT", "DOUBTFUL", "QUESTIONABLE", "DAY-TO-DAY", "INJURED RESERVE", "IR"];

async function fetchInjuries(sport: string, league: string): Promise<InjuryPlayer[]> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/injuries`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "sports-betting-trends/1.0" },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      console.warn(`  [injuries] HTTP ${res.status} for ${league}`);
      return [];
    }

    const data = (await res.json()) as EspnInjuryResponse;
    const players: InjuryPlayer[] = [];

    // Outer array is teams; inner array is player injuries per team
    for (const teamEntry of data.injuries ?? []) {
      const team = (teamEntry.displayName ?? "").trim();
      if (!team) continue;

      for (const inj of teamEntry.injuries ?? []) {
        const player = (inj.athlete?.displayName ?? "").trim();
        const position = (inj.athlete?.position?.abbreviation ?? "").trim();
        const status = (inj.status ?? "").trim();
        const injuryType = (inj.details?.type ?? inj.type?.description ?? inj.longComment ?? "").trim();
        const returnDate = (inj.details?.returnDate ?? "").trim();

        if (!player) continue;

        // Only include meaningful statuses
        const statusUpper = status.toUpperCase();
        if (!INCLUDE_STATUSES.some((s) => statusUpper.includes(s))) continue;

        players.push({ player, team, position, status, injuryType, returnDate });
      }
    }

    return players;
  } catch (err) {
    console.warn(`  [injuries] Fetch failed (${league}): ${(err as Error).message}`);
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

  console.log("[injuries] Fetching NBA and NFL injury reports from ESPN...");

  const [nbaPlayers, nflPlayers] = await Promise.all([
    fetchInjuries("basketball", "nba"),
    fetchInjuries("football", "nfl"),
  ]);

  const nbaOutput: InjuryOutput = {
    fetchedAt: new Date().toISOString(),
    sport: "nba",
    players: nbaPlayers,
  };

  const nflOutput: InjuryOutput = {
    fetchedAt: new Date().toISOString(),
    sport: "nfl",
    players: nflPlayers,
  };

  writeAtomic(path.join(outDir, "injuries-nba.json"), nbaOutput);
  writeAtomic(path.join(outDir, "injuries-nfl.json"), nflOutput);

  console.log(`[injuries] NBA: ${nbaPlayers.length} players | NFL: ${nflPlayers.length} players`);

  // Print notable absences for verification
  const notable = [...nbaPlayers, ...nflPlayers]
    .filter((p) => p.status.toUpperCase().includes("OUT") || p.status.toUpperCase().includes("DOUBTFUL"))
    .slice(0, 6);
  for (const p of notable) {
    console.log(`  [${p.team}] ${p.player} (${p.position}) — ${p.status}: ${p.injuryType || "injury"}`);
  }
}

main().catch((err) => {
  console.error("[injuries] Fatal:", err);
  process.exit(1);
});
