/**
 * ingest-soccer-picks.ts
 *
 * Reads soccer odds from the Odds API data files, computes fair probabilities
 * via devig, creates BestBet entries for home/away/draw outcomes, and appends
 * them to data/processed/latest-summary.json for consumption by the Kalshi
 * autopilot pipeline.
 *
 * Usage: npx tsx scripts/ingest-soccer-picks.ts
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types matching the BestBet interface in ingest-kalshi.ts
// ---------------------------------------------------------------------------

interface BestBet {
  league: string;
  matchup: string;
  pickTeam: string;
  opponent: string;
  confidence: number;   // 0-100 fair probability (no spread set → used directly)
  gameDate: string;     // ISO string
  subtitle?: string;    // For soccer: outcome label matching Kalshi market subtitle
  soccerSide?: "home" | "away" | "draw";
  rationaleSignals?: string[];
  spread?: number;
  modelSpread?: number;
}

interface SummaryFile {
  generatedAt: string;
  ready: boolean;
  recordsIngested: number;
  recordsCompleted: number;
  recordsRejected: number;
  leagues: unknown[];
  bestBets?: BestBet[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Odds API types
// ---------------------------------------------------------------------------

interface OddsOutcome {
  name: string;
  price: number;
}

interface OddsMarket {
  key: string;
  last_update: string;
  outcomes: OddsOutcome[];
}

interface OddsBookmaker {
  key: string;
  title: string;
  last_update: string;
  markets: OddsMarket[];
}

interface OddsEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsBookmaker[];
}

interface OddsFile {
  fetchedAt: string;
  league: string;
  events: OddsEvent[];
}

// ---------------------------------------------------------------------------
// Soccer league mapping
// ---------------------------------------------------------------------------

const SOCCER_LEAGUES: Array<{ file: string; league: string }> = [
  { file: "latest-odds-api-soccer_uefa_champs_league.json", league: "UCL" },
  { file: "latest-odds-api-soccer_spain_la_liga.json",      league: "LA_LIGA" },
  { file: "latest-odds-api-soccer_italy_serie_a.json",      league: "SERIE_A" },
  { file: "latest-odds-api-soccer_epl.json",                league: "EPL" },
  { file: "latest-odds-api-soccer_france_ligue_one.json",   league: "LIGUE_1" },
  { file: "latest-odds-api-soccer_germany_bundesliga.json", league: "BUNDESLIGA" },
];

const SOCCER_LEAGUE_NAMES = new Set(SOCCER_LEAGUES.map((l) => l.league));

// ---------------------------------------------------------------------------
// Team alias map for common name variations
// ---------------------------------------------------------------------------

// Maps each canonical Kalshi-style name to an array of alternate names used
// by the Odds API or sportsbooks so normalization can bridge the gap.
const SOCCER_TEAM_ALIASES: Record<string, string[]> = {
  "Man City": ["Manchester City", "Man. City", "Manchester C"],
  "Man United": ["Manchester United", "Man Utd", "Man. United", "Manchester Utd"],
  "Atletico": ["Atletico Madrid", "Atlético Madrid", "Atletico de Madrid", "Club Atletico de Madrid"],
  "Athletic": ["Athletic Club", "Athletic Bilbao", "Ath. Club", "Athletic B"],
  "Betis": ["Real Betis", "Real Betis Balompie"],
  "Newcastle": ["Newcastle United", "Newcastle Utd"],
  "Bayern Munich": ["Bayern", "FC Bayern Munich", "FC Bayern", "Bayern München"],
  "Atalanta": ["Atalanta BC", "Atalanta B.C."],
  "PSG": ["Paris Saint-Germain", "Paris SG", "Paris Saint Germain"],
  "Inter Milan": ["Inter", "FC Internazionale", "Internazionale", "FC Inter"],
  "AC Milan": ["Milan", "A.C. Milan"],
  "AS Roma": ["Roma"],
  "Borussia Dortmund": ["Dortmund", "BVB", "BV Borussia Dortmund"],
  "Juventus": ["Juve", "Juventus FC"],
  "Napoli": ["SSC Napoli"],
  "Lazio": ["SS Lazio"],
  "Fiorentina": ["ACF Fiorentina"],
  "Lyon": ["Olympique Lyonnais", "OL"],
  "Marseille": ["Olympique de Marseille", "OM"],
  "Monaco": ["AS Monaco"],
  "Nice": ["OGC Nice"],
  "Lille": ["LOSC Lille"],
  "Rennes": ["Stade Rennais", "Stade Rennes"],
  "Bayer Leverkusen": ["Leverkusen", "Bayer 04 Leverkusen"],
  "Borussia Monchengladbach": ["Monchengladbach", "B. Monchengladbach"],
  "Eintracht Frankfurt": ["Frankfurt", "Eintracht F"],
  "Wolfsburg": ["VfL Wolfsburg"],
  "Werder Bremen": ["Bremen", "Werder"],
  "Hoffenheim": ["TSG Hoffenheim", "TSG 1899 Hoffenheim"],
  "RB Leipzig": ["Leipzig", "Rasenballsport Leipzig"],
  "Freiburg": ["SC Freiburg"],
  "Augsburg": ["FC Augsburg"],
  "Stuttgart": ["VfB Stuttgart"],
  "Real Madrid": ["Real", "R. Madrid"],
  "Barcelona": ["FC Barcelona", "Barca", "Barça"],
  "Sevilla": ["Sevilla FC"],
  "Valencia": ["Valencia CF"],
  "Villarreal": ["Villarreal CF"],
  "Real Sociedad": ["Sociedad", "R. Sociedad"],
  "Girona": ["Girona FC"],
  "Osasuna": ["CA Osasuna"],
  "Celta Vigo": ["Celta", "Celta de Vigo"],
  "Alaves": ["Deportivo Alaves", "Alavés"],
  "Las Palmas": ["UD Las Palmas"],
  "Getafe": ["Getafe CF"],
  "Rayo Vallecano": ["Rayo"],
  "Leganes": ["CD Leganes", "Leganés"],
  "Valladolid": ["Real Valladolid"],
  "Mallorca": ["RCD Mallorca"],
  "Espanyol": ["RCD Espanyol"],
  "Arsenal": ["Arsenal FC"],
  "Chelsea": ["Chelsea FC"],
  "Liverpool": ["Liverpool FC"],
  "Tottenham": ["Tottenham Hotspur", "Spurs"],
  "Aston Villa": ["Villa"],
  "Brighton": ["Brighton & Hove Albion", "Brighton and Hove Albion"],
  "West Ham": ["West Ham United"],
  "Fulham": ["Fulham FC"],
  "Brentford": ["Brentford FC"],
  "Crystal Palace": ["Palace"],
  "Wolves": ["Wolverhampton Wanderers", "Wolverhampton"],
  "Ipswich": ["Ipswich Town"],
  "Everton": ["Everton FC"],
  "Leicester": ["Leicester City"],
  "Southampton": ["Southampton FC"],
  "Nottm Forest": ["Nottingham Forest", "Notts Forest"],
  "Bournemouth": ["AFC Bournemouth"],
  "Galatasaray": ["Galatasaray SK"],
  "Fenerbahce": ["Fenerbahçe", "Fenerbahce SK"],
  "Besiktas": ["Beşiktaş", "Besiktas JK"],
  "Celtic": ["Celtic FC"],
  "Rangers": ["Rangers FC"],
  "Porto": ["FC Porto"],
  "Benfica": ["SL Benfica"],
  "Sporting CP": ["Sporting", "Sporting Lisbon"],
  "Ajax": ["AFC Ajax"],
  "PSV": ["PSV Eindhoven"],
  "Feyenoord": ["Feyenoord Rotterdam"],
};

// ---------------------------------------------------------------------------
// Helper: American odds → implied probability (0–100)
// ---------------------------------------------------------------------------

function americanToImplied(price: number): number {
  if (price > 0) {
    return (100 / (price + 100)) * 100;
  } else {
    return ((-price) / (-price + 100)) * 100;
  }
}

// ---------------------------------------------------------------------------
// Helper: normalize team name for alias lookups
// ---------------------------------------------------------------------------

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\bfc\b/g, "")
    .replace(/\bcf\b/g, "")
    .replace(/\bac\b/g, "")
    .replace(/\bas\b/g, "")
    .replace(/\bafc\b/g, "")
    .replace(/\bsl\b/g, "")
    .replace(/\bsk\b/g, "")
    .replace(/\bvfl\b/g, "")
    .replace(/\bvfb\b/g, "")
    .replace(/\btsg\b/g, "")
    .replace(/\bcd\b/g, "")
    .replace(/\bud\b/g, "")
    .replace(/\brcd\b/g, "")
    .replace(/\bca\b/g, "")
    .replace(/[àáâã]/g, "a")
    .replace(/[èéêë]/g, "e")
    .replace(/[ìíîï]/g, "i")
    .replace(/[òóôõö]/g, "o")
    .replace(/[ùúûü]/g, "u")
    .replace(/ñ/g, "n")
    .replace(/ü/g, "u")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resolves an Odds API team name to its canonical/short form used as the
 * Kalshi subtitle, by checking the alias map.
 * Falls back to the original name if no alias is found.
 */
