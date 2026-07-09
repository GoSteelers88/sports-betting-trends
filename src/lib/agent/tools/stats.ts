// Read-only "stat" tools for the sports-betting chatbot.
//
// Every tool here is a PURE READ: it loads a JSON snapshot from
// data/processed/<file>.json synchronously and returns a plain object. No DB,
// no network, no writes, no fs writes. On any read/parse error a tool degrades
// to { available: false, dataWarning? } — it never throws — so the money-
// adjacent chat layer can always answer honestly ("I don't have that data")
// rather than crash or fabricate.
//
// Self-contained on purpose: this file does NOT import from tools/index.ts
// (avoids an import cycle). It carries its own tiny sync reader + staleness
// note, mirroring the tone of index.ts's loadJsonWithStatus/dataWarning.

import fs from "node:fs";
import path from "node:path";
import {
  buildPropsBoard,
  type SharpProp,
  type SoftPropQuote,
  type PropsBoardRow,
} from "@/lib/props-board";

// Base dir for every file-backed tool. Resolved once at module load.
const PROCESSED = path.resolve(process.cwd(), "data", "processed");

// Staleness threshold — beyond this a file is "old" and the tool passes a
// DATA WARNING back to the chat layer in-band (same 6h cadence as index.ts).
const STALE_AGE_MS = 6 * 60 * 60 * 1000;

// ─── In-file freshness helper (shared shape with tools/index.ts) ─────────────
//
// Age is computed from the DATA'S OWN timestamp, never the filesystem mtime.
// Vercel's bundle resets mtime (~2018 → everything reads "stale") and GitHub
// Actions `checkout` resets mtime to now (→ genuinely-old files read "fresh" —
// the inverse bug). The only trustworthy clock is the timestamp the ingest
// script stamped INTO the file: fetchedAt | generatedAt | updatedAt.
//
// Returns:
//   ageMs = number  → we parsed a timestamp; age is real.
//   ageMs = null + unknownFreshness = true → file present + parsed, but no
//           parseable timestamp field (bare-array standings, absent field, or an
//           unparseable value). This is NOT "fresh" — it's UNKNOWN, and the note
//           below treats it like stale (never silent-fresh, the NaN trap).
export function freshnessFromData(
  data: unknown
): { ageMs: number | null; unknownFreshness: boolean } {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    // Bare arrays (standings-*.json) + primitives carry no envelope timestamp.
    return { ageMs: null, unknownFreshness: true };
  }
  const rec = data as Record<string, unknown>;
  const raw = rec.fetchedAt ?? rec.generatedAt ?? rec.updatedAt;
  if (typeof raw !== "string") {
    return { ageMs: null, unknownFreshness: true };
  }
  // Date.parse handles both "…Z" and "…+00:00" offsets. NaN on failure → we must
  // NOT treat that as fresh (NaN > STALE is false → silent-fresh). Route to
  // unknown instead.
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    return { ageMs: null, unknownFreshness: true };
  }
  return { ageMs: Date.now() - parsed, unknownFreshness: false };
}

// ─── Self-contained sync reader ─────────────────────────────────────────────

/**
 * Read a data/processed JSON file synchronously. Returns the parsed data (or
 * the caller's fallback on any error), the DATA'S age in ms (from its in-file
 * timestamp, NOT mtime), a `missing` flag, and `unknownFreshness` (present +
 * parsed but no readable timestamp). NEVER throws — any stat/read/parse failure
 * degrades to { data: fallback, ageMs: null, missing: true }.
 *
 * PARSE-FIRST: we must parse the JSON before we can read its timestamp; the
 * malformed-JSON path is preserved (→ missing:true, as before).
 */
export function readStat<T>(
  file: string,
  fallback: T
): { data: T; ageMs: number | null; missing: boolean; unknownFreshness: boolean } {
  const fullPath = path.join(PROCESSED, file);
  let raw: string;
  try {
    raw = fs.readFileSync(fullPath, "utf8");
  } catch {
    return { data: fallback, ageMs: null, missing: true, unknownFreshness: false };
  }
  let parsed: T;
  try {
    parsed = JSON.parse(raw) as T;
  } catch {
    return { data: fallback, ageMs: null, missing: true, unknownFreshness: false };
  }
  const { ageMs, unknownFreshness } = freshnessFromData(parsed);
  return { data: parsed, ageMs, missing: false, unknownFreshness };
}

/**
 * Human-readable staleness note for the chat layer, matching the index.ts
 * voice. Returns undefined when the file is fresh and present (the common
 * path — keeps tool output clean). `unknownFreshness` (present but no readable
 * timestamp) is treated like stale: warn, never silent-fresh.
 */
