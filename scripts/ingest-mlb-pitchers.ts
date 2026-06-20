/**
 * ingest-mlb-pitchers.ts
 * Fetches today's probable MLB starters from the MLB Stats API (primary)
 * and cross-references ERA/WHIP/IP from data/processed/pitcher-stats-season.json.
 * Output: data/processed/mlb-pitchers-today.json
 */

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const OUT = path.join(root, "data/processed/mlb-pitchers-today.json");
const PITCHER_STATS_PATH = path.join(root, "data/processed/pitcher-stats-season.json");
const TIMEOUT = 12000;

/** Atomic JSON write (temp + rename): a reader (the dashboard's pitcher-starter
 *  gate) must never catch a half-written file. rename() is atomic on the same
 *  filesystem, so readers see either the old file or the complete new one. */
function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

type PitcherInfo = {
  name: string;
  hand: string;
  recentEra: number | null;
  recentWhip: number | null;
  lastStartIp: number | null;
} | null;

type GameEntry = {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  homePitcher: PitcherInfo;
  awayPitcher: PitcherInfo;
};

/** Normalize a pitcher name for fuzzy matching (strip accents, lowercase) */
function normName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/** Load pitcher season stats from baseball-reference scrape */
function loadPitcherStats(): Map<string, { era: number; whip: number; ip: number }> {
  const map = new Map<string, { era: number; whip: number; ip: number }>();
  if (!fs.existsSync(PITCHER_STATS_PATH)) return map;
  try {
    const raw = JSON.parse(fs.readFileSync(PITCHER_STATS_PATH, "utf8")) as {
      pitchers?: Record<string, { era?: number; whip?: number; ip?: number }>;
    };
    for (const [name, stats] of Object.entries(raw.pitchers ?? {})) {
      map.set(normName(name), {
        era: stats.era ?? 4.5,
        whip: stats.whip ?? 1.30,
        ip: stats.ip ?? 0,
      });
    }
  } catch (e) {
    console.warn("[mlb-pitchers] Could not load pitcher-stats-season.json:", e);
  }
  return map;
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "sports-betting-trends/1.0" },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Build a PitcherInfo from a name + stats lookup */
function buildPitcherInfo(
  name: string | undefined,
  statsMap: Map<string, { era: number; whip: number; ip: number }>,
): PitcherInfo {
  if (!name) return null;
  const key = normName(name);
  const stats = statsMap.get(key);
  return {
    name,
    hand: "?", // MLB Stats API doesn't return throwing hand in schedule endpoint
    recentEra: stats?.era ?? null,
    recentWhip: stats?.whip ?? null,
    lastStartIp: stats?.ip ?? null,
  };
}

type MlbScheduleGame = {
  gamePk?: number;
  teams?: {
    home?: { team?: { name?: string }; probablePitcher?: { fullName?: string; id?: number } };
    away?: { team?: { name?: string }; probablePitcher?: { fullName?: string; id?: number } };
  };
};

/** Fetch season pitching stats for a list of pitcher IDs from the MLB Stats API */
async function fetchBulkPitcherStats(
  ids: number[],
  season: number,
): Promise<Map<number, { era: number; whip: number; ip: number }>> {
  const map = new Map<number, { era: number; whip: number; ip: number }>();
  if (!ids.length) return map;

  const url = `https://statsapi.mlb.com/api/v1/people?personIds=${ids.join(",")}&hydrate=stats(group=[pitching],type=season,season=${season})`;
  const data = (await fetchJson(url)) as {
    people?: Array<{
      id?: number;
      stats?: Array<{
        group?: { displayName?: string };
        type?: { displayName?: string };
        splits?: Array<{
          stat?: { era?: number | string; whip?: number | string; inningsPitched?: string };
        }>;
      }>;
    }>;
  } | null;

  for (const person of data?.people ?? []) {
    const pid = person.id;
    if (!pid) continue;
    for (const statGroup of person.stats ?? []) {
      if (statGroup.type?.displayName !== "season") continue;
      const split = statGroup.splits?.[0]?.stat;
      if (!split) continue;
      const eraRaw = parseFloat(String(split.era ?? "NaN"));
      const whipRaw = parseFloat(String(split.whip ?? "NaN"));
      const era = Number.isFinite(eraRaw) ? eraRaw : null;
      const whip = Number.isFinite(whipRaw) ? whipRaw : null;
      // inningsPitched from MLB API is "25.1" format (fractional outs), convert to decimal
      const ipRaw = String(split.inningsPitched ?? "0");
      const ipParts = ipRaw.split(".");
      const ipDecimal =
        parseInt(ipParts[0] ?? "0") + (parseInt(ipParts[1] ?? "0") / 3);
      if (era != null || whip != null || ipDecimal > 0) {
        map.set(pid, { era: era ?? 4.5, whip: whip ?? 1.30, ip: ipDecimal });
        break;
      }
    }
  }
  return map;
}

