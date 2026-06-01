// mlb-model.ts — TypeScript side of MLB moneyline win-probability model.
// Reads pitcher + bullpen data, calls Python sidecar, returns results.

import fs from "node:fs";
import path from "node:path";

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

export type MlbModelResult = {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  homeWinProb: number;      // final, after shrinkage toward market
  awayWinProb: number;
  calibrated: boolean;
  homePitcherName: string | null;
  awayPitcherName: string | null;
  // Transparency / backtest fields (optional; structured model only):
  modelHomeProbRaw?: number;   // pre-shrinkage structured prob
  marketHomeProb?: number;     // no-vig implied prob used as shrink anchor
  homeExpRuns?: number;        // expected runs (structured)
  awayExpRuns?: number;
  shrinkWeight?: number;       // w used to blend model vs market
};

export type MlbModelOutput = {
  generatedAt: string;
  results: MlbModelResult[];
};

// Feature defaults
const LEAGUE_AVG_ERA = 4.50;
const LEAGUE_AVG_RPG = 4.5;

// Helper: fuzzy team match
function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
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
// Forward-looking Statcast pitching (ingest_statcast_pitching.py output).
// xERA is Statcast's contact-quality ERA estimator — the predictive replacement
// for lagging season ERA. xwobaAgainst is expected wOBA allowed.
// ---------------------------------------------------------------------------
type StatcastPitcher = {
  xera: number | null;
  xwobaAgainst: number | null;
  pa: number | null;
};