export function staleNote(
  file: string,
  ageMs: number | null,
  missing: boolean,
  unknownFreshness = false
): string | undefined {
  if (missing) {
    return `DATA ERROR: ${file} is missing. This tool returned empty/fallback data. You cannot reliably answer from missing data — say so rather than guess.`;
  }
  if (unknownFreshness) {
    return `DATA WARNING: ${file} has no freshness metadata — treat its numbers as possibly old and prefer caution over confident recency claims.`;
  }
  if (ageMs !== null && ageMs > STALE_AGE_MS) {
    const ageHrs = (ageMs / 3_600_000).toFixed(1);
    return `DATA WARNING: ${file} is ${ageHrs}h old (stale > ${STALE_AGE_MS / 3_600_000}h). Numbers may not reflect the current slate — treat with caution.`;
  }
  return undefined;
}

// ─── League → file-slug maps ────────────────────────────────────────────────

export type StatsLeague =
  | "NBA"
  | "MLB"
  | "WNBA"
  | "NFL"
  | "NHL"
  | "NCAAB"
  | "EPL"
  | "MLS"
  | "UCL";

// standings-<slug>.json exists for these leagues (no WNBA standings file).
// SOCCER (EPL/MLS/UCL) is DELIBERATELY OMITTED: StandingsRow drops draws, so a
// soccer club shows a false "W-L" record (Arsenal 22-5 for an actual 22-5-11) —
// unacceptable on a bot whose brand is "every number is real". Soccer routes to
// REFUSE upstream (router.ts); even a direct getStandings("EPL") now fails-soft
// to available:false because there is no slug here.
const STANDINGS_SLUG: Partial<Record<StatsLeague, string>> = {
  NBA: "nba",
  MLB: "mlb",
  NFL: "nfl",
  NHL: "nhl",
  NCAAB: "ncaab",
};

// <slug>-efficiency.json exists only for these leagues.
const EFFICIENCY_SLUG: Partial<Record<StatsLeague, string>> = {
  NBA: "nba",
  WNBA: "wnba",
  NHL: "nhl",
};

// player-gamelogs-<slug>.json exists only for these leagues.
const GAMELOG_SLUG: Partial<Record<StatsLeague, string>> = {
  NBA: "nba",
  MLB: "mlb",
  WNBA: "wnba",
};

// Props feeds (sharp + soft) exist for these leagues. NBA has a sharp file but
// no soft file → getPropsBoard returns available:false (nothing to devig).
const PROPS_SLUG: Partial<Record<StatsLeague, string>> = {
  NBA: "nba",
  MLB: "mlb",
  WNBA: "wnba",
};

// ─── Tool 1: getStandings ───────────────────────────────────────────────────

export type StandingsRow = {
  team: string;
  abbreviation: string;
  wins: number;
  losses: number;
  winPct: number;
  homeRecord: string;
  awayRecord: string;
  pointDiff: number;
  streak: string;
  conference: string;
};

export function getStandings(league: StatsLeague): {
  available: boolean;
  league: StatsLeague;
  teams?: StandingsRow[];
  note?: string;
  dataWarning?: string;
} {
  const slug = STANDINGS_SLUG[league];
  if (!slug) {
    return {
      available: false,
      league,
      note: `no standings snapshot for ${league}`,
    };
  }
  const file = `standings-${slug}.json`;
  const { data, ageMs, missing, unknownFreshness } = readStat<StandingsRow[]>(file, []);
  const warn = staleNote(file, ageMs, missing, unknownFreshness);
  const teams = Array.isArray(data) ? data : [];
  if (missing || teams.length === 0) {
    return {
      available: false,
      league,
      note: `no ${league} standings right now`,
      ...(warn ? { dataWarning: warn } : {}),
    };
  }
  return {
    available: true,
    league,
    teams,
    ...(warn ? { dataWarning: warn } : {}),
  };
}

// ─── Tool 2: getTeamEfficiency ──────────────────────────────────────────────

export type EfficiencyRow = {
  team: string;
  netRtg: number | null;
  offRtg: number | null;
  defRtg: number | null;
  pace: number | null;
  homeNetRtg: number | null;
  homeOffRtg: number | null;
  homeDefRtg: number | null;
  awayNetRtg: number | null;
  awayOffRtg: number | null;
  awayDefRtg: number | null;
  gamesPlayed: number | null;
};

type EfficiencyFile = {
  fetchedAt?: string;
  season?: string;
  source?: string;
  lookbackDays?: number;
  teams?: Record<string, Omit<EfficiencyRow, "team">>;
};

