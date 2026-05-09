// hockey-model.ts — NHL moneyline win-probability model.
//
// Mirrors basketball-model.ts in shape but with hockey-tuned constants:
//   predictedHomeGoalMargin = (homeRtg - awayRtg) * 0.5 + 0.2
//     0.5 = fraction of season-long goal differential that translates to
//           single-game expected margin (less regression than basketball
//           because hockey samples fewer possessions per game).
//     0.2 = home-ice advantage in goals. Modern NHL with regulation OT/SO
//           narrows this vs the historical ~0.4.
//   homeWinProb = logistic(predictedHomeGoalMargin * 0.30)
//     0.30 = empirical slope cross-checked against NHL ML closing lines.
//            A 1-goal favorite closes around -130 (≈56.5% implied win prob)
//            historically; logistic(0.30 * 1) ≈ 0.575, within the spread.
//
// Same envelope shape as basketball-model so the agent's
// get_model_probabilities tool reads NBA / WNBA / NHL through identical
// data.results[] paths.
//
// Goalie matchups account for 30–40% of NHL ML variance and a v0 does not
// model them. Picks should be treated with extra caution until starting
// goalies are surfaced as an analyst signal in a follow-up.

import fs from "node:fs";
import path from "node:path";

export type HockeyTeamRating = {
  netRtg: number | null; // goal differential per game (overall)
  homeNetRtg: number | null;
  awayNetRtg: number | null;
};

export type HockeyEfficiencyFile = {
  fetchedAt: string;
  season: string;
  source: string;
  lookbackDays: number;
  teams: Record<string, HockeyTeamRating>;
};

export type GameInput = {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  startTime?: string;
};

export type ModelGameResult = {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  homeWinProb: number;
  awayWinProb: number;
  expectedMargin: number; // in goals
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
    constants: { goalDiffToMargin: number; homeIceBonus: number; logisticSlope: number };
    teamCount: number;
    gameCount: number;
    results: ModelGameResult[];
  };
};

const GOAL_DIFF_TO_MARGIN = 0.5;
const HOME_ICE_BONUS = 0.2;
const LOGISTIC_SLOPE = 0.30;

function normalizeTeamKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
}

function findTeamRating(
  teamName: string,
  data: HockeyEfficiencyFile,
): HockeyTeamRating | null {
  if (data.teams[teamName]) return data.teams[teamName];

  const normTarget = normalizeTeamKey(teamName);
  const targetWords = normTarget.split(/\s+/);
  const lastWord = targetWords[targetWords.length - 1];

  let bestMatch: HockeyTeamRating | null = null;
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

function modelGame(
  game: GameInput,
  efficiency: HockeyEfficiencyFile,
): ModelGameResult | null {
  const homeRtg = findTeamRating(game.homeTeam, efficiency);
  const awayRtg = findTeamRating(game.awayTeam, efficiency);
  if (!homeRtg || !awayRtg) return null;

  const homeRating = homeRtg.homeNetRtg ?? homeRtg.netRtg;
  const awayRating = awayRtg.awayNetRtg ?? awayRtg.netRtg;
  if (homeRating == null || awayRating == null) return null;

  const expectedMargin = (homeRating - awayRating) * GOAL_DIFF_TO_MARGIN + HOME_ICE_BONUS;
  const homeWinProb = logistic(expectedMargin * LOGISTIC_SLOPE);
  const awayWinProb = 1 - homeWinProb;

  return {
    eventId: game.eventId,
    homeTeam: game.homeTeam,
    awayTeam: game.awayTeam,
    homeWinProb: Math.round(homeWinProb * 10000) / 10000,
    awayWinProb: Math.round(awayWinProb * 10000) / 10000,
    expectedMargin: Math.round(expectedMargin * 100) / 100,
    homeNetRtg: homeRating,
    awayNetRtg: awayRating,
    calibrated: false,
    startTime: game.startTime ?? null,
  };
}

export type BuildModelArgs = {
  source: string;
  games: GameInput[];
  efficiency: HockeyEfficiencyFile;
};

export function buildHockeyModel(args: BuildModelArgs): ModelOutput {
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
          goalDiffToMargin: GOAL_DIFF_TO_MARGIN,
          homeIceBonus: HOME_ICE_BONUS,
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
        goalDiffToMargin: GOAL_DIFF_TO_MARGIN,
        homeIceBonus: HOME_ICE_BONUS,
        logisticSlope: LOGISTIC_SLOPE,
      },
      teamCount: Object.keys(efficiency.teams).length,
      gameCount: games.length,
      results,
    },
  };
}

// ─── File I/O helpers used by the ingest scripts ────────────────────────────

export function loadHockeyEfficiencyFile(filePath: string): HockeyEfficiencyFile {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as HockeyEfficiencyFile;
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
