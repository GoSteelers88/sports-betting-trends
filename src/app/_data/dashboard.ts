// Server-side data fetcher for the redesigned homepage.
// Reads odds + model + injuries from data/processed/, picks + outcomes from Turso/Prisma.

import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";

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
  createdAt: string;
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

export type DashboardData = {
  generatedAt: string;
  slate: SlateGame[];
  picks: SlatePick[];
  trackRecord7: TrackRecord;
  trackRecord30: TrackRecord;
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
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  let picks: Awaited<ReturnType<typeof prisma.agentPick.findMany>>;
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
    createdAt: p.createdAt.toISOString(),
  }));
}

async function loadTrackRecord(days: number): Promise<TrackRecord> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  let outcomes: Awaited<ReturnType<typeof prisma.agentOutcome.findMany>>;
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

async function loadLastAgentRunAt(): Promise<string | null> {
  try {
    const last = await prisma.agentPick.findFirst({
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    return last?.createdAt.toISOString() ?? null;
  } catch {
    return null;
  }
}

// ─── orchestrator ──────────────────────────────────────────────────────────

export async function getDashboardData(): Promise<DashboardData> {
  const allGames = attachModel([...loadOdds("NBA"), ...loadOdds("MLB")]);
  const picks = await loadTodaysPicks();

  // Mark games that have picks
  const picksByGame = new Map<string, SlatePick>();
  for (const p of picks) {
    // Heuristic: match pick.matchup substring against game home or away team
    const game = allGames.find(g =>
      p.matchup.toLowerCase().includes(g.homeTeam.toLowerCase()) ||
      p.matchup.toLowerCase().includes(g.awayTeam.toLowerCase())
    );
    if (game) picksByGame.set(game.eventId, p);
  }
  const slate = allGames
    .map(g => ({
      ...g,
      hasPick: picksByGame.has(g.eventId),
      pick: picksByGame.get(g.eventId) ?? null,
    }))
    .sort((a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime());

  const [trackRecord7, trackRecord30, lastAgentRunAt] = await Promise.all([
    loadTrackRecord(7),
    loadTrackRecord(30),
    loadLastAgentRunAt(),
  ]);

  const injuries = loadInjuries();

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
    trackRecord7,
    trackRecord30,
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