export function getTeamEfficiency(league: StatsLeague): {
  available: boolean;
  league: StatsLeague;
  season?: string | null;
  teams?: EfficiencyRow[];
  note?: string;
  dataWarning?: string;
} {
  const slug = EFFICIENCY_SLUG[league];
  if (!slug) {
    return {
      available: false,
      league,
      note: `no efficiency snapshot for ${league} (NBA/WNBA/NHL only)`,
    };
  }
  const file = `${slug}-efficiency.json`;
  const { data, ageMs, missing, unknownFreshness } = readStat<EfficiencyFile>(file, {});
  const warn = staleNote(file, ageMs, missing, unknownFreshness);
  const teamsObj = data.teams ?? {};
  const teams: EfficiencyRow[] = Object.entries(teamsObj)
    .map(([team, v]) => ({ team, ...v }))
    // Sorted by net rating desc for readability (best team first).
    .sort((a, b) => (b.netRtg ?? -Infinity) - (a.netRtg ?? -Infinity));
  if (missing || teams.length === 0) {
    return {
      available: false,
      league,
      note: `no ${league} efficiency numbers right now`,
      ...(warn ? { dataWarning: warn } : {}),
    };
  }
  return {
    available: true,
    league,
    season: data.season ?? null,
    teams,
    ...(warn ? { dataWarning: warn } : {}),
  };
}

// ─── Tool 3: getPlayerGamelog ───────────────────────────────────────────────

type GamelogPlayer = {
  displayName: string;
  team: string | null;
  games: Array<Record<string, unknown>>;
};
type GamelogFile = {
  generatedAt?: string;
  league?: string;
  windowDays?: number;
  players?: Record<string, GamelogPlayer>;
  leagueAverages?: Record<string, number>;
};

export function getPlayerGamelog(
  league: StatsLeague,
  player: string
): {
  available: boolean;
  league: StatsLeague;
  player?: string;
  team?: string | null;
  games?: Array<Record<string, unknown>>;
  note?: string;
  knownPlayerCount?: number;
  dataWarning?: string;
} {
  const slug = GAMELOG_SLUG[league];
  if (!slug) {
    return {
      available: false,
      league,
      note: `no game-log snapshot for ${league} (NBA/MLB/WNBA only)`,
    };
  }
  if (!player || !player.trim()) {
    return { available: false, league, note: "player name is required" };
  }
  const file = `player-gamelogs-${slug}.json`;
  const { data, ageMs, missing, unknownFreshness } = readStat<GamelogFile>(file, {});
  const warn = staleNote(file, ageMs, missing, unknownFreshness);
  const players = data.players ?? {};
  const knownPlayerCount = Object.keys(players).length;

  if (missing || knownPlayerCount === 0) {
    return {
      available: false,
      league,
      note: `no ${league} game-log data right now`,
      knownPlayerCount,
      ...(warn ? { dataWarning: warn } : {}),
    };
  }

  const query = player.trim().toLowerCase();
  // 1) exact case-insensitive key match (keys are already lowercased).
  let hit: GamelogPlayer | undefined = players[query];
  // 2) loose contains match on the query's last token (last name) against the
  //    displayName — handles "Yelich" or "christian yelich " variants.
  if (!hit) {
    const lastToken = query.split(/\s+/).filter(Boolean).pop() ?? query;
    hit = Object.values(players).find((p) => {
      const dn = (p.displayName ?? "").toLowerCase();
      return dn === query || dn.includes(query) || dn.includes(lastToken);
    });
  }

  if (!hit) {
    return {
      available: false,
      league,
      note: `player not in the ${league} game-log window`,
      knownPlayerCount,
      ...(warn ? { dataWarning: warn } : {}),
    };
  }

  return {
    available: true,
    league,
    player: hit.displayName,
    team: hit.team ?? null,
    games: hit.games ?? [],
    ...(warn ? { dataWarning: warn } : {}),
  };
}

// ─── Tool 4: getPropsBoard ──────────────────────────────────────────────────

type SharpPropsFile = { fetchedAt?: string; props?: SharpProp[] };
type SoftPropsFile = { fetchedAt?: string; quotes?: SoftPropQuote[] };

export type PropsBoardResult = {
  available: boolean;
  league: StatsLeague;
  count?: number;
  playable?: PropsBoardRow[];
  topByEv?: PropsBoardRow[];
  note?: string;
  dataWarning?: string;
};

// A loaded feed as the disk shell hands it to the pure core: the parsed file,
// its data-derived age (from readStat, NOT mtime), and the missing/unknown flags.
type LoadedFeed<T> = {
  data: T;
  ageMs: number | null;
  missing: boolean;
  unknownFreshness: boolean;
};

