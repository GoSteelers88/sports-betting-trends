// basketball-model.ts — generalized basketball moneyline win-probability model.
//
// Used by NBA and WNBA pipelines. Same formula, same shape — the only thing that
// changes is the input efficiency file and the output target. Logic was previously
// inlined inside ingest-free-stats / free-stats-summary; lifted out so adding a
// new basketball league is a config entry instead of a new script.
//
// Formula (preserved from free-stats-summary.ts:1209):
//   predictedHomeMargin = (homeNetRtg - awayNetRtg) * 0.45 + 1.5
//     0.45 = pts per NetRtg point (empirical)
//     1.5  = residual home court not captured by split ratings
//
// Win probability comes from the predicted margin via a logistic on points.
// Coefficient 0.105 is the standard NBA points→win-prob slope (≈ 1 / (sigma*sqrt(2)))
// fit on historical NBA games and is close enough for WNBA at the v1 cut.

import fs from "node:fs";
import path from "node:path";

export type TeamEfficiency = {
  netRtg: number | null;
  homeNetRtg: number | null;
  awayNetRtg: number | null;
};

export type EfficiencyFile = {
  fetchedAt: string;
  season: string;
  source: string;
  lookbackDays: number;
  teams: Record<string, TeamEfficiency>;
};

export type GameInput = {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  /** ISO 8601 game start time, used for the model output. */
  startTime?: string;
};

export type ModelGameResult = {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  homeWinProb: number;
  awayWinProb: number;
  expectedMargin: number;
  homeNetRtg: number | null;
  awayNetRtg: number | null;
  calibrated: boolean;
  startTime: string | null;
};

export type ModelOutput = {
  generatedAt: string;
  source: string;
  status: "ok" | "no-data" | "no-games";
  freshnessMins: number;
  recordCount: number;
  errors: string[];
  data: {
    generatedAt: string;
    constants: { netRtgToPoints: number; homeCourtBonus: number; logisticSlope: number };
    teamCount: number;
    gameCount: number;
    results: ModelGameResult[];
  };
};

const NET_RTG_TO_POINTS = 0.45;
const HOME_COURT_BONUS = 1.5;
const LOGISTIC_SLOPE = 0.105;

function normalizeTeamKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
}

function findTeamEfficiency(
  teamName: string,
  data: EfficiencyFile,
): TeamEfficiency | null {
  if (data.teams[teamName]) return data.teams[teamName];

  const normTarget = normalizeTeamKey(teamName);
  const targetWords = normTarget.split(/\s+/);
  const lastWord = targetWords[targetWords.length - 1];

  let bestMatch: TeamEfficiency | null = null;
  for (const [key, val] of Object.entries(data.teams)) {
    const normKey = normalizeTeamKey(key);
    if (normKey === normTarget) return val;
    if (normKey.includes(normTarget) || normTarget.includes(normKey)) {
      bestMatch = val;
      continue;
    }
    const keyWords = normKey.split(/\s+/);
    if (keyWords[keyWords.length - 1] === lastWord) {
      bestMatch = val;
    }
  }
  return bestMatch;
}

function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Build model probabilities for one game. Returns null if either team's
 *  efficiency record is missing or has no usable net rating. */
function modelGame(
  game: GameInput,
  efficiency: EfficiencyFile,
): ModelGameResult | null {
  const homeEff = findTeamEfficiency(game.homeTeam, efficiency);
  const awayEff = findTeamEfficiency(game.awayTeam, efficiency);
  if (!homeEff || !awayEff) return null;

  const homeNetRtg = homeEff.homeNetRtg ?? homeEff.netRtg;
  const awayNetRtg = awayEff.awayNetRtg ?? awayEff.netRtg;
  if (homeNetRtg == null || awayNetRtg == null) return null;

  const expectedMargin = (homeNetRtg - awayNetRtg) * NET_RTG_TO_POINTS + HOME_COURT_BONUS;
  const homeWinProb = logistic(expectedMargin * LOGISTIC_SLOPE);
  const awayWinProb = 1 - homeWinProb;

  return {
    eventId: game.eventId,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    homeWinProb: Math.round(homeWinProb * 10000) / 10000,
    awayWinProb: Math.round(awayWinProb * 10000) / 10000,
    expectedMargin: Math.round(expectedMargin * 100) / 100,
    homeNetRtg,
    awayNetRtg,
    calibrated: false,
    startTime: game.startTime ?? null,
  };
}

export type BuildModelArgs = {
  /** Display label written into the output `source` field. e.g. "nba-efficiency-empirical". */
  source: string;
  games: GameInput[];
  efficiency: EfficiencyFile;
};

/** Pure function: given games + efficiency data, build the model output envelope. */
export function buildBasketballModel(args: BuildModelArgs): ModelOutput {
  const { source, games, efficiency } = args;
  const generatedAt = new Date().toISOString();

  if (games.length === 0) {
    return {
      generatedAt,
      source,
      status: "no-games",
      freshnessMins: 0,
      recordCount: 0,
      errors: [],
      data: {
        generatedAt,
        constants: {
          netRtgToPoints: NET_RTG_TO_POINTS,
          homeCourtBonus: HOME_COURT_BONUS,
          logisticSlope: LOGISTIC_SLOPE,
        },
        teamCount: Object.keys(efficiency.teams).length,
        gameCount: 0,
        results: [],
      },
    };
  }

  const results: ModelGameResult[] = [];
  const errors: string[] = [];
  for (const game of games) {
    const r = modelGame(game, efficiency);
    if (r) results.push(r);
    else errors.push(`unmodeled: ${game.awayTeam} @ ${game.homeTeam} (${game.eventId})`);
  }

  return {
    generatedAt,
    source,
    status: results.length > 0 ? "ok" : "no-data",
    freshnessMins: 0,
    recordCount: results.length,
    errors,
    data: {
      generatedAt,
      constants: {
        netRtgToPoints: NET_RTG_TO_POINTS,
        homeCourtBonus: HOME_COURT_BONUS,
        logisticSlope: LOGISTIC_SLOPE,
      },
      teamCount: Object.keys(efficiency.teams).length,
      gameCount: games.length,
      results,
    },
  };
}

// ─── File I/O helpers used by the ingest scripts ────────────────────────────

export function loadEfficiencyFile(filePath: string): EfficiencyFile {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as EfficiencyFile;
}

export type OddsApiEvent = {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
};
export type OddsApiFile = { events?: OddsApiEvent[]; fetchedAt?: string };

export function loadGamesFromOddsFile(filePath: string): GameInput[] {
  const raw = fs.readFileSync(filePath, "utf-8");
  const data = JSON.parse(raw) as OddsApiFile;
  const events = data.events ?? [];
  return events.map((ev) => ({
    eventId: ev.id,
    homeTeam: ev.home_team,
    awayTeam: ev.away_team,
    startTime: ev.commence_time,
  }));
}

export function writeModelFile(outPath: string, output: ModelOutput): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = outPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(output, null, 2), "utf-8");
  try {
    fs.renameSync(tmp, outPath);
  } catch {
    try { fs.unlinkSync(outPath); } catch { /* ok */ }
    fs.renameSync(tmp, outPath);
  }
}
