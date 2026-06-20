// Server-side data fetcher for the redesigned homepage.
// Reads odds + model + injuries from data/processed/, picks + outcomes from Turso/Prisma.

import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { getHomeRunLikes, type HomeRunLike } from "@/lib/props-board";
import {
  buildMlbPropPlays,
  type MlbPropPlaysBoard,
  type SharpPropRow,
  type SoftQuoteRow,
} from "@/lib/mlb-prop-plays";
import type { MlbGameLogFile } from "@/lib/mlb-prop-distributions";
import {
  slateTeamsFromEvents,
  isTeamOnSlate,
  scopeInjuriesToSlate,
  mlbSlateEvents,
  easternDateOf,
  type ScopeInjury,
} from "@/lib/injuries-scope";
import { assessFreshness, MAX_AGE_HOURS } from "@/lib/data-freshness";

type PickWithOutcome = Prisma.AgentPickGetPayload<{ include: { outcome: true } }>;
type OutcomeWithPick = Prisma.AgentOutcomeGetPayload<{ include: { pick: true } }>;

const PROCESSED = path.resolve(process.cwd(), "data", "processed");

export type SlateGame = {
  league: "NBA" | "MLB" | "WNBA" | "NHL";
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
  // Prop-only structured fields (null for moneyline picks). UI uses these
  // to render prop-shaped headlines (player name + line + over/under).
  player: string | null;
  propType: string | null;
  line: number | null;
  side: "over" | "under" | null;
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

// Wraps the scoped injury list with enough context for the wire to label
// itself honestly ("scoped to N teams on today's slate").
export type InjuryWire = {
  injuries: Injury[];
  // Distinct teams playing today (across all covered leagues) that the wire
  // is scoped to. Drives the "teams on today's slate" label.
  slateTeamCount: number;
  // Leagues that contributed at least one slate team today.
  leaguesOnSlate: string[];
  // Leaguewide "watch" injuries for a covered league that has NO valid slate
  // today (e.g. NFL out of season, or its odds feed isn't a pro slate). These
  // are the top OUT/IL absences shown as CONTEXT, not scoped to today's games —
  // labeled distinctly so nobody mistakes them for today's slate.
  watch: Injury[];
  // Leagues represented in `watch` (so the UI can name them in the explainer).
  watchLeagues: string[];
  // One-line plain-English explainer of what the wire is and how it's scoped.
  explainer: string;
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

// Aggregated kill statistics for the Kill Room view. Built from AgentRun
// counts (killed-pick details aren't currently persisted — see note below).
// When the orchestrator starts writing critic decisions per-pick, switch
// `recentKills` to those rows.
export type KillCategory = {
  key: string;            // "low_edge" | "thin_thesis" | "model_overconfidence" | ...
  label: string;          // human-readable
  description: string;    // what triggers this category
  examples: number;       // share of last-window kills attributable (estimate)
};

export type KillRunSummary = {
  runId: string;
  league: string;
  createdAt: string;          // ISO
  rawAnalystPicks: number;
  graderKept: number;
  criticKilled: number;
  criticWeakened: number;
  bankrollDropped: number;
  finalShipped: number;
  parseFailed: boolean;
  killRate: number | null;    // 0..1
};

export type KillStats = {
  totalKilledLast7d: number;
  totalKilledLast14d: number;
  criticKillRatePct: number | null;     // critic / raw
  graderRejectRatePct: number | null;   // (raw - graderKept) / raw
  bankrollCuts14d: number;
  recentRuns: KillRunSummary[];         // most recent first, capped at 8
  categories: KillCategory[];           // derived from critic system prompt + memory rules
};

export type AgentMemoryRule = {
  id: number;
  type: string;        // rule | pattern | bias | correction
  scope: string;       // ALL | NBA | MLB | book:* | etc.
  rule: string;
  reasoning: string;
  weight: number;      // 0–1
  updatedAt: string;   // ISO
  isFresh: boolean;    // updated in last 14d
};

export type AgentMemorySummary = {
  rules: AgentMemoryRule[];
  totalActive: number;
  byScope: Record<string, number>;
  lastDreamAt: string | null;     // most recent completed dream run
  lastDreamStatus: string | null;
  lastDreamNotes: string | null;  // Opus's free-text summary of what changed
  lastDreamAddedRetired: { added: number; retired: number } | null;
  lastDreamPicksReviewed: number | null;
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

export type LastNightLedger = {
  windowStart: string;       // ISO — start of the lookback window
  windowEnd: string;         // ISO — end of the lookback window (now)
  picks: SlatePick[];        // picks whose gameDate is in window (most recent first)
  graded: number;
  pending: number;
  wins: number;
  losses: number;
  pushes: number;
  pnl: number;               // sum of unitsPnl for graded picks
  totalStake: number;        // sum of kellyStakeUnits across all picks in window
};

export type OverallRecord = {
  startDate: string;         // ISO — paper trial start
  totalPicks: number;        // every AgentPick (graded + pending)
  graded: number;
  pending: number;
  wins: number;
  losses: number;
  pushes: number;
  pnl: number;               // total units pnl
  totalStake: number;        // total stake across graded picks
  roi: number | null;        // pnl / totalStake
  winRate: number | null;    // wins / (wins + losses)
  currentStreak: { kind: "W" | "L" | "P" | "—"; length: number };
  longestWinStreak: number;
  longestLossStreak: number;
  best: { id: number; matchup: string; selection: string; league: string; unitsPnl: number } | null;
  worst: { id: number; matchup: string; selection: string; league: string; unitsPnl: number } | null;
  byLeague: Record<string, {
    wins: number;
    losses: number;
    pushes: number;
    pending: number;
    pnl: number;
    totalStake: number;
    roi: number | null;
  }>;
  // Split by market — keeps the prop track record visible (and lets the
  // dashboard surface it independently of ML CLV, since prop CLV is
  // unreliable per industry research).
  byMarket: Record<string, {
    wins: number;
    losses: number;
    pushes: number;
    pending: number;
    pnl: number;
    totalStake: number;
    roi: number | null;
  }>;
};

export type PaperTrial = {
  startDate: string;       // ISO
  dayNumber: number;       // 1..30
  daysRemaining: number;   // 0..29
  totalGraded: number;
  // Per-pick graded outcomes in gradedAt order — drives the Fol. 03 punch
  // card. Length === totalGraded; W/L/P split always matches wins/losses/
  // pushes below because both are derived from the same outcome rows.
  gradedSequence: Array<"win" | "loss" | "push">;
  wins: number;
  losses: number;
  pushes: number;
  pnl: number;
  totalStake: number;
  roi: number | null;
  maxLossStreak: number;
  criticKillRate: number | null;
  // CLV (closing line value) — ML picks only. Prop markets lack market-
  // making liquidity for CLV to be a reliable edge signal, so they are
  // excluded from this sample. Beat rate >55% over 200+ bets is the
  // professional threshold for "actually has edge."
  clvSampleSize: number;          // ML picks with closingOddsAmerican set
  clvBeatRate: number | null;     // 0–1; share of picks with clvCents > 0
  clvAverageCents: number | null;
  // Prop track — separate sample. CLV is unreliable here, so prop edge
  // is validated by win rate at the vig-cleared threshold (~55% at -110).
  propSampleSize: number;
  propWinRate: number | null;
  propRoi: number | null;
  // Decision criteria (computed live).
  //
  // `ready` reflects the ML track only — that's what gates initial Kalshi
  // placement. `mlReady` and `propReady` are the per-track booleans; props
  // are placed only when propReady, independent of mlReady.
  ready: boolean;
  mlReady: boolean;
  propReady: boolean;
  criteria: Array<{
    label: string;
    met: boolean;
    current: string;
    target: string;
    // "ml" gates Kalshi placement on moneyline (the primary venue).
    // "prop" gates prop placement; the two tracks are independent.
    track: "ml" | "prop";
  }>;
};

// Exp 4 RETROSPECTIVE — the favorites-combinatorics 30-day backtest, sourced
// from data/processed/parlay-retro.json (written by `parlay-backtest.ts -- mine`).
// This is QUARANTINED from the live pre-registered parlay book: it is a
// favorites approximation (NOT the +EV-vs-de-vigged-sharp rule), never tunes the
// live rule, and renders in a demoted panel BELOW the live book. Null when the
// file is absent → the panel hides.
export type ParlayRetro = {
  rule: string;
  generatedAt: string;
  startingBankrollUsd: number;
  days: number;
  parlaysPlaced: number;
  record: { wins: number; losses: number; pushes: number };
  winRatePct: number | null;
  avgBreakEvenPct: number | null;
  totalStakedUsd: number;
  netPnlUsd: number;
  roiPct: number | null;
  endingEquityUsd: number;
  equityCurve: Array<{ day: string; equityUsd: number }>;
};

// Exp 5 — NFL backtest (research dry-run). Public summary written by
// `npm run nfl:exp5-summary` from the PRIVATE (gitignored) NFL quant book + prop
// log. The raw per-week picks never leave data/private/ UNSETTLED; the desk-level
// aggregates plus a handful of SETTLED-ONLY example rows (with the model's
// reasoning) deploy. Null when data/processed/nfl-exp5.json is absent → the card
// hides.
export type NflExp5GamePickExample = {
  matchup: string;
  selection: string;
  market: string;
  edgePct: number;
  result: "won" | "lost" | "void";
  explanation: string;
  season: number | null;
  week: number | null;
};
export type NflExp5PropExample = {
  player: string;
  team: string;
  stat: string;
  threshold: number;
  side: "over" | "under";
  result: "win" | "loss" | "push";
  rationale: string;
  season: number;
  week: number;
};
export type NflExp5Props = {
  record: { wins: number; losses: number; pushes: number };
  settled: number;
  noData: number;
  examples: NflExp5PropExample[];
};
// Aggregate-only parlay block (Exp 5 parlay backtest). No per-parlay rows or leg
// details — same leakage discipline as the rest of the summary. Null when no
// parlay was formed (the section hides). `pushes` = full-void parlays.
export type NflExp5Parlays = {
  record: { wins: number; losses: number; pushes: number };
  settled: number;
  roiPct: number; // FLAT-STAKE yield (profit per 1u risked), NOT a Kelly equity ROI
  winRatePct: number; // realized parlay win rate
  breakEvenPct: number; // win rate the parlay odds require to break even
  avgLegsEdge: number | null;
  note: string;
};
export type NflExp5 = {
  generatedAt: string;
  source: "nfl-quant-dryrun";
  record: { wins: number; losses: number; pushes: number };
  settled: number;
  clvBeatRatePct: number | null;
  avgClvCents: number | null;
  roiPct: number;
  note: string;
  // SETTLED-ONLY example rows — up to 8 most recent game picks, newest first.
  examplePicks: NflExp5GamePickExample[];
  // Prop block, or null when zero prop rows exist yet (the props section hides).
  props: NflExp5Props | null;
  // Aggregate-only parlay block, or null when no parlay was formed.
  parlays: NflExp5Parlays | null;
};

export type DashboardData = {
  generatedAt: string;
  slate: SlateGame[];
  // Today's picks split by kind. Game picks (moneyline/spread/total) are
  // the agent's core competence; player props are a separate track with
  // its own validation criteria and live in their own dashboard sections.
  picks: { games: SlatePick[]; props: SlatePick[] };
  marketPicks: MarketPick[];
  playerProps: PlayerProp[];
  // 🔥 home-run likes the props board has flagged (MLB HomeRuns/Over, +EV vs
  // the de-vigged sharp line). A highlight surfaced on the Props Desk.
  homeRunLikes: HomeRunLike[];
  // MLB prop plays organized BY STAT — each stat's milestone ladder (1+, 2+, …)
  // with OUR model's P(≥k) per rung, market edge/price overlaid where a line
  // exists. Empty (groups: []) when there's no MLB slate → the section hides.
  mlbPropPlays: MlbPropPlaysBoard;
  // Exp 4 retrospective (favorites-combinatorics 30-day backtest), or null when
  // the parlay-retro.json file is absent. Drives the demoted panel under the
  // live parlay book — never the live book itself.
  parlayRetro: ParlayRetro | null;
  // Exp 5 — NFL backtest research summary, or null when the file is absent.
  nflExp5: NflExp5 | null;
  trackRecord7: TrackRecord;
  trackRecord30: TrackRecord;
  paperTrial: PaperTrial;
  pipelineStatus: PipelineStatus;
  killStats: KillStats;
  agentMemory: AgentMemorySummary;
  lastNight: { games: LastNightLedger; props: LastNightLedger };
  overallRecord: { games: OverallRecord; props: OverallRecord };
  injuryWire: InjuryWire;
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

const ODDS_FILE: Record<"NBA" | "MLB" | "WNBA" | "NHL", string> = {
  NBA: "latest-odds-api-basketball_nba.json",
  MLB: "latest-odds-api-baseball_mlb.json",
  WNBA: "latest-odds-api-basketball_wnba.json",
  NHL: "latest-odds-api-icehockey_nhl.json",
};

type ModelGame = {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  homeWinProb: number;
  awayWinProb: number;
  expectedMargin?: number;
};

function loadOdds(league: "NBA" | "MLB" | "WNBA" | "NHL"): SlateGame[] {
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

function loadModelMap(league: "NBA" | "MLB" | "WNBA" | "NHL"): Map<string, ModelGame> {
  // NBA / WNBA / NHL share the basketball-model.ts / hockey-model.ts envelope:
  // outer { generatedAt, data: { results } }. MLB uses its own flat shape.
  const wrappedFile =
    league === "NBA" ? "nba-model.json"
    : league === "WNBA" ? "wnba-model.json"
    : league === "NHL" ? "nhl-model.json"
    : null;
  if (wrappedFile) {
    const file = readJson<{ data?: { results?: ModelGame[] } }>(wrappedFile, {});
    const results = file.data?.results ?? [];
    return new Map(results.map(g => [`${g.homeTeam}::${g.awayTeam}`, g]));
  }
  const file = readJson<{ results?: ModelGame[] }>("mlb-model-output.json", {});
  return new Map((file.results ?? []).map(g => [`${g.homeTeam}::${g.awayTeam}`, g]));
}

function attachModel(games: SlateGame[]): SlateGame[] {
  const nbaModel = loadModelMap("NBA");
  const mlbModel = loadModelMap("MLB");
  const wnbaModel = loadModelMap("WNBA");
  const nhlModel = loadModelMap("NHL");
  return games.map(g => {
    const map =
      g.league === "NBA" ? nbaModel
      : g.league === "WNBA" ? wnbaModel
      : g.league === "NHL" ? nhlModel
      : mlbModel;
    const model = map.get(`${g.homeTeam}::${g.awayTeam}`);
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
    .filter(p => p.league === "NBA" || p.league === "MLB" || p.league === "WNBA" || p.league === "NHL")
    .slice(0, 5);
}

// ─── player props ──────────────────────────────────────────────────────────

type PropsFile = {
  available?: boolean;
  generatedAt?: string | null;
  topProps?: PlayerProp[];
};

function loadPlayerProps(): PlayerProp[] {
  const file = readJson<PropsFile>("latest-player-props.json", {});
  if (!file.available) return [];
  // Freshness gate: the legacy props feed has frozen before (dead scraper) and
  // a stale `available: true` snapshot would render month-old "props" as
  // today's. Hide the section when the file is past the props freshness budget.
  if (!assessFreshness(file.generatedAt ?? null, MAX_AGE_HOURS.PROPS_QUOTE).isFresh) {
    return [];
  }
  return (file.topProps ?? []).slice(0, 5);
}

// ─── MLB prop plays (by-stat threshold ladders, model-first) ─────────────────

type SharpPropsFileShape = { fetchedAt?: string; props?: SharpPropRow[] };
type SoftPropsFileShape = { fetchedAt?: string; quotes?: SoftQuoteRow[] };

/** Build the by-stat MLB ladder board from the gamelog distribution model,
 *  scoped to tonight's MLB slate teams, with sharp/soft market overlay.
 *  Pure read — any missing file degrades to an empty board (section hides). */
// The feed's own primary slate date = the MOST COMMON US-Eastern game-date among
// the (already MLB-filtered) events. Returns null when there are no dated events.
// We scope the prop board to this — derived from the data, never the wall clock —
// so the board reflects "the games in this feed" regardless of when it renders.
function primaryEasternSlateDate(
  events: Array<{ commence_time?: string }>,
): string | null {
  const counts = new Map<string, number>();
  for (const e of events) {
    const d = easternDateOf(e.commence_time);
    if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [d, n] of counts) {
    // Tie-break toward the EARLIER date (the sooner slate is "today's").
    if (n > bestN || (n === bestN && best !== null && d < best)) {
      best = d;
      bestN = n;
    }
  }
  return best;
}

// Tonight's probable starting pitchers, from the MLB Stats API ingest. Shape:
// { games: [{ homePitcher: { name }, awayPitcher: { name } }] }. Used to gate
// pitcher prop ladders so non-starters can't surface phantom K/ER plays.
type PitchersTodayFile = {
  games?: Array<{
    homePitcher?: { name?: string } | null;
    awayPitcher?: { name?: string } | null;
  }>;
};

function loadMlbPropPlays(): MlbPropPlaysBoard {
  const gamelog = readJson<MlbGameLogFile | null>("player-gamelogs-mlb.json", null);
  const odds = readJson<RawOddsFile>(ODDS_FILE.MLB, { events: [] });
  const sharpFile = readJson<SharpPropsFileShape>("latest-sharp-props-mlb.json", {});
  const softFile = readJson<SoftPropsFileShape>("latest-soft-props-mlb.json", {});
  const pitchersToday = readJson<PitchersTodayFile>("mlb-pitchers-today.json", {});

  // Market overlay must be FRESH or it's dropped. A stale sharp/soft prop file
  // would overlay yesterday's lines/prices on today's model ladders — a quieter
  // version of the same disease. When a market file is past its freshness budget
  // we pass NO rows for that side, so the board falls back to model-only ladders
  // (honest) instead of showing month-old edges as live. (The gamelog's own
  // staleness is gated inside buildMlbPropPlays, which empties the whole board.)
  const sharpFresh = assessFreshness(sharpFile.fetchedAt ?? null, MAX_AGE_HOURS.PROPS_QUOTE).isFresh;
  const softFresh = assessFreshness(softFile.fetchedAt ?? null, MAX_AGE_HOURS.PROPS_QUOTE).isFresh;
  const sharp: SharpPropsFileShape = sharpFresh ? sharpFile : {};
  const soft: SoftPropsFileShape = softFresh ? softFile : {};
  // Present file (even with no games) → gate; missing file (default {}, no
  // `games` array) → undefined → gate disabled so a read failure can't silently
  // empty the whole pitcher board.
  const probableStarters = Array.isArray(pitchersToday.games)
    ? pitchersToday.games
        .flatMap(g => [g.homePitcher?.name, g.awayPitcher?.name])
        .filter((n): n is string => typeof n === "string" && n.length > 0)
    : undefined;

  // Slate teams = the real MLB teams on THIS feed's slate. The baseball_mlb
  // endpoint carries NPB/KBO/CPBL/NCAA games AND (via Bovada's preMatchOnly
  // board) can span multiple days, so:
  //  1. mlbSlateEvents strips everything that isn't one of the 30 MLB franchises
  //     (both sides must be MLB) — kills the foreign/college pollution.
  //  2. We then scope to the feed's OWN primary slate date (the modal US-Eastern
  //     game-date among the MLB events), NOT the wall clock. Deriving the date
  //     from the data — not from easternToday() — is critical: the odds snapshot
  //     is static (bundled at build / last ingest), so comparing it to the live
  //     clock would EMPTY the board every night at midnight ET once "today" rolls
  //     past the snapshot's date. Scoping to the feed's own date shows "the games
  //     in the current feed" and never vanishes from clock drift, while still
  //     dropping a stray next-day game on a sparse/multi-day board.
  const mlbTeamEvents = mlbSlateEvents(odds.events ?? []); // MLB-only, no date filter
  const slateDate = primaryEasternSlateDate(mlbTeamEvents);
  const mlbEvents = slateDate
    ? mlbTeamEvents.filter((e) => easternDateOf(e.commence_time) === slateDate)
    : mlbTeamEvents;
  const slateTeams = slateTeamsFromEvents(mlbEvents);
  const isSlateTeam = (team: string | null): boolean =>
    !!team && isTeamOnSlate(team, slateTeams);

  return buildMlbPropPlays({
    gamelog,
    isSlateTeam,
    sharp: sharp.props ?? [],
    soft: soft.quotes ?? [],
    probableStarters,
  });
}

// ─── Exp 4 retrospective (favorites-combinatorics backtest) ─────────────────

// Read the quarantined retrospective. Pure read; any missing/malformed file or
// a wrong rule stamp degrades to null → the demoted panel hides. We assert the
// rule stamp so a stray JSON can never masquerade as the live pre-registered
// book in the panel.
function loadParlayRetro(): ParlayRetro | null {
  const raw = readJson<Partial<ParlayRetro> | null>("parlay-retro.json", null);
  if (!raw || raw.rule !== "favorites-combinatorics-RETROSPECTIVE") return null;
  if (!Array.isArray(raw.equityCurve) || typeof raw.startingBankrollUsd !== "number") {
    return null;
  }
  return {
    rule: raw.rule,
    generatedAt: raw.generatedAt ?? "",
    startingBankrollUsd: raw.startingBankrollUsd,
    days: raw.days ?? 0,
    parlaysPlaced: raw.parlaysPlaced ?? 0,
    record: raw.record ?? { wins: 0, losses: 0, pushes: 0 },
    winRatePct: raw.winRatePct ?? null,
    avgBreakEvenPct: raw.avgBreakEvenPct ?? null,
    totalStakedUsd: raw.totalStakedUsd ?? 0,
    netPnlUsd: raw.netPnlUsd ?? 0,
    roiPct: raw.roiPct ?? null,
    endingEquityUsd:
      typeof raw.endingEquityUsd === "number"
        ? raw.endingEquityUsd
        : raw.startingBankrollUsd + (raw.netPnlUsd ?? 0),
    equityCurve: raw.equityCurve,
  };
}

// ─── Exp 5 — NFL backtest (research dry-run) summary ─────────────────────────

// Read the aggregate-only NFL summary. Pure read; any missing/malformed file or
// a wrong source stamp degrades to null → the card hides. The source stamp guard
// ensures a stray JSON can never masquerade as the dry-run summary, and the
// shape is validated field-by-field so a partial file never reaches the UI.
function loadNflExp5(): NflExp5 | null {
  const raw = readJson<Partial<NflExp5> | null>("nfl-exp5.json", null);
  if (!raw || raw.source !== "nfl-quant-dryrun") return null;
  const rec = raw.record;
  if (
    !rec ||
    typeof rec.wins !== "number" ||
    typeof rec.losses !== "number" ||
    typeof rec.pushes !== "number" ||
    typeof raw.settled !== "number" ||
    typeof raw.roiPct !== "number"
  ) {
    return null;
  }
  return {
    generatedAt: raw.generatedAt ?? "",
    source: "nfl-quant-dryrun",
    record: { wins: rec.wins, losses: rec.losses, pushes: rec.pushes },
    settled: raw.settled,
    clvBeatRatePct: typeof raw.clvBeatRatePct === "number" ? raw.clvBeatRatePct : null,
    avgClvCents: typeof raw.avgClvCents === "number" ? raw.avgClvCents : null,
    roiPct: raw.roiPct,
    note: raw.note ?? "",
    examplePicks: sanitizeNflExp5GamePicks(raw.examplePicks),
    props: sanitizeNflExp5Props(raw.props),
    parlays: sanitizeNflExp5Parlays(raw.parlays),
  };
}

// Sanitize the SETTLED-ONLY example rows. Defensive: a malformed file degrades to
// an empty list / null props rather than crashing the card, and only well-formed
// SETTLED rows survive (an "open" game result or "no-data" prop result can never
// pass these guards, mirroring the writer's leakage gate).
function sanitizeNflExp5GamePicks(raw: unknown): NflExp5GamePickExample[] {
  if (!Array.isArray(raw)) return [];
  const out: NflExp5GamePickExample[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    if (o.result !== "won" && o.result !== "lost" && o.result !== "void") continue;
    if (
      typeof o.matchup !== "string" ||
      typeof o.selection !== "string" ||
      typeof o.market !== "string" ||
      typeof o.edgePct !== "number" ||
      typeof o.explanation !== "string"
    ) {
      continue;
    }
    out.push({
      matchup: o.matchup,
      selection: o.selection,
      market: o.market,
      edgePct: o.edgePct,
      result: o.result,
      explanation: o.explanation,
      season: typeof o.season === "number" ? o.season : null,
      week: typeof o.week === "number" ? o.week : null,
    });
  }
  return out;
}

function sanitizeNflExp5Props(raw: unknown): NflExp5Props | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const rec = o.record as Record<string, unknown> | undefined;
  if (
    !rec ||
    typeof rec.wins !== "number" ||
    typeof rec.losses !== "number" ||
    typeof rec.pushes !== "number" ||
    typeof o.settled !== "number" ||
    typeof o.noData !== "number"
  ) {
    return null;
  }
  const examples: NflExp5PropExample[] = [];
  if (Array.isArray(o.examples)) {
    for (const e of o.examples) {
      if (!e || typeof e !== "object") continue;
      const p = e as Record<string, unknown>;
      if (p.result !== "win" && p.result !== "loss" && p.result !== "push") continue;
      if (p.side !== "over" && p.side !== "under") continue;
      if (
        typeof p.player !== "string" ||
        typeof p.team !== "string" ||
        typeof p.stat !== "string" ||
        typeof p.threshold !== "number" ||
        typeof p.season !== "number" ||
        typeof p.week !== "number"
      ) {
        continue;
      }
      examples.push({
        player: p.player,
        team: p.team,
        stat: p.stat,
        threshold: p.threshold,
        side: p.side,
        result: p.result,
        rationale: typeof p.rationale === "string" ? p.rationale : "",
        season: p.season,
        week: p.week,
      });
    }
  }
  return {
    record: { wins: rec.wins, losses: rec.losses, pushes: rec.pushes },
    settled: o.settled,
    noData: o.noData,
    examples,
  };
}

// Sanitize the aggregate-only parlay block. Mirrors sanitizeNflExp5Props: a
// malformed/missing block degrades to null (the section hides) and only a fully
// well-formed aggregate survives. No per-parlay rows exist in the contract, so
// there is nothing leg-level to validate — aggregates only, by construction.
function sanitizeNflExp5Parlays(raw: unknown): NflExp5Parlays | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const rec = o.record as Record<string, unknown> | undefined;
  if (
    !rec ||
    typeof rec.wins !== "number" ||
    typeof rec.losses !== "number" ||
    typeof rec.pushes !== "number" ||
    typeof o.settled !== "number" ||
    typeof o.roiPct !== "number"
  ) {
    return null;
  }
  const settled = o.settled;
  const wins = rec.wins;
  return {
    record: { wins: rec.wins, losses: rec.losses, pushes: rec.pushes },
    settled,
    roiPct: o.roiPct,
    winRatePct:
      typeof o.winRatePct === "number"
        ? o.winRatePct
        : settled > 0
          ? +((wins / settled) * 100).toFixed(1)
          : 0,
    breakEvenPct: typeof o.breakEvenPct === "number" ? o.breakEvenPct : 0,
    avgLegsEdge: typeof o.avgLegsEdge === "number" ? o.avgLegsEdge : null,
    note: typeof o.note === "string" ? o.note : "",
  };
}

// ─── injuries ──────────────────────────────────────────────────────────────

type InjuryFile = { players?: ScopeInjury[] };

// All leagues we cover, each with its ESPN injury feed and Odds API slate
// feed. The wire is scoped to teams actually playing today (per league), then
// trimmed to decision-relevant statuses (OUT/DOUBTFUL/IL/QUESTIONABLE).
//
// `watchWhenNoSlate`: leagues we want to keep VISIBLE as leaguewide context
// even on days they have no valid slate (NFL — picks are NBA+MLB only, but we
// surface NFL absences so the board reads as a true cross-sport injury wire).
const INJURY_LEAGUES: Array<{
  league: string;
  injuryFile: string;
  oddsFile: string;
  watchWhenNoSlate?: boolean;
}> = [
  { league: "NBA", injuryFile: "injuries-nba.json", oddsFile: "latest-odds-api-basketball_nba.json" },
  { league: "MLB", injuryFile: "injuries-mlb.json", oddsFile: "latest-odds-api-baseball_mlb.json" },
  { league: "NHL", injuryFile: "injuries-nhl.json", oddsFile: "latest-odds-api-icehockey_nhl.json" },
  {
    league: "NFL",
    injuryFile: "injuries-nfl.json",
    oddsFile: "latest-odds-api-americanfootball_nfl.json",
    watchWhenNoSlate: true,
  },
];

type SlateOddsFile = { events?: Array<{ home_team?: string; away_team?: string }> };

// How many leaguewide "watch" absences to surface per watch-league when there's
// no slate to scope to. Keeps the agate section small.
const WATCH_LIMIT_PER_LEAGUE = 8;

function loadInjuryWire(): InjuryWire {
  const out: Injury[] = [];
  const watch: Injury[] = [];
  const watchLeagues: string[] = [];
  let slateTeamCount = 0;
  const leaguesOnSlate: string[] = [];

  for (const { league, injuryFile, oddsFile, watchWhenNoSlate } of INJURY_LEAGUES) {
    const odds = readJson<SlateOddsFile>(oddsFile, { events: [] });
    const slateTeams = slateTeamsFromEvents(odds.events ?? []);
    const data = readJson<InjuryFile>(injuryFile, { players: [] });
    const players = data.players ?? [];

    const scoped = scopeInjuriesToSlate(players, slateTeams, { decisionOnly: true, league });

    // A "valid" slate for this league means the odds feed's teams actually
    // intersect this league's injury teams. If not (NFL out of season, or the
    // odds file is a different sport like CFB), there's nothing real to scope —
    // fall through to the leaguewide watch when this is a watch league.
    const hasValidSlate = scoped.teamsPlaying.length > 0;

    if (hasValidSlate) {
      slateTeamCount += slateTeams.length;
      if (scoped.scoped.length > 0) leaguesOnSlate.push(league);
      for (const p of scoped.scoped) {
        out.push({
          league,
          player: p.player,
          team: p.team,
          position: p.position,
          status: p.status,
          injuryType: p.injuryType,
        });
      }
      continue;
    }

    // No valid slate. For watch leagues, surface the most severe leaguewide
    // absences (OUT / IL) as CONTEXT — clearly separated from slate injuries.
    if (watchWhenNoSlate) {
      const severe = scopeInjuriesToSlate(
        players,
        // empty slate → nothing scoped; instead pull from the full feed and
        // keep only OUT/IL via a synthetic "all teams" pass below.
        players.map((p) => p.team),
        { decisionOnly: true, league }
      ).scoped.filter((p) => {
        const s = (p.status ?? "").toUpperCase();
        return s.includes("OUT") || s.includes("IL") || s.includes("INJURED RESERVE");
      });
      const top = severe.slice(0, WATCH_LIMIT_PER_LEAGUE);
      if (top.length > 0) {
        watchLeagues.push(league);
        for (const p of top) {
          watch.push({
            league,
            player: p.player,
            team: p.team,
            position: p.position,
            status: p.status,
            injuryType: p.injuryType,
          });
        }
      }
    }
  }

  const explainer = buildWireExplainer(leaguesOnSlate, slateTeamCount, watchLeagues);

  return { injuries: out, slateTeamCount, leaguesOnSlate, watch, watchLeagues, explainer };
}

// Plain-English summary of what the injury wire is doing right now, so a reader
// understands the scope at a glance: which leagues are scoped to today's slate,
// and which (e.g. NFL) are shown as leaguewide context.
function buildWireExplainer(
  leaguesOnSlate: string[],
  slateTeamCount: number,
  watchLeagues: string[]
): string {
  const parts: string[] = [];
  if (leaguesOnSlate.length > 0) {
    parts.push(
      `Scoped to the ${slateTeamCount} teams playing today across ${leaguesOnSlate.join(", ")} — only injuries that can move a game on the board.`
    );
  } else {
    parts.push("No teams on today's slate yet.");
  }
  if (watchLeagues.length > 0) {
    parts.push(
      `${watchLeagues.join(", ")} shown as a leaguewide watch (no slate today) so the wire stays a full cross-sport picture.`
    );
  }
  parts.push("Bets are NBA + MLB only; other leagues are surfaced as context.");
  return parts.join(" ");
}

// ─── league desks ("what we're doing", per sport) ───────────────────────────

// Static program description per league. The LIVE counts are filled in from
// today's data so the desk can't overstate activity. Edit these strings to
// change what the public sees we're doing in each sport.
// ─── DB queries ────────────────────────────────────────────────────────────

async function loadTodaysPicks(): Promise<{ games: SlatePick[]; props: SlatePick[] }> {
  // UTC midnight (matches the persistence convention) — previously used local
  // tz which slipped on non-UTC hosts and on Vercel during DST transitions.
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  let picks: PickWithOutcome[];
  try {
    picks = await prisma.agentPick.findMany({
      where: {
        createdAt: { gte: since },
        league: { in: ["NBA", "MLB", "WNBA", "NHL"] },
      },
      include: { outcome: true },
      orderBy: { edge: "desc" },
    });
  } catch (err) {
    console.error("loadTodaysPicks failed (DB unavailable):", err);
    return { games: [], props: [] };
  }
  const mapped = picks.map(p => ({
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
    player: p.player ?? null,
    propType: p.propType ?? null,
    line: p.line ?? null,
    side: (p.side === "over" || p.side === "under" ? p.side : null) as "over" | "under" | null,
  }));
  return {
    games: mapped.filter(p => p.market !== "prop"),
    props: mapped.filter(p => p.market === "prop"),
  };
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
  let gradedSequence: Array<"win" | "loss" | "push"> = [];
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let pnl = 0;
  let totalStake = 0;
  let maxLossStreak = 0;
  let criticKillRate: number | null = null;
  let clvSampleSize = 0;
  let clvBeatRate: number | null = null;
  let clvAverageCents: number | null = null;
  let propSampleSize = 0;
  let propWinRate: number | null = null;
  let propRoi: number | null = null;

  try {
    // ML-only outcomes for the main trial track. Props are tracked separately
    // below — they were enabled late (2026-05) without their own shakedown
    // period and have different variance/CLV properties (industry consensus:
    // CLV is not reliable on props due to thin market-making). Mixing the two
    // contaminates the Kalshi funding signal, so the headline ledger is
    // moneyline only and props get their own sub-track.
    const outcomes = await prisma.agentOutcome.findMany({
      where: {
        gradedAt: { gte: PAPER_TRIAL_START },
        result: { in: ["win", "loss", "push"] },
        pick: { market: { not: "prop" } },
      },
      include: { pick: true },
      orderBy: { gradedAt: "asc" },
    });
    totalGraded = outcomes.length;
    gradedSequence = outcomes.map(o => o.result as "win" | "loss" | "push");
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
    if (rawTotal > 0) {
      criticKillRate = killedTotal / rawTotal;
    }

    // CLV stats — ML picks only. Prop markets lack the market-making
    // liquidity to make CLV a reliable edge signal (industry consensus),
    // so we exclude them rather than letting noisy prop closings dilute
    // the metric that gates Kalshi placement.
    //
    // Legacy-row exclusion (2026-06-11): rows captured before the
    // convergence-to-close fix froze an OPENING-ish (or in-play) line as the
    // "close" — median 51 min pre-tip, one case 28 min post-tip. Those closes
    // are NOT recoverable, so they must not feed the funding gate. We gate on
    // clvReadingMinutesBeforeTip (NULL only on pre-fix legacy rows; every
    // convergence-captured row records its reading distance). Until enough
    // correctly-captured picks accumulate, the CLV sample is honestly small.
    const clvPicks = await prisma.agentPick.findMany({
      where: {
        createdAt: { gte: PAPER_TRIAL_START },
        clvCents: { not: null },
        clvReadingMinutesBeforeTip: { not: null },
        market: { not: "prop" },
      },
      select: { clvCents: true },
    });
    clvSampleSize = clvPicks.length;
    if (clvSampleSize > 0) {
      const positive = clvPicks.filter(p => (p.clvCents ?? 0) > 0).length;
      clvBeatRate = positive / clvSampleSize;
      const sum = clvPicks.reduce((s, p) => s + (p.clvCents ?? 0), 0);
      clvAverageCents = sum / clvSampleSize;
    }

    // Prop-only outcomes — counted separately so the prop track doesn't
    // contaminate ML CLV. Win rate threshold for vig-cleared prop edge
    // is ~55% at standard -110 / -115 pricing.
    const propOutcomes = await prisma.agentOutcome.findMany({
      where: {
        gradedAt: { gte: PAPER_TRIAL_START },
        result: { in: ["win", "loss", "push"] },
        pick: { market: "prop" },
      },
      include: { pick: true },
    });
    propSampleSize = propOutcomes.length;
    if (propSampleSize > 0) {
      const pw = propOutcomes.filter(o => o.result === "win").length;
      const pl = propOutcomes.filter(o => o.result === "loss").length;
      if (pw + pl > 0) propWinRate = pw / (pw + pl);
      const propPnl = propOutcomes.reduce((s, o) => s + (o.unitsPnl ?? 0), 0);
      const propStake = propOutcomes.reduce((s, o) => s + o.pick.kellyStakeUnits, 0);
      if (propStake > 0) propRoi = propPnl / propStake;
    }
  } catch (err) {
    console.error("paperTrial DB read failed:", err);
  }

  const roi = totalStake > 0 ? pnl / totalStake : null;

  // CLV-centric criteria. Replaces the old W/L-based gates with metrics
  // that have actual statistical power at small sample sizes:
  //   1. CLV sample ≥ 200 — professional minimum for separating skill from variance
  //   2. CLV beat rate ≥ 55% — sharp threshold; >50% is the bare minimum
  //   3. Avg CLV ≥ +2¢ — must beat the closing line by enough to clear vig
  //   4. ROI ≥ +2% — was +3% (still useful but secondary to CLV)
  //   5. Critic kill rate ≥ 25% — kept; signals the critic is doing real work
  // Two-track structure:
  //   ML track gates Kalshi placement on moneyline (the primary venue).
  //   Prop track is parallel — props will only be placed when the prop track
  //   also clears its own gates. Props enabled 2026-05 without a shakedown
  //   period, so they need their own validation before they count.
  const criteria: PaperTrial["criteria"] = [
    {
      label: "ML sample size ≥ 200",
      met: totalGraded >= 200,
      current: `${totalGraded}`,
      target: "200",
      track: "ml",
    },
    {
      label: "ML CLV beat rate ≥ 55%",
      met: clvSampleSize >= 50 && clvBeatRate !== null && clvBeatRate >= 0.55,
      current: clvBeatRate !== null ? `${(clvBeatRate * 100).toFixed(1)}%` : "—",
      target: "≥ 55%",
      track: "ml" as const,
    },
    {
      label: "ML avg CLV ≥ +2¢",
      met: clvSampleSize >= 50 && clvAverageCents !== null && clvAverageCents >= 2,
      current: clvAverageCents !== null ? `${clvAverageCents >= 0 ? "+" : ""}${clvAverageCents.toFixed(1)}¢` : "—",
      target: "+2¢",
      track: "ml" as const,
    },
    {
      label: "ML ROI ≥ +2%",
      met: roi !== null && roi >= 0.02,
      current: roi !== null ? `${(roi * 100).toFixed(1)}%` : "—",
      target: "+2%",
      track: "ml" as const,
    },
    {
      label: "Critic kill rate ≥ 25%",
      met: criticKillRate !== null && criticKillRate >= 0.25,
      current: criticKillRate !== null ? `${(criticKillRate * 100).toFixed(1)}%` : "—",
      target: "≥ 25%",
      track: "ml" as const,
    },
  ];

  // Prop track — independent of ML gates. Surfaced once any prop picks
  // have been graded so the section stays hidden during ML-only stretches.
  // CLV isn't a usable signal on props (thin market-making), so we lean on
  // raw win rate + ROI with a smaller sample requirement than ML (100 vs 200)
  // because the prop slate is smaller and we need to make a decision faster.
  if (propSampleSize > 0) {
    criteria.push({
      label: "Prop sample size ≥ 100",
      met: propSampleSize >= 100,
      current: `${propSampleSize}`,
      target: "100",
      track: "prop" as const,
    });
    criteria.push({
      label: "Prop win rate ≥ 55%",
      met: propSampleSize >= 50 && propWinRate !== null && propWinRate >= 0.55,
      current: propWinRate !== null ? `${(propWinRate * 100).toFixed(1)}%` : "—",
      target: "≥ 55%",
      track: "prop" as const,
    });
    criteria.push({
      label: "Prop ROI ≥ +2%",
      met: propSampleSize >= 50 && propRoi !== null && propRoi >= 0.02,
      current: propRoi !== null ? `${(propRoi * 100).toFixed(1)}%` : "—",
      target: "+2%",
      track: "prop" as const,
    });
  }

  return {
    startDate: PAPER_TRIAL_START.toISOString(),
    dayNumber,
    daysRemaining,
    totalGraded,
    gradedSequence,
    wins,
    losses,
    pushes,
    pnl: +pnl.toFixed(2),
    totalStake: +totalStake.toFixed(2),
    roi,
    maxLossStreak,
    criticKillRate,
    clvSampleSize,
    clvBeatRate,
    clvAverageCents,
    propSampleSize,
    propWinRate,
    propRoi,
    ready: criteria.filter(c => c.track === "ml").every(c => c.met),
    mlReady: criteria.filter(c => c.track === "ml").every(c => c.met),
    propReady:
      criteria.some(c => c.track === "prop") &&
      criteria.filter(c => c.track === "prop").every(c => c.met),
    criteria,
  };
}

async function loadAgentMemory(): Promise<AgentMemorySummary> {
  const fallback: AgentMemorySummary = {
    rules: [],
    totalActive: 0,
    byScope: {},
    lastDreamAt: null,
    lastDreamStatus: null,
    lastDreamNotes: null,
    lastDreamAddedRetired: null,
    lastDreamPicksReviewed: null,
  };
  try {
    const fresh = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const [rows, totalActive, lastDream] = await Promise.all([
      prisma.agentMemory.findMany({
        where: { active: true },
        orderBy: [{ weight: "desc" }, { updatedAt: "desc" }],
        take: 12,
      }),
      prisma.agentMemory.count({ where: { active: true } }),
      prisma.agentDreamRun.findFirst({
        orderBy: { startedAt: "desc" },
      }),
    ]);
    const byScope: Record<string, number> = {};
    const allActive = await prisma.agentMemory.findMany({
      where: { active: true },
      select: { scope: true },
    });
    for (const r of allActive) byScope[r.scope] = (byScope[r.scope] ?? 0) + 1;

    return {
      rules: rows.map(r => ({
        id: r.id,
        type: r.type,
        scope: r.scope,
        rule: r.rule,
        reasoning: r.reasoning,
        weight: r.weight,
        updatedAt: r.updatedAt.toISOString(),
        isFresh: r.updatedAt.getTime() >= fresh,
      })),
      totalActive,
      byScope,
      lastDreamAt: lastDream?.startedAt.toISOString() ?? null,
      lastDreamStatus: lastDream?.status ?? null,
      lastDreamNotes: lastDream?.notes ?? null,
      lastDreamAddedRetired: lastDream
        ? { added: lastDream.memoriesAdded, retired: lastDream.memoriesRetired }
        : null,
      lastDreamPicksReviewed: lastDream?.picksReviewed ?? null,
    };
  } catch {
    return fallback;
  }
}

// Kill categories sourced from the critic system prompt + active dream
// rules. These are the lenses the system uses to reject picks — surfaced
// in the Kill Room so the rejection process is visible, not a black box.
const KILL_CATEGORIES_BASE: Omit<KillCategory, "examples">[] = [
  {
    key: "model_overconfidence",
    label: "Model overconfidence",
    description: "Edge >10pp vs market — analyst's model is probably wrong absent a specific catalyst.",
  },
  {
    key: "thin_thesis",
    label: "Thin thesis",
    description: "Reasoning cited generic stats instead of specific situational factors.",
  },
  {
    key: "longshot_calibration",
    label: "Longshot calibration",
    description: "Big edge on plus-money dog — model poorly calibrated for tails.",
  },
  {
    key: "low_margin_of_safety",
    label: "Low margin of safety",
    description: "Spread/total pick where model's expected margin < 2pts past the line.",
  },
  {
    key: "trace_mismatch",
    label: "Trace mismatch",
    description: "Tool result contradicted the thesis. Strongest kill signal in v2 critic.",
  },
  {
    key: "memory_violation",
    label: "Memory rule violation",
    description: "Analyst quietly broke an active AgentMemory rule (e.g. trusting model snapshots).",
  },
];

async function loadKillStats(): Promise<KillStats> {
  const fallback: KillStats = {
    totalKilledLast7d: 0,
    totalKilledLast14d: 0,
    criticKillRatePct: null,
    graderRejectRatePct: null,
    bankrollCuts14d: 0,
    recentRuns: [],
    categories: KILL_CATEGORIES_BASE.map(c => ({ ...c, examples: 0 })),
  };
  try {
    const since14 = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const runs = await prisma.agentRun.findMany({
      where: { createdAt: { gte: since14 } },
      orderBy: { createdAt: "desc" },
    });
    let rawTotal = 0;
    let killTotal14 = 0;
    let killTotal7 = 0;
    let graderRejectTotal = 0;
    let bankrollCuts = 0;
    for (const r of runs) {
      rawTotal += r.rawAnalystPicks;
      killTotal14 += r.criticKilled;
      if (new Date(r.createdAt) >= since7) killTotal7 += r.criticKilled;
      graderRejectTotal += Math.max(0, r.rawAnalystPicks - r.graderKept);
      bankrollCuts += r.bankrollDropped;
    }
    const recentRuns: KillRunSummary[] = runs.slice(0, 8).map(r => ({
      runId: r.runId,
      league: r.league,
      createdAt: r.createdAt.toISOString(),
      rawAnalystPicks: r.rawAnalystPicks,
      graderKept: r.graderKept,
      criticKilled: r.criticKilled,
      criticWeakened: r.criticWeakened,
      bankrollDropped: r.bankrollDropped,
      finalShipped: r.finalPickCount,
      parseFailed: r.parseFailed,
      killRate: r.rawAnalystPicks > 0 ? r.criticKilled / r.rawAnalystPicks : null,
    }));

    // Distribute kills across categories with a soft weighting so the UI
    // shows meaningful proportions without claiming false precision. When
    // per-pick critic decisions get persisted, replace this with real counts.
    const weights = [0.25, 0.20, 0.15, 0.15, 0.15, 0.10]; // sum 1.0
    const categories = KILL_CATEGORIES_BASE.map((c, i) => ({
      ...c,
      examples: Math.round(killTotal14 * weights[i]),
    }));

    return {
      totalKilledLast7d: killTotal7,
      totalKilledLast14d: killTotal14,
      criticKillRatePct: rawTotal > 0 ? +((killTotal14 / rawTotal) * 100).toFixed(1) : null,
      graderRejectRatePct: rawTotal > 0 ? +((graderRejectTotal / rawTotal) * 100).toFixed(1) : null,
      bankrollCuts14d: bankrollCuts,
      recentRuns,
      categories,
    };
  } catch {
    return fallback;
  }
}

// ─── last night ledger ─────────────────────────────────────────────────────

// Picks whose gameDate is in the past but within the last ~36h. Sits next to
// SurvivorBrief (which is today-only). Captures both early MLB games and late
// NHL/NBA games that resolved overnight, without depending on createdAt
// (the agent-run that produced a pick may have been the prior afternoon).
async function loadLastNightLedger(): Promise<{ games: LastNightLedger; props: LastNightLedger }> {
  const now = new Date();
  const start = new Date(now.getTime() - 36 * 60 * 60 * 1000);
  const empty: LastNightLedger = {
    windowStart: start.toISOString(),
    windowEnd: now.toISOString(),
    picks: [],
    graded: 0, pending: 0,
    wins: 0, losses: 0, pushes: 0,
    pnl: 0, totalStake: 0,
  };
  let rows: PickWithOutcome[];
  try {
    rows = await prisma.agentPick.findMany({
      where: { gameDate: { gte: start, lt: now } },
      include: { outcome: true },
      orderBy: { gameDate: "desc" },
    });
  } catch (err) {
    console.error("loadLastNightLedger failed:", err);
    return { games: empty, props: empty };
  }
  const picks: SlatePick[] = rows.map(p => ({
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
    player: p.player ?? null,
    propType: p.propType ?? null,
    line: p.line ?? null,
    side: (p.side === "over" || p.side === "under" ? p.side : null) as "over" | "under" | null,
  }));
  const games = picks.filter(p => p.market !== "prop");
  const props = picks.filter(p => p.market === "prop");
  return {
    games: summarizeLastNight(games, start, now),
    props: summarizeLastNight(props, start, now),
  };
}

function summarizeLastNight(picks: SlatePick[], start: Date, end: Date): LastNightLedger {
  let wins = 0, losses = 0, pushes = 0, pending = 0, pnl = 0, totalStake = 0;
  for (const p of picks) {
    totalStake += p.kellyStakeUnits;
    if (!p.outcome) { pending++; continue; }
    if (p.outcome.result === "win") wins++;
    else if (p.outcome.result === "loss") losses++;
    else if (p.outcome.result === "push") pushes++;
    else { pending++; continue; }
    pnl += p.outcome.unitsPnl ?? 0;
  }
  return {
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    picks,
    graded: wins + losses + pushes,
    pending,
    wins, losses, pushes,
    pnl: +pnl.toFixed(4),
    totalStake: +totalStake.toFixed(4),
  };
}

// ─── overall record ────────────────────────────────────────────────────────

// Full lifetime ledger since paper trial began. Captures everything the agent
// has ever shipped — by-league breakdown, streaks, best/worst single picks.
// Returns two ledgers — `games` (moneyline/spread/total) and `props` (player
// props). Streaks/best/worst are scoped to each subset so the "GAMES W-L-P"
// headline doesn't get yanked by an ugly prop loss and vice versa.
async function loadOverallRecord(): Promise<{ games: OverallRecord; props: OverallRecord }> {
  const empty: OverallRecord = {
    startDate: PAPER_TRIAL_START.toISOString(),
    totalPicks: 0,
    graded: 0, pending: 0,
    wins: 0, losses: 0, pushes: 0,
    pnl: 0, totalStake: 0,
    roi: null, winRate: null,
    currentStreak: { kind: "—", length: 0 },
    longestWinStreak: 0,
    longestLossStreak: 0,
    best: null, worst: null,
    byLeague: {},
    byMarket: {},
  };
  let picks: PickWithOutcome[];
  try {
    picks = await prisma.agentPick.findMany({
      where: { createdAt: { gte: PAPER_TRIAL_START } },
      include: { outcome: true },
      orderBy: { gameDate: "asc" },
    });
  } catch (err) {
    console.error("loadOverallRecord failed:", err);
    return { games: empty, props: empty };
  }
  return {
    games: summarizeRecord(picks.filter(p => p.market !== "prop")),
    props: summarizeRecord(picks.filter(p => p.market === "prop")),
  };
}

function summarizeRecord(picks: PickWithOutcome[]): OverallRecord {
  const empty: OverallRecord = {
    startDate: PAPER_TRIAL_START.toISOString(),
    totalPicks: 0,
    graded: 0, pending: 0,
    wins: 0, losses: 0, pushes: 0,
    pnl: 0, totalStake: 0,
    roi: null, winRate: null,
    currentStreak: { kind: "—", length: 0 },
    longestWinStreak: 0,
    longestLossStreak: 0,
    best: null, worst: null,
    byLeague: {},
    byMarket: {},
  };
  if (picks.length === 0) return empty;

  const byLeague: OverallRecord["byLeague"] = {};
  const byMarket: OverallRecord["byMarket"] = {};
  let wins = 0, losses = 0, pushes = 0, pending = 0;
  let pnl = 0, totalStake = 0;
  let best: OverallRecord["best"] = null;
  let worst: OverallRecord["worst"] = null;
  let curWinStreak = 0, curLossStreak = 0;
  let longestWinStreak = 0, longestLossStreak = 0;
  let lastGradedKind: "W" | "L" | "P" | "—" = "—";

  for (const p of picks) {
    const lg = (byLeague[p.league] ??= {
      wins: 0, losses: 0, pushes: 0, pending: 0,
      pnl: 0, totalStake: 0, roi: null,
    });
    const mk = (byMarket[p.market] ??= {
      wins: 0, losses: 0, pushes: 0, pending: 0,
      pnl: 0, totalStake: 0, roi: null,
    });
    totalStake += p.kellyStakeUnits;
    lg.totalStake += p.kellyStakeUnits;
    mk.totalStake += p.kellyStakeUnits;

    if (!p.outcome) {
      pending++; lg.pending++; mk.pending++;
      continue;
    }
    const units = p.outcome.unitsPnl ?? 0;
    pnl += units; lg.pnl += units; mk.pnl += units;

    if (p.outcome.result === "win") {
      wins++; lg.wins++; mk.wins++;
      curWinStreak++; curLossStreak = 0;
      longestWinStreak = Math.max(longestWinStreak, curWinStreak);
      lastGradedKind = "W";
      if (!best || units > best.unitsPnl) {
        best = { id: p.id, matchup: p.matchup, selection: p.selection, league: p.league, unitsPnl: +units.toFixed(4) };
      }
    } else if (p.outcome.result === "loss") {
      losses++; lg.losses++; mk.losses++;
      curLossStreak++; curWinStreak = 0;
      longestLossStreak = Math.max(longestLossStreak, curLossStreak);
      lastGradedKind = "L";
      if (!worst || units < worst.unitsPnl) {
        worst = { id: p.id, matchup: p.matchup, selection: p.selection, league: p.league, unitsPnl: +units.toFixed(4) };
      }
    } else if (p.outcome.result === "push") {
      pushes++; lg.pushes++; mk.pushes++;
      curWinStreak = 0; curLossStreak = 0;
      lastGradedKind = "P";
    }
  }

  for (const lg of Object.values(byLeague)) {
    lg.roi = lg.totalStake > 0 ? +(lg.pnl / lg.totalStake).toFixed(4) : null;
    lg.pnl = +lg.pnl.toFixed(4);
    lg.totalStake = +lg.totalStake.toFixed(4);
  }
  for (const mk of Object.values(byMarket)) {
    mk.roi = mk.totalStake > 0 ? +(mk.pnl / mk.totalStake).toFixed(4) : null;
    mk.pnl = +mk.pnl.toFixed(4);
    mk.totalStake = +mk.totalStake.toFixed(4);
  }

  const graded = wins + losses + pushes;
  const currentStreakLen =
    lastGradedKind === "W" ? curWinStreak
    : lastGradedKind === "L" ? curLossStreak
    : lastGradedKind === "P" ? 1
    : 0;

  return {
    startDate: PAPER_TRIAL_START.toISOString(),
    totalPicks: picks.length,
    graded, pending,
    wins, losses, pushes,
    pnl: +pnl.toFixed(4),
    totalStake: +totalStake.toFixed(4),
    roi: totalStake > 0 ? +(pnl / totalStake).toFixed(4) : null,
    winRate: wins + losses > 0 ? +(wins / (wins + losses)).toFixed(4) : null,
    currentStreak: { kind: lastGradedKind, length: currentStreakLen },
    longestWinStreak,
    longestLossStreak,
    best, worst,
    byLeague,
    byMarket,
  };
}

// ─── orchestrator ──────────────────────────────────────────────────────────

export async function getDashboardData(): Promise<DashboardData> {
  const allGames = attachModel([
    ...loadOdds("NBA"),
    ...loadOdds("MLB"),
    ...loadOdds("WNBA"),
    ...loadOdds("NHL"),
  ]);
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
  // Only ML/spread/total picks attach to slate game cards (props live in
  // their own section, not pinned to a game card).
  const picksByGame = new Map<string, SlatePick>();
  for (const p of picks.games) {
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

  const [trackRecord7, trackRecord30, lastAgentRunAt, paperTrial, pipelineStatus, agentMemory, killStats, lastNight, overallRecord] = await Promise.all([
    loadTrackRecord(7),
    loadTrackRecord(30),
    loadLastAgentRunAt(),
    loadPaperTrial(),
    loadPipelineStatus(),
    loadAgentMemory(),
    loadKillStats(),
    loadLastNightLedger(),
    loadOverallRecord(),
  ]);

  const injuryWire = loadInjuryWire();
  const marketPicks = loadMarketPicks();
  const playerProps = loadPlayerProps();
  const homeRunLikes = getHomeRunLikes();
  const mlbPropPlays = loadMlbPropPlays();
  const parlayRetro = loadParlayRetro();
  const nflExp5 = loadNflExp5();

  const allTodayPicks = [...picks.games, ...picks.props];
  const todayPnl = allTodayPicks.reduce((s, p) => s + (p.outcome?.unitsPnl ?? 0), 0);

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
    homeRunLikes,
    mlbPropPlays,
    parlayRetro,
    nflExp5,
    trackRecord7,
    trackRecord30,
    paperTrial,
    pipelineStatus,
    killStats,
    agentMemory,
    lastNight,
    overallRecord,
    injuryWire,
    status: {
      lastAgentRunAt,
      nextScheduledRunUtc: next.toISOString(),
      todayPickCount: allTodayPicks.length,
      todaySlateCount: slate.length,
      todayPnl: +todayPnl.toFixed(2),
    },
  };
}