// A feed is "stale" for board-join purposes when EITHER its own fetchedAt age is
// past the staleness budget, OR its freshness is unknown (no parseable
// timestamp) — both mean "I can't prove these are tonight's prices." A stale
// side must never be joined against a fresh side (that's the phantom-join: fresh
// sharp lines priced against yesterday's soft prices → invented +EV).
function feedIsStale(feed: LoadedFeed<unknown>): boolean {
  if (feed.missing) return true;
  if (feed.unknownFreshness) return true;
  return feed.ageMs !== null && feed.ageMs > STALE_AGE_MS;
}

// The newest commence across a set of rows, in ms. NaN/absent → -Infinity so an
// unparseable set reads as "already past" (conservative). Used to catch the case
// where fetchedAt LOOKS fresh but every game in the file has already started
// (e.g. a scraper that re-stamps fetchedAt but returns a cached old slate).
function newestCommenceMs(rows: Array<{ commence?: string }>): number {
  let newest = -Infinity;
  for (const r of rows) {
    const t = new Date(r.commence ?? "").getTime();
    if (Number.isFinite(t) && t > newest) newest = t;
  }
  return newest;
}

/**
 * PURE CORE — decide the props-board result from ALREADY-LOADED feeds + a clock.
 * No fs, no I/O; deterministic in (sharp, soft, league, nowMs). This is where the
 * phantom-join guard + commence filter live so they can be unit-tested with
 * fixtures and an injected `now`, without touching disk. The disk shell
 * (getPropsBoard) is the only thing that reads files.
 */
export function buildPropsBoardResult(
  league: StatsLeague,
  sharpLoaded: LoadedFeed<SharpPropsFile>,
  softLoaded: LoadedFeed<SoftPropsFile>,
  nowMs: number,
  sharpFileName: string,
  softFileName: string,
): PropsBoardResult {
  const sharp = sharpLoaded.data.props ?? [];
  const soft = softLoaded.data.quotes ?? [];

  // Either feed missing/empty → no board to build. NBA hits this naturally
  // (sharp file present, no soft file) — that's correct, not an error. This is
  // the honest-empty path (sharp present + soft empty → available:false); do NOT
  // weaken it.
  if (
    sharpLoaded.missing ||
    softLoaded.missing ||
    sharp.length === 0 ||
    soft.length === 0
  ) {
    return {
      available: false,
      league,
      note: `no ${league} sharp/soft prop feed right now`,
    };
  }

  // EITHER-SIDE-STALE GATE (phantom-join guard). If either feed's own fetchedAt
  // is stale/unknown, OR its newest game has already started, we refuse to join
  // fresh × stale. A fresh sharp file joined onto YESTERDAY's soft prices would
  // manufacture +EV rows that don't exist. Off-window this makes the board
  // honestly empty → the persona then says "I don't have tonight's prop board in
  // front of me right now", never a phantom play.
  const sharpStale = feedIsStale(sharpLoaded) || newestCommenceMs(sharp.map(p => ({ commence: p.cutoffAt }))) <= nowMs;
  const softStale = feedIsStale(softLoaded) || newestCommenceMs(soft) <= nowMs;
  if (sharpStale || softStale) {
    return {
      available: false,
      league,
      note: `no fresh ${league} prop board right now`,
    };
  }

  // COMMENCE FILTER — drop rows whose game has already started (commence <= now),
  // matching getHomeRunLikes' `commenceMs <= nowMs` no-look-ahead rule. The board
  // row's `commence` is threaded from the soft quote by buildPropsBoard.
  const rows = buildPropsBoard(sharp, soft, league).filter((r) => {
    const t = new Date(r.commence).getTime();
    return Number.isFinite(t) && t > nowMs;
  });

  // Every row's game already started → nothing upcoming to quote. Honest-empty,
  // not a build error.
  if (rows.length === 0) {
    return {
      available: false,
      league,
      note: `no upcoming ${league} prop games right now`,
    };
  }

  const byEvDesc = [...rows].sort((a, b) => b.evPct - a.evPct);
  const playable = byEvDesc.filter((r) => r.playable).slice(0, 15);
  const topByEv = byEvDesc.slice(0, 15);

  // Staleness of either feed is worth surfacing (older = pre-lock lines). The
  // hard stale gate above already returned available:false for a truly-stale
  // feed; this note only fires in the fresh-but-borderline band the gate lets
  // through (it won't, given the gate, but keep it so the wiring is honest if
  // the thresholds ever diverge).
  const warn =
    staleNote(sharpFileName, sharpLoaded.ageMs, sharpLoaded.missing, sharpLoaded.unknownFreshness) ??
    staleNote(softFileName, softLoaded.ageMs, softLoaded.missing, softLoaded.unknownFreshness);

  return {
    available: true,
    league,
    count: rows.length,
    playable,
    topByEv,
    ...(warn ? { dataWarning: warn } : {}),
  };
}

