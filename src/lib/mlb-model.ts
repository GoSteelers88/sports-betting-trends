// mlb-model.ts — TypeScript side of MLB moneyline win-probability model.
// Reads pitcher + bullpen data, calls Python sidecar, returns results.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Team name normalization: raw ESPN data uses short city-less names ("Tigers"),
// while model inputs use full names ("Detroit Tigers"). We map full → short so
// we can look up RPG/run-diff from raw rows.
// ---------------------------------------------------------------------------
const FULL_TO_SHORT: Record<string, string> = {
  "arizona diamondbacks": "diamondbacks",
  "atlanta braves": "braves",
  "baltimore orioles": "orioles",
  "boston red sox": "red sox",
  "chicago cubs": "cubs",
  "chicago white sox": "white sox",
  "cincinnati reds": "reds",
  "cleveland guardians": "guardians",
  "colorado rockies": "rockies",
  "detroit tigers": "tigers",
  "houston astros": "astros",
  "kansas city royals": "royals",
  "los angeles angels": "angels",
  "los angeles dodgers": "dodgers",
  "miami marlins": "marlins",
  "milwaukee brewers": "brewers",
  "minnesota twins": "twins",
  "new york mets": "mets",
  "new york yankees": "yankees",
  "athletics": "athletics", // Oakland/Sacramento Athletics kept as-is
  "oakland athletics": "athletics",
  "philadelphia phillies": "phillies",
  "pittsburgh pirates": "pirates",
  "san diego padres": "padres",
  "san francisco giants": "giants",
  "seattle mariners": "mariners",
  "st. louis cardinals": "cardinals",
  "tampa bay rays": "rays",
  "texas rangers": "rangers",
  "toronto blue jays": "blue jays",
  "washington nationals": "nationals",
};

/** Resolve a full team name to the short nickname used in raw ESPN data. */
function resolveShortName(fullName: string): string {
  const key = fullName.toLowerCase().trim();
  return FULL_TO_SHORT[key] ?? key; // fallback: use normalized full name as-is
}

// ---------------------------------------------------------------------------
// Static park factor lookup. Source: well-known multi-year park factor averages.
// Teams not listed default to 1.0. Coors Field is the most extreme outlier.
// This will be used until a data-driven park factor pipeline is implemented.
// ---------------------------------------------------------------------------
const PARK_FACTORS: Record<string, number> = {
  "colorado rockies": 1.15,       // Coors Field — highest altitude, most offense
  "boston red sox": 1.06,         // Fenway Park — short LF wall
  "cincinnati reds": 1.05,        // Great American Ball Park — hitter-friendly
  "texas rangers": 1.04,          // Globe Life Field
  "philadelphia phillies": 1.03,  // Citizens Bank Park
  "new york yankees": 1.02,       // Yankee Stadium — short RF porch
  "toronto blue jays": 1.01,      // Rogers Centre — turf, moderate
  "chicago cubs": 1.01,           // Wrigley Field — wind-dependent
  "houston astros": 1.00,
  "detroit tigers": 1.00,      // Comerica Park — spacious outfield, slight pitcher-friendly
  "cleveland guardians": 1.00, // Progressive Field — neutral
  "chicago white sox": 0.99,
  "minnesota twins": 0.99,        // Target Field
  "los angeles dodgers": 0.98,    // Dodger Stadium — slight pitcher-friendly
  "new york mets": 0.98,          // Citi Field
  "miami marlins": 0.98,          // loanDepot park
  "kansas city royals": 0.97,     // Kauffman Stadium
  "baltimore orioles": 0.97,
  "pittsburgh pirates": 0.97,     // PNC Park
  "atlanta braves": 0.97,         // Truist Park
  "milwaukee brewers": 0.97,      // American Family Field
  "washington nationals": 0.96,   // Nationals Park
  "st. louis cardinals": 0.96,    // Busch Stadium
  "arizona diamondbacks": 0.96,   // Chase Field
  "angeles": 0.96,
  "los angeles angels": 0.96,     // Angel Stadium
  "seattle mariners": 0.95,       // T-Mobile Park — pitcher-friendly
  "tampa bay rays": 0.95,         // Tropicana Field
  "san francisco giants": 0.94,   // Oracle Park — wind, spacious
  "athletics": 0.94,              // Sutter Health Park (Sacramento, 2025-2026)
  "oakland athletics": 0.94,
  "san diego padres": 0.92,       // Petco Park — most pitcher-friendly
};