async function run() {
  const statsMap = loadPitcherStats();
  console.log(`[mlb-pitchers] Loaded ${statsMap.size} pitchers from season stats`);

  const today = new Date();
  const season = today.getFullYear();
  const dateStr = `${season}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${dateStr}&hydrate=probablePitcher,team`;
  console.log(`[mlb-pitchers] Fetching MLB Stats API schedule for ${dateStr}`);

  const data = (await fetchJson(url)) as {
    dates?: Array<{ games?: MlbScheduleGame[] }>;
  } | null;

  const mlbGames = data?.dates?.[0]?.games ?? [];

  if (!mlbGames.length) {
    // Distinguish "no slate today" (legit empty) from "API failed" (data === null).
    // On a fetch failure we must NOT clobber a good file with an empty one — that
    // would silently disable the dashboard's pitcher-starter gate (every probable
    // starter vanishes → no pitcher ladders) with no error surfaced. Leave the
    // last-known file in place and exit non-zero so the cron/heartbeat notices.
    if (data === null) {
      console.error("[mlb-pitchers] MLB Stats API fetch FAILED — leaving existing file untouched");
      process.exit(1);
    }
    console.warn("[mlb-pitchers] No games on today's slate — writing empty output");
    writeJsonAtomic(OUT, { fetchedAt: new Date().toISOString(), games: [] });
    return;
  }

  // Collect all pitcher IDs that have no stats in our baseball-reference file
  const missingIds: number[] = [];
  const idToName = new Map<number, string>();
  for (const game of mlbGames) {
    for (const side of [game.teams?.home, game.teams?.away]) {
      const p = side?.probablePitcher;
      if (p?.id && p?.fullName) {
        idToName.set(p.id, p.fullName);
        if (!statsMap.has(normName(p.fullName))) {
          missingIds.push(p.id);
        }
      }
    }
  }

  // Fetch season stats for pitchers missing from our local file
  if (missingIds.length) {
    console.log(`[mlb-pitchers] Fetching MLB Stats API season stats for ${missingIds.length} pitchers`);
    const mlbStats = await fetchBulkPitcherStats(missingIds, season);
    for (const [id, stats] of mlbStats) {
      const name = idToName.get(id);
      if (name) {
        statsMap.set(normName(name), stats);
        console.log(`[mlb-pitchers]   ${name}: ERA ${stats.era}, WHIP ${stats.whip}, IP ${stats.ip.toFixed(1)}`);
      }
    }
  }

  const games: GameEntry[] = [];

  for (const game of mlbGames) {
    const homeTeam = game.teams?.home?.team?.name ?? "Unknown";
    const awayTeam = game.teams?.away?.team?.name ?? "Unknown";
    const homePitcherName = game.teams?.home?.probablePitcher?.fullName;
    const awayPitcherName = game.teams?.away?.probablePitcher?.fullName;
    const eventId = String(game.gamePk ?? "");

    const homePitcher = buildPitcherInfo(homePitcherName, statsMap);
    const awayPitcher = buildPitcherInfo(awayPitcherName, statsMap);

    if (!homePitcher && !awayPitcher) {
      console.warn(`[mlb-pitchers] No confirmed starters for ${awayTeam} @ ${homeTeam}`);
    } else {
      const hp = homePitcher?.name ?? "TBD";
      const ap = awayPitcher?.name ?? "TBD";
      const hStats = homePitcher ? `ERA ${homePitcher.recentEra ?? "?"}` : "no stats";
      const aStats = awayPitcher ? `ERA ${awayPitcher.recentEra ?? "?"}` : "no stats";
      console.log(`[mlb-pitchers] ${awayTeam} @ ${homeTeam}: ${ap} (${aStats}) vs ${hp} (${hStats})`);
    }

    games.push({ eventId, homeTeam, awayTeam, homePitcher, awayPitcher });
  }

  const out = { fetchedAt: new Date().toISOString(), games };
  writeJsonAtomic(OUT, out);
  console.log(`[mlb-pitchers] Wrote ${games.length} games to ${OUT}`);
  const found = games.filter((g) => g.homePitcher || g.awayPitcher).length;
  console.log(`[mlb-pitchers] Probable starters found: ${found}/${games.length} games`);
}

run().catch((err) => {
  console.error("[mlb-pitchers] Fatal:", err);
  process.exit(1);
});