/**
 * DISK SHELL — load the two feeds and delegate to the pure core. `now` is
 * injectable for testing; defaults to the real clock. Never throws: readStat
 * fail-softs to missing:true, and the core returns available:false for every
 * empty/stale/off-window case.
 */
export function getPropsBoard(
  league: StatsLeague,
  now: Date = new Date(),
): PropsBoardResult {
  const slug = PROPS_SLUG[league];
  if (!slug) {
    return {
      available: false,
      league,
      note: `no sharp/soft prop feed for ${league}`,
    };
  }
  const sharpFile = `latest-sharp-props-${slug}.json`;
  const softFile = `latest-soft-props-${slug}.json`;
  const sharpLoaded = readStat<SharpPropsFile>(sharpFile, {});
  const softLoaded = readStat<SoftPropsFile>(softFile, {});

  return buildPropsBoardResult(
    league,
    sharpLoaded,
    softLoaded,
    now.getTime(),
    sharpFile,
    softFile,
  );
}

// ─── Tool 5: getProbablePitchers (MLB only) ─────────────────────────────────

type RawProbablePitcher = string | { name?: string } | null | undefined;
type PitchersTodayGame = {
  eventId?: string;
  homeTeam?: string;
  awayTeam?: string;
  homePitcher?: RawProbablePitcher;
  awayPitcher?: RawProbablePitcher;
};
type PitchersTodayFile = { fetchedAt?: string; games?: PitchersTodayGame[] };

type StatcastRow = {
  xera?: number | null;
  xwobaAgainst?: number | null;
  wobaAgainst?: number | null;
  estSlgAgainst?: number | null;
  estBaAgainst?: number | null;
  pa?: number | null;
};
type StatcastFile = { fetchedAt?: string; pitchers?: Record<string, StatcastRow> };

function pitcherName(p: RawProbablePitcher): string | null {
  if (!p) return null;
  if (typeof p === "string") return p.trim() || null;
  return (p.name ?? "").trim() || null;
}

export function getProbablePitchers(): {
  available: boolean;
  games?: Array<{
    homeTeam: string;
    awayTeam: string;
    homePitcher: { name: string | null; statcast?: StatcastRow };
    awayPitcher: { name: string | null; statcast?: StatcastRow };
  }>;
  note?: string;
  dataWarning?: string;
} {
  const pFile = "mlb-pitchers-today.json";
  const scFile = "statcast-pitching.json";
  const pLoaded = readStat<PitchersTodayFile>(pFile, {});
  const scLoaded = readStat<StatcastFile>(scFile, {});

  const rawGames = pLoaded.data.games ?? [];
  if (pLoaded.missing || rawGames.length === 0) {
    return {
      available: false,
      note: "no probable-pitchers data right now",
      ...(staleNote(pFile, pLoaded.ageMs, pLoaded.missing, pLoaded.unknownFreshness)
        ? { dataWarning: staleNote(pFile, pLoaded.ageMs, pLoaded.missing, pLoaded.unknownFreshness) }
        : {}),
    };
  }

  // Case-insensitive statcast lookup by pitcher name.
  const statcast = scLoaded.data.pitchers ?? {};
  const scByLower = new Map<string, StatcastRow>();
  for (const [name, row] of Object.entries(statcast)) {
    scByLower.set(name.toLowerCase(), row);
  }
  const lookup = (name: string | null): StatcastRow | undefined => {
    if (!name) return undefined;
    return scByLower.get(name.toLowerCase());
  };

  const games = rawGames.map((g) => {
    const homeName = pitcherName(g.homePitcher);
    const awayName = pitcherName(g.awayPitcher);
    const homeSc = lookup(homeName);
    const awaySc = lookup(awayName);
    return {
      homeTeam: g.homeTeam ?? "",
      awayTeam: g.awayTeam ?? "",
      homePitcher: {
        name: homeName,
        ...(homeSc ? { statcast: homeSc } : {}),
      },
      awayPitcher: {
        name: awayName,
        ...(awaySc ? { statcast: awaySc } : {}),
      },
    };
  });

  const warn =
    staleNote(pFile, pLoaded.ageMs, pLoaded.missing, pLoaded.unknownFreshness) ??
    staleNote(scFile, scLoaded.ageMs, scLoaded.missing, scLoaded.unknownFreshness);

  return {
    available: true,
    games,
    ...(warn ? { dataWarning: warn } : {}),
  };
}

// ─── Tool 6: getMlbTeamStats (MLB only) ─────────────────────────────────────