function resolveTeamName(rawName: string): string {
  const normRaw = normalizeName(rawName);

  for (const [canonical, aliases] of Object.entries(SOCCER_TEAM_ALIASES)) {
    const normCanon = normalizeName(canonical);
    if (normRaw === normCanon) return canonical;
    for (const alias of aliases) {
      if (normalizeName(alias) === normRaw) return canonical;
    }
  }

  // No alias found — return as-is (still usable for matching)
  return rawName;
}

// ---------------------------------------------------------------------------
// Core: process one soccer event into BestBet entries
// ---------------------------------------------------------------------------

function processEvent(event: OddsEvent, league: string): BestBet[] {
  const now = Date.now();
  const commenceMs = new Date(event.commence_time).getTime();

  // Only future games, within 7 days
  if (commenceMs <= now) return [];
  if (commenceMs - now > 7 * 24 * 60 * 60 * 1000) return [];

  // Collect h2h implied probabilities per outcome name
  const impliedMap: Map<string, number[]> = new Map();
  let bookmakerCount = 0;

  for (const bookmaker of event.bookmakers) {
    const h2hMarket = bookmaker.markets.find((m) => m.key === "h2h");
    if (!h2hMarket) continue;

    // Validate: must have 3 outcomes (home/away/draw)
    if (h2hMarket.outcomes.length !== 3) continue;

    bookmakerCount++;
    for (const outcome of h2hMarket.outcomes) {
      if (typeof outcome.price !== "number") continue;
      const implied = americanToImplied(outcome.price);
      if (!impliedMap.has(outcome.name)) {
        impliedMap.set(outcome.name, []);
      }
      impliedMap.get(outcome.name)!.push(implied);
    }
  }

  // Require minimum 2 bookmakers
  if (bookmakerCount < 2) return [];

  // Compute average implied per outcome
  const outcomes: Array<{ name: string; avgImplied: number }> = [];
  for (const [name, probs] of impliedMap.entries()) {
    const avg = probs.reduce((s, p) => s + p, 0) / probs.length;
    outcomes.push({ name, avgImplied: avg });
  }

  if (outcomes.length !== 3) return [];

  // Devig: sum of averaged implied probabilities (the vig)
  const totalImplied = outcomes.reduce((s, o) => s + o.avgImplied, 0);
  if (totalImplied <= 0) return [];

  // Fair probabilities
  const fairMap: Map<string, number> = new Map();
  for (const o of outcomes) {
    fairMap.set(o.name, (o.avgImplied / totalImplied) * 100);
  }

  const homeTeam = event.home_team;
  const awayTeam = event.away_team;
  const gameDate = event.commence_time;

  // Resolve canonical names (for subtitle matching)
  const homeCanonical = resolveTeamName(homeTeam);
  const awayCanonical = resolveTeamName(awayTeam);

  const fairHome = fairMap.get(homeTeam) ?? 0;
  const fairAway = fairMap.get(awayTeam) ?? 0;
  // Draw key is literally "Draw" in Odds API
  const fairDraw = fairMap.get("Draw") ?? 0;

  const matchup = `${homeTeam} vs ${awayTeam}`;
  const booksNote = `${bookmakerCount} books avg`;

  const bets: BestBet[] = [
    {
      league,
      matchup,
      pickTeam: homeCanonical,
      opponent: awayCanonical,
      confidence: Math.round(fairHome * 10) / 10,
      gameDate,
      subtitle: homeCanonical,
      soccerSide: "home",
      rationaleSignals: [
        `Home team: ${homeTeam}`,
        `Fair win probability: ${(fairHome).toFixed(1)}% (devigged)`,
        booksNote,
        `Commence: ${event.commence_time}`,
      ],
    },
    {
      league,
      matchup,
      pickTeam: awayCanonical,
      opponent: homeCanonical,
      confidence: Math.round(fairAway * 10) / 10,
      gameDate,
      subtitle: awayCanonical,
      soccerSide: "away",
      rationaleSignals: [
        `Away team: ${awayTeam}`,
        `Fair win probability: ${(fairAway).toFixed(1)}% (devigged)`,
        booksNote,
        `Commence: ${event.commence_time}`,
      ],
    },
    {
      league,
      matchup,
      pickTeam: "Draw",
      opponent: `${homeCanonical} vs ${awayCanonical}`,
      confidence: Math.round(fairDraw * 10) / 10,
      gameDate,
      subtitle: "Tie",
      soccerSide: "draw",
      rationaleSignals: [
        `Draw: ${homeTeam} vs ${awayTeam}`,
        `Fair draw probability: ${(fairDraw).toFixed(1)}% (devigged)`,
        booksNote,
        `Commence: ${event.commence_time}`,
      ],
    },
  ];

  return bets;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const projectRoot = path.resolve(
    process.env.npm_config_local_prefix ?? process.cwd(),
  );
  const dataDir = path.join(projectRoot, "data", "processed");
  const summaryPath = path.join(dataDir, "latest-summary.json");

  // Load existing summary
  let summary: SummaryFile;
  try {
    summary = JSON.parse(fs.readFileSync(summaryPath, "utf8")) as SummaryFile;
  } catch (err) {
    console.error(`[soccer] Failed to read ${summaryPath}:`, err);
    process.exit(1);
  }

  if (!Array.isArray(summary.bestBets)) {
    summary.bestBets = [];
  }

  // Remove existing soccer entries
  const before = summary.bestBets.length;
  summary.bestBets = summary.bestBets.filter(
    (b) => !SOCCER_LEAGUE_NAMES.has(b.league),
  );
  const removed = before - summary.bestBets.length;

  // Process each league
  let totalGames = 0;
  let totalBets = 0;
  const newBets: BestBet[] = [];

  for (const { file, league } of SOCCER_LEAGUES) {
    const filePath = path.join(dataDir, file);
    let oddsData: OddsFile;

    try {
      oddsData = JSON.parse(fs.readFileSync(filePath, "utf8")) as OddsFile;
    } catch {
      console.warn(`[soccer] Skipping ${file} — file not found or unreadable`);
      continue;
    }

    if (!Array.isArray(oddsData.events)) {
      console.warn(`[soccer] Skipping ${file} — no events array`);
      continue;
    }

    let leagueGames = 0;
    let leagueBets = 0;

    for (const event of oddsData.events) {
      try {
        const bets = processEvent(event, league);
        if (bets.length > 0) {
          newBets.push(...bets);
          leagueGames++;
          leagueBets += bets.length;
        }
      } catch (err) {
        console.warn(
          `[soccer] Error processing event ${event.id ?? "?"} in ${league}:`,
          err,
        );
      }
    }

    console.log(
      `[soccer] ${league}: ${leagueGames} games → ${leagueBets} bets`,
    );
    totalGames += leagueGames;
    totalBets += leagueBets;
  }

  // Append new soccer bets
  summary.bestBets.push(...newBets);

  // Write back
  try {
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  } catch (err) {
    console.error(`[soccer] Failed to write ${summaryPath}:`, err);
    process.exit(1);
  }

  console.log(
    `\n[soccer] Done — ${totalGames} games processed, ${totalBets} BestBets added` +
    ` (removed ${removed} stale soccer entries)`,
  );
}

main();
