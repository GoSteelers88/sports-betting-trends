// Server-side data fetcher for the redesigned homepage.
// Reads odds + model + injuries from data/processed/, picks + outcomes from Turso/Prisma.

import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

type PickWithOutcome = Prisma.AgentPickGetPayload<{ include: { outcome: true } }>;
type OutcomeWithPick = Prisma.AgentOutcomeGetPayload<{ include: { pick: true } }>;

const PROCESSED = path.resolve(process.cwd(), "data", "processed");

export type SlateGame = {
  league: "NBA" | "MLB";
  eventId: string;
  commenceTime: string;
  homeTeam: string;
  awayTeam: string;
  consensus: {
    home: { american: number; impliedProb: number } | null;
    away: { american: number; impliedProb: number } | null;
    spread: { line: number; homePrice: number; awayPrice: number } | null;
    total: { line: number; overPrice: number; underPrice: number } | null;
  };
  modelHomeProb: number | null;
  modelAwayProb: number | null;
  expectedMargin: number | null;
  hasPick: boolean;
  pick: SlatePick | null;
  bookCount: number;
};

export type SlatePick = {
  id: number;
  league: string;
  matchup: string;
  market: string;
  selection: string;
  oddsAmerican: number;
  edge: number;
  modelProb: number;
  marketProb: number;
  kellyStakeUnits: number;
  confidence: number;
  thesis: string;
  invalidation: string;
  outcome: { result: string; unitsPnl: number | null } | null;
  closingOddsAmerican: number | null;
  clvCents: number | null;
  createdAt: string;
};

export type PipelineStatus = {
  totalRunsLast14d: number;
  rawAnalystPicks14d: number;
  graderKept14d: number;
  criticKilled14d: number;
  bankrollDropped14d: number;
  finalShipped14d: number;
  parseFailedRuns14d: number;
  killRatePct: number | null;
  avgClvCents: number | null;
  clvSampleSize: number;
};

export type TrackRecord = {
  windowDays: number;
  total: number;
  wins: number;
  losses: number;
  pushes: number;
  pnl: number;
  roi: number | null;
  byLeague: Record<string, { wins: number; losses: number; pnl: number }>;
};

export type Injury = {
  league: string;
  player: string;
  team: string;
  position?: string;
  status: string;
  injuryType?: string;
};

export type MarketPick = {
  league: string;
  matchup: string;
  pickTeam: string;
  line: string | null;
  confidence: number;
  score: number;
  rationaleSignals: string[];
  gameDate: string | null;
  spread: number | null;
  modelSpread: number | null;
};

export type PlayerProp = {
  player: string;
  team: string | null;
  opponent: string | null;
  market: string;
  marketLabel?: string;
  category?: string;
  line: number;
  overPrice: number | null;
  underPrice: number | null;
  pickSide: "over" | "under";
  confidence: number;
  rationaleSignals: string[];
};

export type PaperTrial = {
  startDate: string;       // ISO
  dayNumber: number;       // 1..30
  daysRemaining: number;   // 0..29
  totalGraded: number;
  wins: number;
  losses: number;
  pushes: number;
  pnl: number;
  totalStake: number;
  roi: number | null;
  maxLossStreak: number;
  criticKillRate: number | null;
  // Decision criteria (computed live)
  ready: boolean;          // all 5 criteria met
  criteria: Array<{ label: string; met: boolean; current: string; target: string }>;
};

export type DashboardData = {
  generatedAt: string;
  slate: SlateGame[];
  picks: SlatePick[];
  marketPicks: MarketPick[];
  playerProps: PlayerProp[];
  trackRecord7: TrackRecord;
  trackRecord30: TrackRecord;
  paperTrial: PaperTrial;
  pipelineStatus: PipelineStatus;
  injuries: Injury[];
  status: {
    lastAgentRunAt: string | null;
    nextScheduledRunUtc: string;
    todayPickCount: number;
    todaySlateCount: number;
    todayPnl: number;
  };
};

// ─── helpers ───────────────────────────────────────────────────────────────

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(PROCESSED, file), "utf8")) as T;
  } catch {
    return fallback;
  }
}