type StatcastPitchingData = {
  fetchedAt: string;
  season: number;
  pitcherCount: number;
  pitchers: Record<string, StatcastPitcher>;
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
  const rawPath = path.join(rootDir, "data/raw/mlb/latest_espn_mlb.json");
  const oddsPath = path.join(rootDir, "data/processed/latest-odds-api-baseball_mlb.json");
  const pitcherStatsPath = path.join(rootDir, "data/processed/pitcher-stats-season.json");
  const statcastPath = path.join(rootDir, "data/processed/statcast-pitching.json");
  const weatherPath = path.join(rootDir, "data/processed/mlb-weather.json");
  const modelInputPath = path.join(rootDir, "data/processed/mlb-model-input.json");
  const modelOutputPath = path.join(rootDir, "data/processed/mlb-model-output.json");

  const loadJson = <T>(p: string, def: T): T => fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : def;
  const pitcherData: PitcherData = loadJson(pitcherPath, { fetchedAt: "", games: [] });
  const bullpenData: BullpenData = loadJson(bullpenPath, { fetchedAt: "", teams: {} });
  const rawRows: RawRow[] = loadJson(rawPath, []);
  const oddsData: OddsData = loadJson(oddsPath, { events: [] });
  // Season stats from baseball-reference — fall back to ESPN probable entry if available, then to league avg defaults
  const pitcherSeasonData: PitcherSeasonData = loadJson(pitcherStatsPath, { fetchedAt: "", pitcherCount: 0, pitchers: {} });
  const statcastData: StatcastPitchingData = loadJson(statcastPath, { fetchedAt: "", season: 0, pitcherCount: 0, pitchers: {} });
  const weatherData: WeatherData = loadJson(weatherPath, { fetchedAt: "", games: {} });

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

  // Statcast pitcher lookup: exact → normalized → last-name fallback (mirrors season lookup)
  const statcastPitchers = statcastData.pitchers ?? {};
  function lookupStatcast(name: string | null | undefined): StatcastPitcher | null {
    if (!name) return null;
    if (statcastPitchers[name]) return statcastPitchers[name];
    const normName = name.toLowerCase().trim();
    for (const [key, val] of Object.entries(statcastPitchers)) {
      if (key.toLowerCase().trim() === normName) return val;
    }
    const lastName = normName.split(/\s+/).pop() ?? "";
    if (lastName.length >= 3) {
      for (const [key, val] of Object.entries(statcastPitchers)) {
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

  // -------------------------------------------------------------------------
  // Structured win-probability model (replaces the LightGBM sidecar for MLB).
  //
  // Per game:
  //   1. Expected runs ALLOWED from forward-looking pitching: starter xERA
  //      (Statcast contact-quality) for its expected innings + bullpen ERA for
  //      the rest, park/wind adjusted.
  //   2. Expected runs SCORED via a multiplicative (log5-style) blend of the
  //      offense's recent run rate and the opponent's run prevention.
  //   3. Pythagorean expectation (exp 1.83) → each team's win prob; add HFA.
  //   4. SHRINK toward the no-vig market prob — the core CLV fix.
  //
  // Shrinkage: final = w·model + (1-w)·market. We deviate from the line only in
  // proportion to w, so a phantom model edge can't blow past the grader floor.
  //
  // Default w=0.3 (heavy shrinkage) is deliberate: two leak-free CLV backtests
  // (2026-06-01, ~688 games) found NO demonstrated edge vs the MLB moneyline
  // market — 26-45% CLV beat-rate at meaningful n, ROI ~0 to negative. MLB ML is
  // too efficient to beat with free data, so we mostly defer to the line. See
  // memory project_sports_betting_mlb_model. Raise w (env MLB_SHRINK_W) only if a
  // future backtest clears ≥55% CLV beat-rate at n≥50.
  // -------------------------------------------------------------------------
  const MIN_XERA_PA = 40;            // batters faced before we trust a starter's xERA
  const LEAGUE_AVG_XERA = 4.10;      // ~2026 league xERA
  const PYTHAG_EXP = 1.83;           // Pythagorean exponent for MLB
  const HOME_FIELD_WINPROB = 0.025;  // MLB home teams win ~52.5%
  const SHRINK_W = (() => {
    const env = Number(process.env.MLB_SHRINK_W);
    return Number.isFinite(env) && env > 0 && env <= 1 ? env : 0.3;
  })();

  const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

  // Starter run-prevention (RA/9): prefer Statcast xERA (forward-looking) when the
  // sample is real, else baseball-ref season ERA, else recent ERA, else league avg.
  function starterRa9(
    pitcher: PitcherInfo,
    season: PitcherSeasonStats | null,
    statcast: StatcastPitcher | null,
  ): number {
    if (statcast?.xera != null && (statcast.pa ?? 0) >= MIN_XERA_PA) return statcast.xera;
    if (season?.era != null) return season.era;
    if (pitcher?.recentEra != null) return pitcher.recentEra;
    return LEAGUE_AVG_XERA;
  }

  // Full-game RA/9: starter for its expected innings, bullpen for the remainder.
  function teamRa9(starterRa: number, starterIp: number, bullpenEra: number): number {
    const ip = clamp(starterIp, 3, 7);
    return starterRa * (ip / 9) + bullpenEra * ((9 - ip) / 9);
  }

  const results: MlbModelResult[] = [];
  const inputRecord: Array<Record<string, number | string | null>> = [];

  for (const game of games) {
    const { eventId, homeTeam, awayTeam } = game;
    const pitcherGame = pitcherByEventId.get(eventId) ?? null;
    const homePitcher = pitcherGame?.homePitcher ?? null;
    const awayPitcher = pitcherGame?.awayPitcher ?? null;

    // Pitcher run-prevention inputs: Statcast xERA → season ERA → recent ERA → league avg.
    const homePitcherSeason = lookupPitcherSeason(homePitcher?.name);
    const awayPitcherSeason = lookupPitcherSeason(awayPitcher?.name);
    const homeStatcast = lookupStatcast(homePitcher?.name);
    const awayStatcast = lookupStatcast(awayPitcher?.name);

    const homeBullpen = findTeamInBullpen(homeTeam, bullpenData.teams);
    const awayBullpen = findTeamInBullpen(awayTeam, bullpenData.teams);

    // Offense: recent run rate (14d), fallback to league avg.
    const homeRpg = computeRpg(homeTeam, rawRows, 14) ?? LEAGUE_AVG_RPG;
    const awayRpg = computeRpg(awayTeam, rawRows, 14) ?? LEAGUE_AVG_RPG;

    // No-vig implied home win prob (shrink anchor). 0.5 if game not matched in odds.
    const marketHomeProb = extractMarketProb(homeTeam, awayTeam, oddsData);

    // Game environment: static park factor × wind factor (Open-Meteo).
    const parkFactor = getParkFactor(homeTeam);
    const weatherEntry = lookupWeather(homeTeam);
    const windFactor = weatherEntry?.windFactor ?? 1.0;

    // Expected innings per starter: last start IP → season IP/GS → 5.5.
    const homeIp = homePitcher?.lastStartIp ?? (homePitcherSeason?.ip != null ? Math.min(homePitcherSeason.ip / Math.max(homePitcherSeason.gs, 1), 7) : 5.5);
    const awayIp = awayPitcher?.lastStartIp ?? (awayPitcherSeason?.ip != null ? Math.min(awayPitcherSeason.ip / Math.max(awayPitcherSeason.gs, 1), 7) : 5.5);

    // Run prevention (RA/9) — the forward-looking upgrade lives here.
    const homeStarterRa = starterRa9(homePitcher, homePitcherSeason, homeStatcast);
    const awayStarterRa = starterRa9(awayPitcher, awayPitcherSeason, awayStatcast);
    const homeRa9 = teamRa9(homeStarterRa, homeIp, homeBullpen?.bullpenEra ?? LEAGUE_AVG_ERA);
    const awayRa9 = teamRa9(awayStarterRa, awayIp, awayBullpen?.bullpenEra ?? LEAGUE_AVG_ERA);

    // Multiplicative (log5-style) expected runs: offense strength × opponent's run
    // prevention, scaled to league average, adjusted for the game environment.
    const homeOff = homeRpg / LEAGUE_AVG_RPG;
    const awayOff = awayRpg / LEAGUE_AVG_RPG;
    const homePrev = homeRa9 / LEAGUE_AVG_RPG;  // <1 suppresses opponent runs
    const awayPrev = awayRa9 / LEAGUE_AVG_RPG;
    const envFactor = parkFactor * windFactor;
    const homeExpRuns = clamp(LEAGUE_AVG_RPG * homeOff * awayPrev * envFactor, 1.5, 9);
    const awayExpRuns = clamp(LEAGUE_AVG_RPG * awayOff * homePrev * envFactor, 1.5, 9);

    // Pythagorean win expectation + home-field advantage.
    const hPow = Math.pow(homeExpRuns, PYTHAG_EXP);
    const aPow = Math.pow(awayExpRuns, PYTHAG_EXP);
    const pythagHome = hPow / (hPow + aPow);
    const modelHome = clamp(pythagHome + HOME_FIELD_WINPROB, 0.02, 0.98);

    // Shrink toward the market — the CLV discipline.
    const finalHome = clamp(SHRINK_W * modelHome + (1 - SHRINK_W) * marketHomeProb, 0.01, 0.99);

    results.push({
      eventId,
      homeTeam,
      awayTeam,
      homeWinProb: finalHome,
      awayWinProb: 1 - finalHome,
      calibrated: true,
      homePitcherName: homePitcher?.name ?? null,
      awayPitcherName: awayPitcher?.name ?? null,
      modelHomeProbRaw: modelHome,
      marketHomeProb,
      homeExpRuns,
      awayExpRuns,
      shrinkWeight: SHRINK_W,
    });

    inputRecord.push({
      game_id: eventId,
      home_team: homeTeam,
      away_team: awayTeam,
      home_starter: homePitcher?.name ?? null,
      away_starter: awayPitcher?.name ?? null,
      home_starter_xera: homeStatcast?.xera ?? null,
      away_starter_xera: awayStatcast?.xera ?? null,
      home_starter_xera_pa: homeStatcast?.pa ?? null,
      away_starter_xera_pa: awayStatcast?.pa ?? null,
      home_starter_ra9_used: +homeStarterRa.toFixed(3),
      away_starter_ra9_used: +awayStarterRa.toFixed(3),
      home_ra9: +homeRa9.toFixed(3),
      away_ra9: +awayRa9.toFixed(3),
      home_rpg: +homeRpg.toFixed(3),
      away_rpg: +awayRpg.toFixed(3),
      home_exp_runs: +homeExpRuns.toFixed(3),
      away_exp_runs: +awayExpRuns.toFixed(3),
      park_factor: parkFactor,
      wind_factor: windFactor,
      market_home_prob: +marketHomeProb.toFixed(4),
      model_home_prob_raw: +modelHome.toFixed(4),
      final_home_prob: +finalHome.toFixed(4),
      shrink_w: SHRINK_W,
    });
  }

  // Persist structured inputs for transparency / backtest auditing.
  fs.writeFileSync(modelInputPath, JSON.stringify({ generatedAt: new Date().toISOString(), games: inputRecord }, null, 2));

  const output: MlbModelOutput = {
    generatedAt: new Date().toISOString(),
    results,
  };

  // Persist for consumption by free-stats-summary
  fs.writeFileSync(modelOutputPath, JSON.stringify(output, null, 2));
  return output;
}
