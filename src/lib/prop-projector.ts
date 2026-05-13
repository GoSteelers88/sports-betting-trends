// Deterministic prop projection engine. Given a player + prop type +
// opponent + line + side, returns a projected stat value, an empirical
// standard deviation, and the probability the actual outcome lands over
// the line (via the normal CDF in prop-grading.ts).
//
// This is the load-bearing "modelProb source" for prop picks the analyst
// ships through AgentPick — Claude must NEVER invent a prop modelProb
// from reasoning alone (industry consensus: LLMs do not do prop math well).
//
// Data source: data/processed/player-gamelogs-{nba,mlb}.json, produced
// nightly by scripts/ingest-player-gamelogs.ts. Each player entry carries
// a list of recent games with the team they played, the opponent, and
// the per-prop-type stat value (PTS, REB, AST, batter_runs_scored, ...).

import fs from "node:fs";
import path from "node:path";
import { normalizeName, normalCdf, type PropGradingLeague } from "./prop-grading";

type PerGameStats = { date: string; opponent: string | null; stats: Record<string, number> };
type PlayerEntry = { displayName: string; team: string | null; games: PerGameStats[] };
type TeamAllowed = { games: number; allowed: Record<string, { mean: number; n: number }> };
type GameLogFile = {
  generatedAt: string;
  league: PropGradingLeague;
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  players: Record<string, PlayerEntry>;
  teamsAllowed: Record<string, TeamAllowed>;
  leagueAverages: Record<string, number>;
};

const PROCESSED = path.resolve(process.cwd(), "data", "processed");

// Minimum games before we trust a player's empirical distribution. Below
// this threshold returns null and the analyst must skip the prop — we
// won't ship a pick with garbage modelProb.
const MIN_GAMES = 5;

// Floor on standard deviation. Prevents 100% modelProb when a player has
// been freakishly consistent in a small sample. Calibrated per league.
const STDDEV_FLOOR: Record<PropGradingLeague, Record<string, number>> = {
  NBA: {
    player_points: 4.0,
    player_rebounds: 1.8,
    player_assists: 1.5,
    player_threes: 0.9,
    player_blocks: 0.8,
    player_steals: 0.7,
    player_turnovers: 0.8,
    player_points_rebounds_assists: 4.5,
    player_points_rebounds: 4.0,
    player_points_assists: 3.5,
    player_rebounds_assists: 2.2,
    player_blocks_steals: 1.0,
  },
  MLB: {
    batter_hits: 0.9,
    batter_home_runs: 0.6,
    batter_rbis: 0.95,
    batter_runs_scored: 0.85,
    batter_total_bases: 1.1,
    pitcher_strikeouts: 1.8,
    pitcher_earned_runs: 1.3,
  },
};

// Cap how far opponent allowance can swing a projection. If the opponent
// gives up 2× the league average in a stat, that's almost certainly
// small-sample noise unless we have many games. Capping it at ±25%
// prevents the projector from ballooning on a 3-game sample.
const ALLOWANCE_CAP = 0.25;

let CACHE: Partial<Record<PropGradingLeague, { mtime: number; data: GameLogFile }>> = {};

function loadGameLog(league: PropGradingLeague): GameLogFile | null {
  const filename = `player-gamelogs-${league.toLowerCase()}.json`;
  const filepath = path.join(PROCESSED, filename);
  try {
    const stat = fs.statSync(filepath);
    const cached = CACHE[league];
    if (cached && cached.mtime === stat.mtimeMs) return cached.data;
    const raw = fs.readFileSync(filepath, "utf8");
    const data = JSON.parse(raw) as GameLogFile;
    CACHE[league] = { mtime: stat.mtimeMs, data };
    return data;
  } catch {
    return null;
  }
}

export type ProjectionInput = {
  league: PropGradingLeague;
  player: string;
  propType: string;
  line: number;
  side: "over" | "under";
  opponent?: string | null;
};

export type ProjectionOutput = {
  projected: number;       // adjusted mean (player mean × opponent factor)
  stddev: number;          // empirical stddev, floored
  modelProb: number;       // P(stat ≥ line) for over, P(stat ≤ line) for under
  edge: number | null;     // modelProb - marketProb if marketProb supplied via fairImpliedProb()
  nGames: number;          // games behind the projection
  rollingMean: number;     // unadjusted player mean
  opponentFactor: number;  // multiplier applied (1.0 = neutral)
  recentForm: number[];    // last up-to-5 stat values
  windowAge: number;       // age of game log in hours
  notes: string[];
};

export function project(input: ProjectionInput): ProjectionOutput | null {
  const log = loadGameLog(input.league);
  if (!log) return null;

  const key = normalizeName(input.player);
  const player = log.players[key];
  if (!player || player.games.length < MIN_GAMES) return null;

  const values = player.games
    .map(g => g.stats[input.propType])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (values.length < MIN_GAMES) return null;

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  // Sample stddev (n - 1)
  const variance =
    values.length > 1
      ? values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1)
      : 0;
  const empiricalStd = Math.sqrt(variance);
  const floor = STDDEV_FLOOR[input.league]?.[input.propType] ?? 1.0;
  const stddev = Math.max(empiricalStd, floor);

  // Opponent allowance adjustment — does the opponent give up more/less
  // than league average in this stat? If we don't have a league average
  // for this prop type (rare-ish prop or no games yet), skip the bump.
  const leagueAvg = log.leagueAverages[input.propType];
  const notes: string[] = [];
  let factor = 1;
  if (input.opponent && leagueAvg && leagueAvg > 0) {
    const allowed = log.teamsAllowed[input.opponent]?.allowed[input.propType];
    if (allowed && allowed.n >= MIN_GAMES) {
      const raw = allowed.mean / leagueAvg;
      factor = Math.max(1 - ALLOWANCE_CAP, Math.min(1 + ALLOWANCE_CAP, raw));
      if (Math.abs(raw - factor) > 0.001) {
        notes.push(`opponent allowance capped (raw ${raw.toFixed(2)}×, clamped to ${factor.toFixed(2)}×)`);
      } else {
        notes.push(`opponent allows ${(factor * 100).toFixed(0)}% of league avg for ${input.propType}`);
      }
    } else {
      notes.push(`no usable opponent-allowance sample for ${input.opponent}`);
    }
  }

  const projected = mean * factor;
  // Normal CDF — probability of going UNDER the line. For OVER picks,
  // we want P(X > line) = 1 - CDF(line).
  const probUnder = normalCdf(input.line, projected, stddev);
  const modelProb = input.side === "over" ? 1 - probUnder : probUnder;

  const recentForm = values.slice(-5);
  const windowAgeHours = Math.max(0, (Date.now() - new Date(log.generatedAt).getTime()) / 36e5);

  return {
    projected: +projected.toFixed(2),
    stddev: +stddev.toFixed(2),
    modelProb: +modelProb.toFixed(4),
    edge: null,
    nGames: values.length,
    rollingMean: +mean.toFixed(2),
    opponentFactor: +factor.toFixed(3),
    recentForm,
    windowAge: +windowAgeHours.toFixed(1),
    notes,
  };
}

// Cache reset helper — used by tests or when callers want to force a
// re-read after a fresh ingest. No-op when no cache populated.
export function _resetProjectorCache(): void {
  CACHE = {};
}