function americanToImplied(p: number): number {
  return p > 0 ? 100 / (p + 100) : -p / (-p + 100);
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

// ─── odds + model loaders ──────────────────────────────────────────────────

type RawOddsOutcome = { name: string; price: number; point?: number };
type RawOddsMarket = { key: string; outcomes: RawOddsOutcome[] };
type RawOddsBookmaker = { key: string; markets: RawOddsMarket[] };
type RawOddsEvent = {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers?: RawOddsBookmaker[];
};
type RawOddsFile = { events?: RawOddsEvent[] };

const ODDS_FILE: Record<"NBA" | "MLB", string> = {
  NBA: "latest-odds-api-basketball_nba.json",
  MLB: "latest-odds-api-baseball_mlb.json",
};

type ModelGame = {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  homeWinProb: number;
  awayWinProb: number;
  expectedMargin?: number;
};

function loadOdds(league: "NBA" | "MLB"): SlateGame[] {
  const file = readJson<RawOddsFile>(ODDS_FILE[league], { events: [] });
  return (file.events ?? []).map(ev => {
    const home: number[] = [];
    const away: number[] = [];
    const spreads: { line: number; homePrice: number; awayPrice: number }[] = [];
    const totals: { line: number; overPrice: number; underPrice: number }[] = [];

    for (const book of ev.bookmakers ?? []) {
      for (const market of book.markets ?? []) {
        if (market.key === "h2h") {
          for (const o of market.outcomes ?? []) {
            if (o.name === ev.home_team) home.push(o.price);
            if (o.name === ev.away_team) away.push(o.price);
          }
        } else if (market.key === "spreads") {
          const h = market.outcomes.find(o => o.name === ev.home_team);
          const a = market.outcomes.find(o => o.name === ev.away_team);
          if (h && a && typeof h.point === "number")
            spreads.push({ line: h.point, homePrice: h.price, awayPrice: a.price });
        } else if (market.key === "totals") {
          const o = market.outcomes.find(x => x.name?.toLowerCase() === "over");
          const u = market.outcomes.find(x => x.name?.toLowerCase() === "under");
          if (o && u && typeof o.point === "number")
            totals.push({ line: o.point, overPrice: o.price, underPrice: u.price });
        }
      }
    }

    return {
      league,
      eventId: ev.id,
      commenceTime: ev.commence_time,
      homeTeam: ev.home_team,
      awayTeam: ev.away_team,
      consensus: {
        home: home.length
          ? { american: Math.round(median(home)), impliedProb: americanToImplied(median(home)) }
          : null,
        away: away.length
          ? { american: Math.round(median(away)), impliedProb: americanToImplied(median(away)) }
          : null,
        spread: spreads.length
          ? {
              line: median(spreads.map(s => s.line)),
              homePrice: Math.round(median(spreads.map(s => s.homePrice))),
              awayPrice: Math.round(median(spreads.map(s => s.awayPrice))),
            }
          : null,
        total: totals.length
          ? {
              line: median(totals.map(t => t.line)),
              overPrice: Math.round(median(totals.map(t => t.overPrice))),
              underPrice: Math.round(median(totals.map(t => t.underPrice))),
            }
          : null,
      },
      modelHomeProb: null,
      modelAwayProb: null,
      expectedMargin: null,
      hasPick: false,
      pick: null,
      bookCount: (ev.bookmakers ?? []).length,
    } as SlateGame;
  });
}

function loadModelMap(league: "NBA" | "MLB"): Map<string, ModelGame> {
  if (league === "NBA") {
    const file = readJson<{ data?: { results?: ModelGame[] } }>("nba-model.json", {});
    const results = file.data?.results ?? [];
    return new Map(results.map(g => [`${g.homeTeam}::${g.awayTeam}`, g]));
  }
  const file = readJson<{ results?: ModelGame[] }>("mlb-model-output.json", {});
  return new Map((file.results ?? []).map(g => [`${g.homeTeam}::${g.awayTeam}`, g]));
}

function attachModel(games: SlateGame[]): SlateGame[] {
  const nbaModel = loadModelMap("NBA");
  const mlbModel = loadModelMap("MLB");
  return games.map(g => {
    const model = (g.league === "NBA" ? nbaModel : mlbModel).get(`${g.homeTeam}::${g.awayTeam}`);
    if (!model) return g;
    return {
      ...g,
      modelHomeProb: model.homeWinProb,
      modelAwayProb: model.awayWinProb,
      expectedMargin: model.expectedMargin ?? null,
    };
  });
}

// ─── market picks (heuristic best bets) ────────────────────────────────────

type SummaryFile = {
  bestBets?: MarketPick[];
};

function loadMarketPicks(): MarketPick[] {
  const file = readJson<SummaryFile>("latest-summary.json", { bestBets: [] });
  const picks = file.bestBets ?? [];
  // Restrict to NBA + MLB and take the top 5
  return picks
    .filter(p => p.league === "NBA" || p.league === "MLB")
    .slice(0, 5);
}

// ─── player props ──────────────────────────────────────────────────────────

type PropsFile = {
  available?: boolean;
  topProps?: PlayerProp[];
};

function loadPlayerProps(): PlayerProp[] {
  const file = readJson<PropsFile>("latest-player-props.json", {});
  if (!file.available) return [];
  return (file.topProps ?? []).slice(0, 5);
}

// ─── injuries ──────────────────────────────────────────────────────────────

type InjuryFile = { players?: Array<{ player: string; team: string; position?: string; status: string; injuryType?: string }> };

function loadInjuries(): Injury[] {
  const nba = readJson<InjuryFile>("injuries-nba.json", { players: [] });
  const out: Injury[] = [];
  for (const p of nba.players ?? []) {
    if (p.status?.toLowerCase().includes("out") || p.status?.toLowerCase().includes("doubtful")) {
      out.push({ league: "NBA", ...p });
    }
  }
  return out;
}

// ─── DB queries ────────────────────────────────────────────────────────────

async function loadTodaysPicks(): Promise<SlatePick[]> {
  // UTC midnight (matches the persistence convention) — previously used local
  // tz which slipped on non-UTC hosts and on Vercel during DST transitions.
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  let picks: PickWithOutcome[];
  try {
    picks = await prisma.agentPick.findMany({
      where: {
        createdAt: { gte: since },
        league: { in: ["NBA", "MLB"] },
      },
      include: { outcome: true },
      orderBy: { edge: "desc" },
    });
  } catch (err) {
    console.error("loadTodaysPicks failed (DB unavailable):", err);
    return [];
  }
  return picks.map(p => ({
    id: p.id,
    league: p.league,
    matchup: p.matchup,
    market: p.market,
    selection: p.selection,
    oddsAmerican: p.oddsAmerican,
    edge: p.edge,
    modelProb: p.modelProb,
    marketProb: p.marketProb,
    kellyStakeUnits: p.kellyStakeUnits,
    confidence: p.confidence,
    thesis: p.thesis,
    invalidation: p.invalidation,
    outcome: p.outcome
      ? { result: p.outcome.result, unitsPnl: p.outcome.unitsPnl ?? null }
      : null,
    closingOddsAmerican: p.closingOddsAmerican ?? null,
    clvCents: p.clvCents ?? null,
    createdAt: p.createdAt.toISOString(),
  }));
}

async function loadPipelineStatus(): Promise<PipelineStatus> {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const status: PipelineStatus = {
    totalRunsLast14d: 0,
    rawAnalystPicks14d: 0,
    graderKept14d: 0,
    criticKilled14d: 0,
    bankrollDropped14d: 0,
    finalShipped14d: 0,
    parseFailedRuns14d: 0,
    killRatePct: null,
    avgClvCents: null,
    clvSampleSize: 0,
  };
  try {
    const runs = await prisma.agentRun.findMany({
      where: { createdAt: { gte: since } },
    });
    for (const r of runs) {
      status.totalRunsLast14d++;
      status.rawAnalystPicks14d += r.rawAnalystPicks;
      status.graderKept14d += r.graderKept;
      status.criticKilled14d += r.criticKilled;
      status.bankrollDropped14d += r.bankrollDropped;
      status.finalShipped14d += r.finalPickCount;
      if (r.parseFailed) status.parseFailedRuns14d++;
    }
    if (status.rawAnalystPicks14d > 0) {
      status.killRatePct = +((status.criticKilled14d / status.rawAnalystPicks14d) * 100).toFixed(1);
    }
    const clvPicks = await prisma.agentPick.findMany({
      where: { createdAt: { gte: since }, clvCents: { not: null } },
      select: { clvCents: true },
    });
    if (clvPicks.length > 0) {
      const sum = clvPicks.reduce((s, p) => s + (p.clvCents ?? 0), 0);
      status.avgClvCents = +(sum / clvPicks.length).toFixed(2);
      status.clvSampleSize = clvPicks.length;
    }
  } catch (err) {
    console.error("loadPipelineStatus failed:", err);
  }
  return status;
}

async function loadTrackRecord(days: number): Promise<TrackRecord> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  let outcomes: OutcomeWithPick[];
  try {
    outcomes = await prisma.agentOutcome.findMany({
      where: {
        gradedAt: { gte: since },
        result: { in: ["win", "loss", "push"] },
      },
      include: { pick: true },
    });
  } catch (err) {
    console.error("loadTrackRecord failed (DB unavailable):", err);
    outcomes = [];
  }
  const acc: TrackRecord = {
    windowDays: days,
    total: 0,
    wins: 0,
    losses: 0,
    pushes: 0,
    pnl: 0,
    roi: null,
    byLeague: {},
  };
  let totalStake = 0;
  for (const o of outcomes) {
    acc.total++;
    if (o.result === "win") acc.wins++;
    else if (o.result === "loss") acc.losses++;
    else if (o.result === "push") acc.pushes++;
    acc.pnl += o.unitsPnl ?? 0;
    totalStake += o.pick.kellyStakeUnits;
    const lg = (acc.byLeague[o.pick.league] ??= { wins: 0, losses: 0, pnl: 0 });
    if (o.result === "win") lg.wins++;
    else if (o.result === "loss") lg.losses++;
    lg.pnl += o.unitsPnl ?? 0;
  }
  if (totalStake > 0) acc.roi = acc.pnl / totalStake;
  acc.pnl = +acc.pnl.toFixed(2);
  return acc;
}

