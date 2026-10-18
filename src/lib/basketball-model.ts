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
  gamesPlayed?: number;
};

export type EfficiencyFile = {
  fetchedAt: string;
  season: string;
  source: string;
  lookbackDays: number;
  teams: Record<string, TeamEfficiency>;
  /** Teams with countable games but fewer than the minimum: team → games. */
  belowMinimum?: Record<string, number>;
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
  // "insufficient-sample": the ratings are current, but every game on the
  // slate failed the minimum-games or horizon rule. Expected in preseason and
  // opening week; re-ingesting can't fix it.
  status: "ok" | "no-data" | "no-games" | "insufficient-sample";
  freshnessMins: number;
  recordCount: number;
  errors: string[];
  /** Why no game was modeled, in one line, when results is empty. */
  note?: string;
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

// A team is rated only after this many regular-season/playoff games. Replayed
// 2026-10-17 over NBA 2023-24 … 2025-26 (Brier vs always picking the home
// team, negative = model better): 1–2 games +0.022 ± 0.020 (n=97), 3–4
// +0.002 ± 0.018 (n=94), 5–6 −0.016 ± 0.015 (n=88), 7–9 −0.034 ± 0.010
// (n=140). WNBA 2024–2026 shows the same shape on smaller samples. Beating a
// constant guess is a floor, not an edge over the market.
export const MIN_GAMES_FOR_RATING = 5;
// The ingest refreshes ratings every agent run (twice a day). A file older
// than this means the refresh has been failing; don't price games off it.
const MAX_EFFICIENCY_AGE_HOURS = 36;
// Ratings describe a team now, not in two months: pick #134 (Christmas) was
// made 87 days out off one Finals game. Games further out stay unmodeled.
const MAX_HORIZON_DAYS = 10;

function normalizeTeamKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
}

function findTeam<T>(teamName: string, teams: Record<string, T>): T | null {
  if (teams[teamName] !== undefined) return teams[teamName];

  const normTarget = normalizeTeamKey(teamName);
  const targetWords = normTarget.split(/\s+/);
  const lastWord = targetWords[targetWords.length - 1];

  let bestMatch: T | null = null;
  for (const [key, val] of Object.entries(teams)) {
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

type Unmodeled = {
  reason: string;
  /** True when the minimum-games or horizon rule skipped the game, not missing data. */
  bySampleRule: boolean;
};

/** Why a team has no usable rating, or null if it has one. */
function teamGap(teamName: string, eff: TeamEfficiency | null, efficiency: EfficiencyFile): Unmodeled | null {
  if (!eff) {
    const games = efficiency.belowMinimum ? findTeam(teamName, efficiency.belowMinimum) : null;
    if (games !== null) {
      return { reason: `${teamName} has ${games} counted game${games === 1 ? "" : "s"} (needs ${MIN_GAMES_FOR_RATING})`, bySampleRule: true };
    }
    // A file with no teams at all is the "nothing counted yet" case (preseason,
    // offseason), not a name mismatch.
    const empty = Object.keys(efficiency.teams).length === 0;
    return { reason: `no rating for ${teamName}${empty ? " (no counted games yet)" : ""}`, bySampleRule: empty };
  }
  // Files written before 2026-10-17 can carry teams below the minimum.
  const games = eff.gamesPlayed ?? 0;
  if (games < MIN_GAMES_FOR_RATING) {
    return { reason: `${teamName} has ${games} counted game${games === 1 ? "" : "s"} (needs ${MIN_GAMES_FOR_RATING})`, bySampleRule: true };
  }
  return null;
}

/** Build model probabilities for one game, or say why it can't be modeled. */
function modelGame(
  game: GameInput,
  efficiency: EfficiencyFile,
  now: Date,
): ModelGameResult | Unmodeled {
  if (game.startTime) {
    const daysOut = (Date.parse(game.startTime) - now.getTime()) / 86_400_000;
    if (daysOut > MAX_HORIZON_DAYS) {
      return { reason: `starts in ${Math.round(daysOut)} days (model horizon is ${MAX_HORIZON_DAYS})`, bySampleRule: true };
    }
  }

  const homeEff = findTeam(game.homeTeam, efficiency.teams);
  const awayEff = findTeam(game.awayTeam, efficiency.teams);
  const gap = teamGap(game.homeTeam, homeEff, efficiency) ?? teamGap(game.awayTeam, awayEff, efficiency);
  if (gap || !homeEff || !awayEff) return gap ?? { reason: "no rating", bySampleRule: false };

  const homeNetRtg = homeEff.homeNetRtg ?? homeEff.netRtg;
  const awayNetRtg = awayEff.awayNetRtg ?? awayEff.netRtg;
  if (homeNetRtg == null || awayNetRtg == null) return { reason: "net rating missing", bySampleRule: false };

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
  /** Clock for the age and horizon rules. Defaults to the real time. */
  now?: Date;
};

/** Pure function: given games + efficiency data, build the model output envelope. */
export function buildBasketballModel(args: BuildModelArgs): ModelOutput {
  const { source, games, efficiency } = args;
  const now = args.now ?? new Date();
  const generatedAt = now.toISOString();

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
  let note: string | undefined;
  let status: ModelOutput["status"];

  const ageHours = (now.getTime() - Date.parse(efficiency.fetchedAt)) / 3_600_000;
  if (!Number.isFinite(ageHours) || ageHours > MAX_EFFICIENCY_AGE_HOURS) {
    // A stale file is how the 2026-09-29 Christmas pick happened: the refresh
    // had been exiting without writing since July, so the model kept reading
    // one Finals game. Price nothing rather than price off it.
    status = "no-data";
    note = Number.isFinite(ageHours)
      ? `efficiency file is ${Math.round(ageHours)}h old (limit ${MAX_EFFICIENCY_AGE_HOURS}h) — not modeling any game`
      : "efficiency file has no valid fetchedAt — not modeling any game";
    errors.push(note);
  } else {
    let bySampleRule = 0;
    for (const game of games) {
      const r = modelGame(game, efficiency, now);
      if ("homeWinProb" in r) {
        results.push(r);
        continue;
      }
      if (r.bySampleRule) bySampleRule++;
      errors.push(`unmodeled: ${game.awayTeam} @ ${game.homeTeam} (${game.eventId}) — ${r.reason}`);
    }
    if (results.length > 0) status = "ok";
    else if (bySampleRule === games.length) {
      status = "insufficient-sample";
      note =
        `No game modeled: teams need ${MIN_GAMES_FOR_RATING} regular-season/playoff games before they get a rating, ` +
        `and games more than ${MAX_HORIZON_DAYS} days out are skipped.`;
    } else status = "no-data";
  }

  return {
    generatedAt,
    source,
    status,
    freshnessMins: 0,
    recordCount: results.length,
    errors,
    ...(note ? { note } : {}),
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