type BattingRow = {
  ops?: number | null;
  obp?: number | null;
  slg?: number | null;
  avg?: number | null;
  gamesPlayed?: number | null;
};
type BullpenRow = {
  fatigueScore?: number | null;
  bullpenEra?: number | null;
  gamesLast3Days?: number | null;
};
type WeatherRow = {
  tempF?: number | null;
  windMph?: number | null;
  windDir?: string | null;
  precipPct?: number | null;
  stadium?: string | null;
  windFactor?: number | null;
};
type KeyedTeamFile<T> = { fetchedAt?: string; teams?: Record<string, T> };
type WeatherFile = { fetchedAt?: string; games?: Record<string, WeatherRow> };

// Resolve a team against an object's keys. Batting/weather key on FULL names,
// bullpen keys on the SHORT name (last token, e.g. "Cardinals"). We match on
// the query's last token contained in a key OR the key's last token contained
// in the query — a symmetric, case-insensitive "same team" test that handles
// "St. Louis Cardinals" ↔ "Cardinals" both directions.
function resolveKeyed<T>(
  obj: Record<string, T> | undefined,
  team: string
): T | undefined {
  if (!obj) return undefined;
  const q = team.trim().toLowerCase();
  if (!q) return undefined;
  const qLast = q.split(/\s+/).filter(Boolean).pop() ?? q;
  for (const [key, val] of Object.entries(obj)) {
    const k = key.toLowerCase();
    if (k === q) return val;
    const kLast = k.split(/\s+/).filter(Boolean).pop() ?? k;
    if (k.includes(q) || q.includes(k)) return val;
    if (kLast && (kLast === qLast || q.includes(kLast) || k.includes(qLast))) {
      return val;
    }
  }
  return undefined;
}

export function getMlbTeamStats(team: string): {
  available: boolean;
  team: string;
  batting?: BattingRow;
  bullpen?: BullpenRow;
  weather?: WeatherRow;
  note?: string;
  dataWarning?: string;
} {
  if (!team || !team.trim()) {
    return { available: false, team: team ?? "", note: "team name is required" };
  }
  const battingFile = "mlb-batting.json";
  const bullpenFile = "mlb-bullpen.json";
  const weatherFile = "mlb-weather.json";
  const battingLoaded = readStat<KeyedTeamFile<BattingRow>>(battingFile, {});
  const bullpenLoaded = readStat<KeyedTeamFile<BullpenRow>>(bullpenFile, {});
  const weatherLoaded = readStat<WeatherFile>(weatherFile, {});

  const batting = resolveKeyed(battingLoaded.data.teams, team);
  const bullpen = resolveKeyed(bullpenLoaded.data.teams, team);
  const weather = resolveKeyed(weatherLoaded.data.games, team);

  const warn =
    staleNote(battingFile, battingLoaded.ageMs, battingLoaded.missing, battingLoaded.unknownFreshness) ??
    staleNote(bullpenFile, bullpenLoaded.ageMs, bullpenLoaded.missing, bullpenLoaded.unknownFreshness) ??
    staleNote(weatherFile, weatherLoaded.ageMs, weatherLoaded.missing, weatherLoaded.unknownFreshness);

  // available only if we resolved the team in at least one of the three files.
  if (!batting && !bullpen && !weather) {
    return {
      available: false,
      team,
      note: `no MLB batting/bullpen/weather rows matched "${team}"`,
      ...(warn ? { dataWarning: warn } : {}),
    };
  }

  return {
    available: true,
    team,
    ...(batting ? { batting } : {}),
    ...(bullpen ? { bullpen } : {}),
    ...(weather ? { weather } : {}),
    ...(warn ? { dataWarning: warn } : {}),
  };
}

// ─── Tool 7: getParlayBook ──────────────────────────────────────────────────

type ParlayLedgerRow = {
  ts: string;
  equityUsd: number;
  realizedPnlUsd: number;
  exposureUsd: number;
  openCount: number;
  settledCount: number;
  wins: number;
  losses: number;
};
type ParlayBookFile = {
  updatedAt?: string;
  // May be an object keyed by parlay id, OR (currently) an empty array.
  // Object.values() handles both shapes identically.
  parlays?: Record<string, unknown> | unknown[];
  ledger?: ParlayLedgerRow[];
};