// Reads from AgentRun first (every orchestrator invocation, even ones that
// produced 0 final picks) and falls back to AgentPick.createdAt for runs
// before AgentRun existed.
async function loadLastAgentRunAt(): Promise<string | null> {
  try {
    const lastRun = await prisma.agentRun.findFirst({
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (lastRun) return lastRun.createdAt.toISOString();
  } catch {
    // fall through to AgentPick lookup
  }
  try {
    const lastPick = await prisma.agentPick.findFirst({
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    return lastPick?.createdAt.toISOString() ?? null;
  } catch {
    return null;
  }
}

const PAPER_TRIAL_START = new Date("2026-05-06T00:00:00Z");
const PAPER_TRIAL_DAYS = 30;

async function loadPaperTrial(): Promise<PaperTrial> {
  const now = new Date();
  const elapsedMs = Math.max(0, now.getTime() - PAPER_TRIAL_START.getTime());
  const dayNumber = Math.min(PAPER_TRIAL_DAYS, Math.floor(elapsedMs / (24 * 60 * 60 * 1000)) + 1);
  const daysRemaining = Math.max(0, PAPER_TRIAL_DAYS - dayNumber);

  let totalGraded = 0;
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let pnl = 0;
  let totalStake = 0;
  let maxLossStreak = 0;
  let criticKillRate: number | null = null;
  let totalPicks = 0;
  let killedByCriticEstimate = 0;

  try {
    const outcomes = await prisma.agentOutcome.findMany({
      where: {
        gradedAt: { gte: PAPER_TRIAL_START },
        result: { in: ["win", "loss", "push"] },
      },
      include: { pick: true },
      orderBy: { gradedAt: "asc" },
    });
    totalGraded = outcomes.length;
    let curStreak = 0;
    for (const o of outcomes) {
      if (o.result === "win") {
        wins++;
        curStreak = 0;
      } else if (o.result === "loss") {
        losses++;
        curStreak++;
        maxLossStreak = Math.max(maxLossStreak, curStreak);
      } else if (o.result === "push") {
        pushes++;
      }
      pnl += o.unitsPnl ?? 0;
      totalStake += o.pick.kellyStakeUnits;
    }

    // Critic kill rate from real AgentRun metadata.
    // Kill rate = critic-killed / (raw analyst picks ever generated).
    const runs = await prisma.agentRun.findMany({
      where: { createdAt: { gte: PAPER_TRIAL_START } },
      select: { rawAnalystPicks: true, criticKilled: true, finalPickCount: true },
    });
    const rawTotal = runs.reduce((s, r) => s + r.rawAnalystPicks, 0);
    const killedTotal = runs.reduce((s, r) => s + r.criticKilled, 0);
    totalPicks = runs.reduce((s, r) => s + r.finalPickCount, 0);
    killedByCriticEstimate = killedTotal;
    if (rawTotal > 0) {
      criticKillRate = killedTotal / rawTotal;
    }
  } catch (err) {
    console.error("paperTrial DB read failed:", err);
  }

  const decided = wins + losses;
  const winRate = decided > 0 ? wins / decided : 0;
  const roi = totalStake > 0 ? pnl / totalStake : null;

  const criteria = [
    {
      label: "Sample size ≥ 30",
      met: totalGraded >= 30,
      current: `${totalGraded}`,
      target: "30",
    },
    {
      label: "ROI ≥ +3%",
      met: roi !== null && roi >= 0.03,
      current: roi !== null ? `${(roi * 100).toFixed(1)}%` : "—",
      target: "+3%",
    },
    {
      label: "Win rate > 50%",
      met: decided >= 10 && winRate > 0.5,
      current: decided > 0 ? `${(winRate * 100).toFixed(1)}%` : "—",
      target: "≥ 50%",
    },
    {
      label: "Max loss streak < 8",
      met: maxLossStreak < 8,
      current: `${maxLossStreak}`,
      target: "< 8",
    },
    {
      label: "Critic kill rate ≥ 25%",
      met: criticKillRate !== null && criticKillRate >= 0.25,
      current: criticKillRate !== null ? `${(criticKillRate * 100).toFixed(1)}%` : "—",
      target: "≥ 25%",
    },
  ];

  return {
    startDate: PAPER_TRIAL_START.toISOString(),
    dayNumber,
    daysRemaining,
    totalGraded,
    wins,
    losses,
    pushes,
    pnl: +pnl.toFixed(2),
    totalStake: +totalStake.toFixed(2),
    roi,
    maxLossStreak,
    criticKillRate,
    ready: criteria.every(c => c.met),
    criteria,
  };
}

// ─── orchestrator ──────────────────────────────────────────────────────────

export async function getDashboardData(): Promise<DashboardData> {
  const allGames = attachModel([...loadOdds("NBA"), ...loadOdds("MLB")]);
  const picks = await loadTodaysPicks();

  // Mark games that have picks. Token-aware match — bidirectional substring
  // would attach a NYY pick to a NYM card via the shared "New York" prefix.
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[.'-]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const teamInMatchup = (matchup: string, team: string): boolean => {
    const m = norm(matchup);
    const t = norm(team);
    if (!m || !t) return false;
    const teamTokens = t.split(/\s+/).filter(x => x.length >= 4);
    if (teamTokens.length === 0) return m.includes(t);
    const matchupTokens = new Set(m.split(/\s+/));
    return teamTokens.every(x => matchupTokens.has(x));
  };
  const picksByGame = new Map<string, SlatePick>();
  for (const p of picks) {
    const game = allGames.find(g => teamInMatchup(p.matchup, g.homeTeam) || teamInMatchup(p.matchup, g.awayTeam));
    if (game) picksByGame.set(game.eventId, p);
  }
  const slate = allGames
    .map(g => ({
      ...g,
      hasPick: picksByGame.has(g.eventId),
      pick: picksByGame.get(g.eventId) ?? null,
    }))
    .sort((a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime());

  const [trackRecord7, trackRecord30, lastAgentRunAt, paperTrial, pipelineStatus] = await Promise.all([
    loadTrackRecord(7),
    loadTrackRecord(30),
    loadLastAgentRunAt(),
    loadPaperTrial(),
    loadPipelineStatus(),
  ]);

  const injuries = loadInjuries();
  const marketPicks = loadMarketPicks();
  const playerProps = loadPlayerProps();

  const todayPnl = picks.reduce((s, p) => s + (p.outcome?.unitsPnl ?? 0), 0);

  // Next scheduled run: 14:00 or 22:30 UTC, whichever is next
  const now = new Date();
  const utc14 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 14));
  const utc2230 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 22, 30));
  const utc14Tomorrow = new Date(utc14.getTime() + 24 * 60 * 60 * 1000);
  let next: Date;
  if (now < utc14) next = utc14;
  else if (now < utc2230) next = utc2230;
  else next = utc14Tomorrow;

  return {
    generatedAt: new Date().toISOString(),
    slate,
    picks,
    marketPicks,
    playerProps,
    trackRecord7,
    trackRecord30,
    paperTrial,
    pipelineStatus,
    injuries,
    status: {
      lastAgentRunAt,
      nextScheduledRunUtc: next.toISOString(),
      todayPickCount: picks.length,
      todaySlateCount: slate.length,
      todayPnl: +todayPnl.toFixed(2),
    },
  };
}
