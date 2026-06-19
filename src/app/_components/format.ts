// Shared formatting + league-honesty helpers for the Paper Trial dashboard.
// Pure functions only — safe to import from server and client components.

import type { SlateGame } from "../_data/dashboard";

/** Render guard — the feed occasionally emits impossible American prices
 *  (e.g. "-1"). Ingest is out of bounds at the render layer, so anything
 *  that isn't a valid price (finite, |value| ≥ 100) prints as an em-dash. */
export function isValidAmerican(n: number | null | undefined): n is number {
  return n !== null && n !== undefined && Number.isFinite(n) && Math.abs(n) >= 100;
}

export function fmtAmerican(n: number | null | undefined): string {
  if (!isValidAmerican(n)) return "—";
  return n > 0 ? `+${n}` : `${n}`;
}

export function fmtUnits(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}u`;
}

export function fmtPct(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`;
}

// ─── League honesty ─────────────────────────────────────────────────────────
// The odds feed files are keyed by sport, not league — the "MLB" baseball
// file also carries NCAA (and occasionally NPB/KBO/minor-league) games.
// Rows are only labeled MLB/NBA when both teams are actually in the league;
// everything else is labeled OTHER rather than lying about the league.

const MLB_TEAMS = new Set([
  "Arizona Diamondbacks", "Atlanta Braves", "Baltimore Orioles", "Boston Red Sox",
  "Chicago Cubs", "Chicago White Sox", "Cincinnati Reds", "Cleveland Guardians",
  "Colorado Rockies", "Detroit Tigers", "Houston Astros", "Kansas City Royals",
  "Los Angeles Angels", "Los Angeles Dodgers", "Miami Marlins", "Milwaukee Brewers",
  "Minnesota Twins", "New York Mets", "New York Yankees", "Oakland Athletics",
  "Athletics", "Philadelphia Phillies", "Pittsburgh Pirates", "San Diego Padres",
  "San Francisco Giants", "Seattle Mariners", "St. Louis Cardinals",
  "Tampa Bay Rays", "Texas Rangers", "Toronto Blue Jays", "Washington Nationals",
]);

const NBA_TEAMS = new Set([
  "Atlanta Hawks", "Boston Celtics", "Brooklyn Nets", "Charlotte Hornets",
  "Chicago Bulls", "Cleveland Cavaliers", "Dallas Mavericks", "Denver Nuggets",
  "Detroit Pistons", "Golden State Warriors", "Houston Rockets", "Indiana Pacers",
  "Los Angeles Clippers", "Los Angeles Lakers", "Memphis Grizzlies", "Miami Heat",
  "Milwaukee Bucks", "Minnesota Timberwolves", "New Orleans Pelicans",
  "New York Knicks", "Oklahoma City Thunder", "Orlando Magic",
  "Philadelphia 76ers", "Phoenix Suns", "Portland Trail Blazers",
  "Sacramento Kings", "San Antonio Spurs", "Toronto Raptors", "Utah Jazz",
  "Washington Wizards",
]);

export type HonestLeague = "NBA" | "MLB" | "WNBA" | "NHL" | "OTHER";

export function honestLeague(g: Pick<SlateGame, "league" | "homeTeam" | "awayTeam">): HonestLeague {
  if (g.league === "MLB") {
    return MLB_TEAMS.has(g.homeTeam) && MLB_TEAMS.has(g.awayTeam) ? "MLB" : "OTHER";
  }
  if (g.league === "NBA") {
    return NBA_TEAMS.has(g.homeTeam) && NBA_TEAMS.has(g.awayTeam) ? "NBA" : "OTHER";
  }
  return g.league;
}

/** In-scope = the trial's actual remit: real NBA + real MLB games. */
export function isInScopeGame(g: Pick<SlateGame, "league" | "homeTeam" | "awayTeam">): boolean {
  const l = honestLeague(g);
  return l === "NBA" || l === "MLB";
}

// ─── Prop label map (shared by hero, ledgers, props desk) ───────────────────

export const PROP_LABELS: Record<string, string> = {
  player_points: "pts",
  player_rebounds: "reb",
  player_assists: "ast",
  player_threes: "3PM",
  player_blocks: "blk",
  player_steals: "stl",
  player_turnovers: "TO",
  player_points_rebounds_assists: "PRA",
  player_points_rebounds: "P+R",
  player_points_assists: "P+A",
  player_rebounds_assists: "R+A",
  player_blocks_steals: "B+S",
  batter_hits: "hits",
  batter_home_runs: "HR",
  batter_rbis: "RBI",
  batter_runs_scored: "runs",
  batter_total_bases: "TB",
  batter_strikeouts: "K",
  batter_stolen_bases: "SB",
  pitcher_strikeouts: "K",
  pitcher_earned_runs: "ER",
};

export function propLabel(propType: string | null): string {
  if (!propType) return "";
  return (
    PROP_LABELS[propType] ??
    propType.replace(/^player_|^batter_|^pitcher_/, "").replace(/_/g, " ")
  );
}