function getParkFactor(homeTeam: string): number {
  const key = homeTeam.toLowerCase().trim();
  return PARK_FACTORS[key] ?? 1.0;
}

// Types

export type PitcherInfo = {
  name: string;
  hand: string;
  recentEra: number | null;
  recentWhip: number | null;
  lastStartIp: number | null;
} | null;

type PitcherGameEntry = {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  homePitcher: PitcherInfo;
  awayPitcher: PitcherInfo;
};

type PitcherData = {
  fetchedAt: string;
  games: PitcherGameEntry[];
};

type TeamBullpen = {
  fatigueScore: number;
  bullpenEra: number;
  gamesLast3Days: number;
};

type BullpenData = {
  fetchedAt: string;
  teams: Record<string, TeamBullpen>;
};

type BattingEntry = {
  ops: number | null;
  obp: number | null;
  slg: number | null;
  avg: number | null;
  gamesPlayed: number;
};

type BattingData = {
  fetchedAt: string;
  teams: Record<string, BattingEntry>;
};

type StandingsEntry = {
  team: string;
  abbreviation: string;
  wins: number;
  losses: number;
  winPct: number;
  pointDiff?: number;
};

export type MlbModelResult = {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  homeWinProb: number;
  awayWinProb: number;
  calibrated: boolean;
  homePitcherName: string | null;
  awayPitcherName: string | null;
};

export type MlbModelOutput = {
  generatedAt: string;
  results: MlbModelResult[];
};

// Feature defaults
const LEAGUE_AVG_ERA = 4.50;
const LEAGUE_AVG_WHIP = 1.30;
const LEAGUE_AVG_RPG = 4.5;

// Helper: fuzzy team match
function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
}