export function getParlayBook(): {
  available: boolean;
  updatedAt?: string | null;
  openParlays?: unknown[];
  latestLedger?: ParlayLedgerRow | null;
  note?: string;
  dataWarning?: string;
} {
  const file = "parlay-paper-book.json";
  const { data, ageMs, missing, unknownFreshness } = readStat<ParlayBookFile>(file, {});
  const warn = staleNote(file, ageMs, missing, unknownFreshness);

  if (missing) {
    return {
      available: false,
      note: "no parlay paper book right now",
      ...(warn ? { dataWarning: warn } : {}),
    };
  }

  // Object.values works for both an object-of-parlays and an empty array.
  const openParlays = Object.values(data.parlays ?? {});
  const ledger = data.ledger ?? [];
  const latestLedger = ledger.length > 0 ? ledger[ledger.length - 1] : null;

  return {
    available: true,
    updatedAt: data.updatedAt ?? null,
    openParlays,
    latestLedger,
    ...(warn ? { dataWarning: warn } : {}),
  };
}

// ─── Tool 8: getDeskRecord (NOT a file read — injected) ─────────────────────

export type DeskRecord = {
  byLeague: Array<{
    league: string;
    windowDays: number;
    total: number;
    wins: number;
    losses: number;
    pushes: number;
    pnlUnits: number;
    roi: number | null;
  }>;
  overall: {
    total: number;
    wins: number;
    losses: number;
    pnlUnits: number;
    roi: number | null;
  };
};

export function getDeskRecord(
  record: DeskRecord | null
):
  | { available: false; note: string }
  | ({ available: true } & DeskRecord) {
  if (record === null) {
    return { available: false, note: "desk record not loaded" };
  }
  return { available: true, ...record };
}

// ─── Tool names + Anthropic tool definitions ────────────────────────────────

export const STATS_TOOL_NAMES = [
  "get_standings",
  "get_team_efficiency",
  "get_player_gamelog",
  "get_props_board",
  "get_probable_pitchers",
  "get_mlb_team_stats",
  "get_parlay_book",
  "get_desk_record",
] as const;

export type StatsToolName = (typeof STATS_TOOL_NAMES)[number];

// ─── PURE stat tools (the stats-mode allowlist) ─────────────────────────────
//
// STATS mode (a league we do NOT bet — NFL/NHL/NCAAB) must be STRUCTURALLY
// incapable of surfacing a playable bet. `get_props_board` and `get_parlay_book`
// are bet-shaped: the props board returns +EV plays (book/side/price/EV) and the
// parlay book returns open +EV parlays — so they are EXCLUDED from stats mode.
//
// `get_desk_record` STAYS in stats mode on purpose: it's the desk's honest,
// league-independent settled track record (CLV/ROI/W-L), useful for "how's the
// desk doing?" even in a hockey conversation. It surfaces no play.
export const BET_SHAPED_STATS_TOOL_NAMES = [
  "get_props_board",
  "get_parlay_book",
] as const;

export type BetShapedStatsToolName =
  (typeof BET_SHAPED_STATS_TOOL_NAMES)[number];

const BET_SHAPED_SET: ReadonlySet<string> = new Set(BET_SHAPED_STATS_TOOL_NAMES);

// The stats-mode tool surface = every stat tool MINUS the two bet-shaped ones.
// get_desk_record is retained (it lives in STATS_TOOL_NAMES and is not
// bet-shaped, so it survives this filter).
export const PURE_STATS_TOOL_NAMES = STATS_TOOL_NAMES.filter(
  (n) => !BET_SHAPED_SET.has(n)
) as Exclude<StatsToolName, BetShapedStatsToolName>[];

// Leagues that actually have a standings file (drives the enum on get_standings).
const STANDINGS_LEAGUES = Object.keys(STANDINGS_SLUG) as StatsLeague[];
const EFFICIENCY_LEAGUES = Object.keys(EFFICIENCY_SLUG) as StatsLeague[];
const GAMELOG_LEAGUES = Object.keys(GAMELOG_SLUG) as StatsLeague[];
const PROPS_LEAGUES = Object.keys(PROPS_SLUG) as StatsLeague[];