function findTeamInStandings(team: string, standings: StandingsEntry[]): StandingsEntry | null {
  const normTarget = normalize(team);
  let best: StandingsEntry | null = null;
  let bestScore = 0;
  for (const s of standings) {
    const normTeam = normalize(s.team);
    const normAbbr = normalize(s.abbreviation);
    if (normTeam === normTarget || normAbbr === normTarget) return s;
    // token overlap
    const tWords = new Set(normTarget.split(/\s+/));
    const sWords = new Set(normTeam.split(/\s+/));
    const inter = [...tWords].filter((w) => sWords.has(w)).length;
    const union = new Set([...tWords, ...sWords]).size;
    const score = union > 0 ? inter / union : 0;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return bestScore >= 0.3 ? best : null;
}

function findTeamInBullpen(team: string, bullpen: Record<string, TeamBullpen>): TeamBullpen | null {
  if (bullpen[team]) return bullpen[team];
  const normTarget = normalize(team);
  for (const [key, val] of Object.entries(bullpen)) {
    if (normalize(key) === normTarget) return val;
    const kWords = new Set(normalize(key).split(/\s+/));
    const tWords = new Set(normTarget.split(/\s+/));
    const inter = [...tWords].filter((w) => kWords.has(w)).length;
    if (inter > 0 && inter / new Set([...tWords, ...kWords]).size >= 0.4) return val;
  }
  return null;
}

// Recent RPG from raw rows
type RawRow = {
  league: string;
  team: string;
  gameDate: string;
  points: number;
  opponentPoints: number | null;
  hits: number | null;
};

// Raw ESPN data uses short team nicknames ("Tigers", "Cardinals") while the rest of the
// pipeline uses full names ("Detroit Tigers", "St. Louis Cardinals"). We resolve the full
// name to its short form before matching rows. Falls back to the full normalized name if
// no mapping is found (e.g., "Athletics" is already the short form).
function computeRpg(team: string, rows: RawRow[], daysBack: number): number | null {
  const shortName = resolveShortName(team);
  const cutoff = Date.now() - daysBack * 24 * 3600 * 1000;
  const matching = rows.filter((r) => {
    const ms = new Date(r.gameDate).getTime();
    return normalize(r.team) === shortName && ms >= cutoff && ms < Date.now();
  });
  if (!matching.length) return null;
  return matching.reduce((s, r) => s + r.points, 0) / matching.length;
}

function computeRunDiffPg(team: string, rows: RawRow[], daysBack: number): number | null {
  const shortName = resolveShortName(team);
  const cutoff = Date.now() - daysBack * 24 * 3600 * 1000;
  const matching = rows.filter((r) => {
    const ms = new Date(r.gameDate).getTime();
    return normalize(r.team) === shortName && ms >= cutoff && ms < Date.now() && r.opponentPoints != null;
  });
  if (!matching.length) return null;
  return matching.reduce((s, r) => s + r.points - (r.opponentPoints ?? 0), 0) / matching.length;
}

function computeRestDays(team: string, rows: RawRow[], gameTimeMs: number): number | null {
  const shortName = resolveShortName(team);
  const past = rows
    .filter((r) => normalize(r.team) === shortName && new Date(r.gameDate).getTime() < gameTimeMs)
    .sort((a, b) => new Date(b.gameDate).getTime() - new Date(a.gameDate).getTime());
  if (!past.length) return null;
  return Math.round((gameTimeMs - new Date(past[0].gameDate).getTime()) / 86400000);
}

// ---------------------------------------------------------------------------
// Market probability from bookmaker moneyline odds (no-vig implied probability).
// ---------------------------------------------------------------------------
type OddsOutcome = { name: string; price: number };
type OddsMarket = { key: string; outcomes: OddsOutcome[] };
type OddsBookmaker = { key: string; markets: OddsMarket[] };
type OddsEvent = {
  home_team: string;
  away_team: string;
  bookmakers: OddsBookmaker[];
};
type OddsData = { events?: OddsEvent[] };

/** Convert American moneyline to raw implied probability (includes vig). */
function americanToRawProb(ml: number): number {
  if (ml >= 0) return 100 / (ml + 100);
  const abs = Math.abs(ml);
  return abs / (abs + 100);
}

/** No-vig implied probability for home team given both moneyline prices. */
function noVigHomeProb(homePrice: number, awayPrice: number): number {
  const homeRaw = americanToRawProb(homePrice);
  const awayRaw = americanToRawProb(awayPrice);
  const sum = homeRaw + awayRaw;
  if (sum <= 0) return 0.5;
  return homeRaw / sum;
}

/** Find the best available h2h moneyline for a game from OddsAPI data.
 *  Matching is by normalized team name substring. Returns null if no match found.
 */
function findOddsEvent(homeTeam: string, awayTeam: string, oddsEvents: OddsEvent[]): OddsEvent | null {
  const normHome = normalize(homeTeam);
  const normAway = normalize(awayTeam);
  for (const ev of oddsEvents) {
    const evHome = normalize(ev.home_team);
    const evAway = normalize(ev.away_team);
    // Accept if either home-team last word matches (e.g. "tigers" in "detroit tigers")
    const homeMatch = evHome === normHome || normHome.split(" ").some((w) => evHome.endsWith(w)) || evHome.split(" ").some((w) => normHome.endsWith(w));
    const awayMatch = evAway === normAway || normAway.split(" ").some((w) => evAway.endsWith(w)) || evAway.split(" ").some((w) => normAway.endsWith(w));
    if (homeMatch && awayMatch) return ev;
  }
  return null;
}

/** Extract no-vig market probability for home team from the first available h2h bookmaker. */
function extractMarketProb(homeTeam: string, awayTeam: string, oddsData: OddsData): number {
  const events = oddsData.events ?? [];
  const ev = findOddsEvent(homeTeam, awayTeam, events);
  if (!ev) return 0.5; // no odds data — fallback documented below

  for (const book of ev.bookmakers) {
    const h2h = book.markets.find((m) => m.key === "h2h");
    if (!h2h) continue;
    const homeOutcome = h2h.outcomes.find((o) => normalize(o.name) === normalize(ev.home_team));
    const awayOutcome = h2h.outcomes.find((o) => normalize(o.name) === normalize(ev.away_team));
    if (homeOutcome && awayOutcome) {
      return noVigHomeProb(homeOutcome.price, awayOutcome.price);
    }
  }
  return 0.5; // bookmakers found but no h2h market — fallback
}

// ---------------------------------------------------------------------------
// Pitcher season stats from baseball-reference (scrape_pitcher_stats.py output).
// Used to fill null ERA/WHIP/IP from ESPN probables data.
// ---------------------------------------------------------------------------
type PitcherSeasonStats = {
  era: number | null;
  whip: number | null;
  ip: number | null;
  gs: number;
  k9: number | null;
  bb9: number | null;
};

type PitcherSeasonData = {
  fetchedAt: string;
  pitcherCount: number;
  pitchers: Record<string, PitcherSeasonStats>;
};

// ---------------------------------------------------------------------------
// Weather data from ingest_mlb_weather.py output.
// ---------------------------------------------------------------------------
type WeatherGameEntry = {
  tempF: number | null;
  windMph: number | null;
  windDir: string | null;
  precipPct: number | null;
  stadium: string;
  windFactor: number;
};

type WeatherData = {
  fetchedAt: string;
  games: Record<string, WeatherGameEntry>;
};

// Main export
export function runMlbModel(
  games: Array<{ eventId: string; homeTeam: string; awayTeam: string; commenceTimeMs: number }>,
  rootDir: string,
): MlbModelOutput {
  const pitcherPath = path.join(rootDir, "data/processed/mlb-pitchers-today.json");
  const bullpenPath = path.join(rootDir, "data/processed/mlb-bullpen.json");
  const standingsPath = path.join(rootDir, "data/processed/standings-mlb.json");
  const rawPath = path.join(rootDir, "data/raw/mlb/latest_espn_mlb.json");
  const oddsPath = path.join(rootDir, "data/processed/latest-odds-api-baseball_mlb.json");
  const battingPath = path.join(rootDir, "data/processed/mlb-batting.json");
  const pitcherStatsPath = path.join(rootDir, "data/processed/pitcher-stats-season.json");
  const weatherPath = path.join(rootDir, "data/processed/mlb-weather.json");
  const modelInputPath = path.join(rootDir, "data/processed/mlb-model-input.json");
  const modelOutputPath = path.join(rootDir, "data/processed/mlb-model-output.json");
  const pythonScript = path.join(rootDir, "scripts/python/mlb_model.py");

  const loadJson = <T>(p: string, def: T): T => fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : def;
  const pitcherData: PitcherData = loadJson(pitcherPath, { fetchedAt: "", games: [] });
  const bullpenData: BullpenData = loadJson(bullpenPath, { fetchedAt: "", teams: {} });
  const standings: StandingsEntry[] = loadJson(standingsPath, []);
  const rawRows: RawRow[] = loadJson(rawPath, []);
  const oddsData: OddsData = loadJson(oddsPath, { events: [] });
  const battingData: BattingData = loadJson(battingPath, { fetchedAt: "", teams: {} });
  // Season stats from baseball-reference — fall back to ESPN probable entry if available, then to league avg defaults
  const pitcherSeasonData: PitcherSeasonData = loadJson(pitcherStatsPath, { fetchedAt: "", pitcherCount: 0, pitchers: {} });
  const weatherData: WeatherData = loadJson(weatherPath, { fetchedAt: "", games: {} });

  // Batting lookup helper: match full team name to mlb-batting.json entry
  function findTeamBatting(teamName: string): BattingEntry | null {
    const normTarget = normalize(teamName);
    // Exact match first
    if (battingData.teams[teamName]) return battingData.teams[teamName];
    // Normalized key match
    for (const [key, val] of Object.entries(battingData.teams)) {
      if (normalize(key) === normTarget) return val;
      // Token overlap: accept if last word (nickname) matches
      const keyWords = normalize(key).split(/\s+/);
      const targetWords = normTarget.split(/\s+/);
      if (
        keyWords[keyWords.length - 1] === targetWords[targetWords.length - 1] ||
        targetWords[targetWords.length - 1] === keyWords[keyWords.length - 1]
      ) {
        return val;
      }
    }
    return null;
  }

  // Build pitcher lookup by eventId
  const pitcherByEventId = new Map<string, PitcherGameEntry>();
  for (const g of pitcherData.games) {
    pitcherByEventId.set(g.eventId, g);
  }

  // Pitcher season stats lookup: exact name first, then last-name-only fallback
  const seasonPitchers = pitcherSeasonData.pitchers ?? {};
  function lookupPitcherSeason(name: string | null | undefined): PitcherSeasonStats | null {
    if (!name) return null;
    // Exact match
    if (seasonPitchers[name]) return seasonPitchers[name];
    // Normalized case-insensitive match
    const normName = name.toLowerCase().trim();
    for (const [key, val] of Object.entries(seasonPitchers)) {
      if (key.toLowerCase().trim() === normName) return val;
    }
    // Last-name-only fallback: match if the last word of the pitcher name matches
    const lastName = normName.split(/\s+/).pop() ?? "";
    if (lastName.length >= 3) {
      for (const [key, val] of Object.entries(seasonPitchers)) {
        const keyLastName = key.toLowerCase().trim().split(/\s+/).pop() ?? "";
        if (keyLastName === lastName) return val;
      }
    }
    return null;
  }

  // Weather lookup: by home team name
  function lookupWeather(homeTeam: string): WeatherGameEntry | null {
    if (weatherData.games[homeTeam]) return weatherData.games[homeTeam];
    const normTeam = normalize(homeTeam);
    for (const [key, val] of Object.entries(weatherData.games)) {
      if (normalize(key) === normTeam) return val;
      // Last-word (nickname) match
      if (normalize(key).split(/\s+/).pop() === normTeam.split(/\s+/).pop()) return val;
    }
    return null;
  }

  const featureVectors: Array<Record<string, number | string | null>> = [];

  for (const game of games) {
    const { eventId, homeTeam, awayTeam, commenceTimeMs } = game;
    const pitcherGame = pitcherByEventId.get(eventId) ?? null;

    const homePitcher = pitcherGame?.homePitcher ?? null;
    const awayPitcher = pitcherGame?.awayPitcher ?? null;

    // Look up season stats from baseball-reference for each pitcher.
    // Season stats from baseball-reference, fall back to ESPN probable entry if available, then to league avg defaults.
    const homePitcherSeason = lookupPitcherSeason(homePitcher?.name);
    const awayPitcherSeason = lookupPitcherSeason(awayPitcher?.name);

    const homeStandings = findTeamInStandings(homeTeam, standings);
    const awayStandings = findTeamInStandings(awayTeam, standings);
    const homeBullpen = findTeamInBullpen(homeTeam, bullpenData.teams);
    const awayBullpen = findTeamInBullpen(awayTeam, bullpenData.teams);

    const homeRpg = computeRpg(homeTeam, rawRows, 14) ?? LEAGUE_AVG_RPG;
    const awayRpg = computeRpg(awayTeam, rawRows, 14) ?? LEAGUE_AVG_RPG;
    const homeRunDiff = computeRunDiffPg(homeTeam, rawRows, 14) ?? 0;
    const awayRunDiff = computeRunDiffPg(awayTeam, rawRows, 14) ?? 0;
    const homeRestDays = computeRestDays(homeTeam, rawRows, commenceTimeMs) ?? 3;
    const awayRestDays = computeRestDays(awayTeam, rawRows, commenceTimeMs) ?? 3;

    // Market probability: no-vig implied home win prob from best available bookmaker.
    // Falls back to 0.5 if the game isn't found in odds data (e.g. odds file is stale).
    const marketHomeProb = extractMarketProb(homeTeam, awayTeam, oddsData);

    // Park factor: static lookup by home team. Defaults to 1.0 if not mapped.
    // Source: multi-year park factor averages; updated manually as needed.
    const parkFactor = getParkFactor(homeTeam);

    // home_ops / away_ops: from MLB Stats API batting data (mlb-batting.json)
    const homeBatting = findTeamBatting(homeTeam);
    const awayBatting = findTeamBatting(awayTeam);
    const homeOps = homeBatting?.ops ?? null;
    const awayOps = awayBatting?.ops ?? null;

    // is_home_favorite: derive from market odds rather than defaulting to 1.
    const isHomeFavorite = marketHomeProb >= 0.5 ? 1 : 0;

    // Weather: wind_factor from mlb-weather.json (ingest_mlb_weather.py).
    // 1.08 = blowing out to CF > 15mph, 0.92 = blowing in > 15mph, 1.0 = neutral/unknown.
    const weatherEntry = lookupWeather(homeTeam);
    const windFactor = weatherEntry?.windFactor ?? 1.0;

    // ERA/WHIP/IP resolution order:
    //   1. ESPN probables (recentEra/recentWhip/lastStartIp) — most recent, game-specific
    //   2. Baseball-reference season stats (pitcher-stats-season.json) — full season aggregate
    //   3. League average defaults
    const homeEra  = homePitcher?.recentEra  ?? homePitcherSeason?.era  ?? LEAGUE_AVG_ERA;
    const awayEra  = awayPitcher?.recentEra  ?? awayPitcherSeason?.era  ?? LEAGUE_AVG_ERA;
    const homeWhip = homePitcher?.recentWhip ?? homePitcherSeason?.whip ?? LEAGUE_AVG_WHIP;
    const awayWhip = awayPitcher?.recentWhip ?? awayPitcherSeason?.whip ?? LEAGUE_AVG_WHIP;
    const homeIp   = homePitcher?.lastStartIp ?? (homePitcherSeason?.ip != null ? Math.min(homePitcherSeason.ip / Math.max(homePitcherSeason.gs, 1), 7) : 5.5);
    const awayIp   = awayPitcher?.lastStartIp ?? (awayPitcherSeason?.ip != null ? Math.min(awayPitcherSeason.ip / Math.max(awayPitcherSeason.gs, 1), 7) : 5.5);

    featureVectors.push({
      game_id: eventId,
      home_team: homeTeam,
      away_team: awayTeam,
      home_rpg: homeRpg,
      away_rpg: awayRpg,
      // home_ops / away_ops from MLB Stats API season batting stats
      home_ops: homeOps,
      away_ops: awayOps,
      // ERA/WHIP/IP: ESPN probables → baseball-reference season stats → league avg defaults
      home_era: homeEra,
      away_era: awayEra,
      home_whip: homeWhip,
      away_whip: awayWhip,
      home_pitcher_ip: homeIp,
      away_pitcher_ip: awayIp,
      home_bullpen_era: homeBullpen?.bullpenEra ?? LEAGUE_AVG_ERA,
      away_bullpen_era: awayBullpen?.bullpenEra ?? LEAGUE_AVG_ERA,
      home_bullpen_fatigue: homeBullpen?.fatigueScore ?? 0,
      away_bullpen_fatigue: awayBullpen?.fatigueScore ?? 0,
      home_rest_days: homeRestDays,
      away_rest_days: awayRestDays,
      home_win_pct: homeStandings?.winPct ?? 0.5,
      away_win_pct: awayStandings?.winPct ?? 0.5,
      home_run_diff_pg: homeRunDiff,
      away_run_diff_pg: awayRunDiff,
      is_home_favorite: isHomeFavorite,
      // No-vig implied probability from OddsAPI h2h moneylines (best available book).
      // Falls back to 0.5 only if odds file is missing or game not matched.
      market_home_prob: marketHomeProb,
      // line_movement: not yet implemented — would require opening line snapshot vs current.
      line_movement: 0,
      // Park factor: static lookup, home team ballpark. See PARK_FACTORS map above.
      park_factor: parkFactor,
      // wind_factor: 1.08 (blowing out >15mph), 0.92 (blowing in >15mph), 1.0 (neutral/unknown).
      // Source: ingest_mlb_weather.py → mlb-weather.json via Open-Meteo API.
      wind_factor: windFactor,
      // pitcher names for enriching output
      home_pitcher_name: homePitcher?.name ?? null,
      away_pitcher_name: awayPitcher?.name ?? null,
    });
  }

  // Write input for Python sidecar
  fs.writeFileSync(modelInputPath, JSON.stringify({ games: featureVectors }, null, 2));

  // Call Python sidecar
  const pythonResult = spawnSync(
    "python",
    [pythonScript, "--input", modelInputPath, "--output", modelOutputPath],
    { encoding: "utf-8", timeout: 60000 },
  );

  if (pythonResult.status !== 0) {
    console.warn("[mlb-model] Python sidecar failed:", pythonResult.stderr?.slice(0, 500));
    // Return heuristic fallback (50/50)
    return {
      generatedAt: new Date().toISOString(),
      results: games.map((g) => ({
        eventId: g.eventId,
        homeTeam: g.homeTeam,
        awayTeam: g.awayTeam,
        homeWinProb: 0.54, // slight home advantage prior
        awayWinProb: 0.46,
        calibrated: false,
        homePitcherName: pitcherByEventId.get(g.eventId)?.homePitcher?.name ?? null,
        awayPitcherName: pitcherByEventId.get(g.eventId)?.awayPitcher?.name ?? null,
      })),
    };
  }

  if (!fs.existsSync(modelOutputPath)) {
    console.warn("[mlb-model] Python sidecar produced no output file");
    return { generatedAt: new Date().toISOString(), results: [] };
  }

  const raw = JSON.parse(fs.readFileSync(modelOutputPath, "utf-8")) as {
    results: Array<{
      game_id: string;
      home_win_prob: number;
      away_win_prob: number;
      calibrated: boolean;
    }>;
  };

  const resultMap = new Map(raw.results.map((r) => [r.game_id, r]));

  const output: MlbModelOutput = {
    generatedAt: new Date().toISOString(),
    results: games.map((g) => {
      const r = resultMap.get(g.eventId);
      const pitcherGame = pitcherByEventId.get(g.eventId);
      return {
        eventId: g.eventId,
        homeTeam: g.homeTeam,
        awayTeam: g.awayTeam,
        homeWinProb: r?.home_win_prob ?? 0.54,
        awayWinProb: r?.away_win_prob ?? 0.46,
        calibrated: r?.calibrated ?? false,
        homePitcherName: pitcherGame?.homePitcher?.name ?? null,
        awayPitcherName: pitcherGame?.awayPitcher?.name ?? null,
      };
    }),
  };

  // Persist for consumption by free-stats-summary
  fs.writeFileSync(modelOutputPath, JSON.stringify(output, null, 2));
  return output;
}