export const STATS_TOOL_DEFINITIONS = [
  {
    name: "get_standings",
    description:
      "Read-only league standings snapshot. Returns every team's win/loss record, win %, home/away splits, point (or run) differential, current streak, and conference. Covers NBA, MLB, NFL, NHL, and NCAAB (no WNBA standings; no soccer — soccer records drop draws and would be false). Numbers are from the latest committed snapshot, not live — surface the dataWarning if present.",
    input_schema: {
      type: "object" as const,
      properties: {
        league: { type: "string", enum: STANDINGS_LEAGUES },
      },
      required: ["league"],
    },
  },
  {
    name: "get_team_efficiency",
    description:
      "Read-only team efficiency ratings, sorted best-first by net rating. Returns per-team offensive/defensive/net rating, pace, and home/away splits over the recent lookback window. Available for NBA, WNBA, and NHL only; other leagues return available:false. Snapshot data, not live.",
    input_schema: {
      type: "object" as const,
      properties: {
        league: { type: "string", enum: EFFICIENCY_LEAGUES },
      },
      required: ["league"],
    },
  },
  {
    name: "get_player_gamelog",
    description:
      "Read-only recent game log for one player over the last ~14 days. Returns the player's per-game stat lines (points/rebounds/assists for hoops, hits/HR/RBI/runs/K for MLB) plus their team. Available for NBA, MLB, and WNBA. Looks the player up case-insensitively with a last-name fallback; returns available:false with a note when the player isn't in the window. Snapshot data, not live.",
    input_schema: {
      type: "object" as const,
      properties: {
        league: { type: "string", enum: GAMELOG_LEAGUES },
        player: { type: "string", description: "Full player display name" },
      },
      required: ["league", "player"],
    },
  },
  {
    name: "get_props_board",
    description:
      "Read-only player-prop value board: de-vigged sharp (Pinnacle) fair probabilities vs soft-book prices, per prop. Returns the top rows by EV and the subset that clears the playable EV floor, each with player, propType, line, side, book, soft American price, fair probability, EV %, and whether it's a home-run-like flag. Available for MLB and WNBA (NBA has no soft feed → available:false). Snapshot data, not live — do not treat as a placed bet.",
    input_schema: {
      type: "object" as const,
      properties: {
        league: { type: "string", enum: PROPS_LEAGUES },
      },
      required: ["league"],
    },
  },
  {
    name: "get_probable_pitchers",
    description:
      "MLB-only, read-only. Returns today's probable starting pitchers for each game, each annotated with Statcast quality-of-contact metrics when available (xERA, xwOBA-against, wOBA-against, expected SLG/BA against, plate appearances). Use to gauge starting-pitcher matchups. Snapshot data, not live.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_mlb_team_stats",
    description:
      "MLB-only, read-only. Returns a team's offensive profile (OPS/OBP/SLG/AVG, games played), bullpen fatigue (fatigue score, bullpen ERA, games in last 3 days), and today's park weather (temp, wind speed/direction, precip chance, stadium, wind factor). Pass the team name in any common form (full name or nickname); resolved case-insensitively. Snapshot data, not live.",
    input_schema: {
      type: "object" as const,
      properties: {
        team: {
          type: "string",
          description:
            "Team name, full or nickname (e.g. 'St. Louis Cardinals' or 'Cardinals').",
        },
      },
      required: ["team"],
    },
  },
  {
    name: "get_parlay_book",
    description:
      "Read-only paper-trading parlay book. Returns the currently open parlays and the latest ledger snapshot (equity, realized P&L, exposure, open/settled counts, wins, losses). Measurement-only paper book — no real money. Snapshot data, not live.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_desk_record",
    description:
      "Read-only quant-desk paper track record. Returns the desk's per-league and overall settled record (total picks, wins, losses, pushes, P&L in units, ROI). The record is loaded by the chat layer from the database and passed in; if it isn't loaded, returns available:false. Historical performance, not a prediction.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// Definitions for the stats-mode surface (built from PURE_STATS_TOOL_NAMES so a
// bet-shaped tool — get_props_board / get_parlay_book — can never leak into a
// stats turn via the defs). This is the single source the stats-mode Lane B
// hands the model.
export const PURE_STATS_TOOL_DEFINITIONS = STATS_TOOL_DEFINITIONS.filter((d) =>
  (PURE_STATS_TOOL_NAMES as readonly string[]).includes(d.name)
);

// ─── Handler dispatch table ─────────────────────────────────────────────────

/**
 * Build the tool-name → handler map for the stats tools. `deskRecord` is the
 * one injected dependency (the chat layer fetches it from the DB async and
 * passes it in) — get_desk_record's handler ignores its input and returns
 * getDeskRecord(deskRecord). Every other handler is a pure file read.
 */
export function buildStatsHandlers(
  deskRecord: DeskRecord | null = null
): Record<string, (input: unknown) => unknown> {
  return {
    get_standings: (input) =>
      getStandings((input as { league: StatsLeague }).league),
    get_team_efficiency: (input) =>
      getTeamEfficiency((input as { league: StatsLeague }).league),
    get_player_gamelog: (input) => {
      const i = input as { league: StatsLeague; player: string };
      return getPlayerGamelog(i.league, i.player);
    },
    get_props_board: (input) =>
      getPropsBoard((input as { league: StatsLeague }).league),
    get_probable_pitchers: () => getProbablePitchers(),
    get_mlb_team_stats: (input) =>
      getMlbTeamStats((input as { team: string }).team),
    get_parlay_book: () => getParlayBook(),
    get_desk_record: () => getDeskRecord(deskRecord),
  };
}
