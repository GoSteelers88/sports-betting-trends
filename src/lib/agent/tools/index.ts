// Tool wrappers exposed to the Claude analyst.
// Each tool reads from data/processed snapshots produced by ingest scripts.

import fs from "node:fs";
import path from "node:path";

const PROCESSED = path.resolve(process.cwd(), "data", "processed");

function loadJson<T>(file: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(path.join(PROCESSED, file), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ─── Types we expose to the agent ──────────────────────────────────────────

export type AgentLeague = "NBA" | "MLB" | "WNBA" | "NHL" | "NCAAB";

export type GameOdds = {
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
  // Best available price for each side across ALL books in the feed. If the
  // bestPrice is materially better than consensus, that book is "off-market"
  // and represents a real edge — placement should target that book.
  bestPrice: {
    home: { book: string; american: number; impliedProb: number } | null;
    away: { book: string; american: number; impliedProb: number } | null;
  };
  // Spread of book prices (max - min in cents). High spread means books
  // disagree, which itself is an edge signal.
  bookSpread: { home: number | null; away: number | null };
  bookCount: number;
};

export type ModelView = {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  homeWinProb: number;
  awayWinProb: number;
  expectedMargin?: number | null;
  notes?: string[];
};

export type Injury = {
  player: string;
  team: string;
  position?: string;
  status: string;
  injuryType?: string;
  returnDate?: string;
};

// ─── Helpers ───────────────────────────────────────────────────────────────

function americanToImplied(price: number): number {
  if (price > 0) return 100 / (price + 100);
  return -price / (-price + 100);
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

const ODDS_FILE: Record<AgentLeague, string> = {
  NBA: "latest-odds-api-basketball_nba.json",
  MLB: "latest-odds-api-baseball_mlb.json",
  WNBA: "latest-odds-api-basketball_wnba.json",
  NHL: "latest-odds-api-icehockey_nhl.json",
  NCAAB: "latest-odds-api-basketball_ncaab.json",
};

const MODEL_FILE: Record<AgentLeague, string | null> = {
  NBA: "nba-model.json",
  MLB: "mlb-model-output.json",
  WNBA: "wnba-model.json",
  NHL: "nhl-model.json",
  NCAAB: null,
};

// ─── Tool: get_odds ────────────────────────────────────────────────────────

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
type RawOddsFile = { events?: RawOddsEvent[]; fetchedAt?: string };

export function getOdds(league: AgentLeague): { fetchedAt: string | null; events: GameOdds[] } {
  const data = loadJson<RawOddsFile>(ODDS_FILE[league], { events: [] });
  const events = (data.events ?? []).map((ev): GameOdds => {
    const homePrices: number[] = [];
    const awayPrices: number[] = [];
    // Track per-book prices for off-market detection
    const homeByBook: Array<{ book: string; price: number }> = [];
    const awayByBook: Array<{ book: string; price: number }> = [];
    const spreads: { line: number; homePrice: number; awayPrice: number }[] = [];
    const totals: { line: number; overPrice: number; underPrice: number }[] = [];

    for (const book of ev.bookmakers ?? []) {
      for (const market of book.markets ?? []) {
        if (market.key === "h2h") {
          for (const o of market.outcomes ?? []) {
            if (o.name === ev.home_team) {
              homePrices.push(o.price);
              homeByBook.push({ book: book.key, price: o.price });
            }
            if (o.name === ev.away_team) {
              awayPrices.push(o.price);
              awayByBook.push({ book: book.key, price: o.price });
            }
          }
        } else if (market.key === "spreads") {
          const home = market.outcomes.find(o => o.name === ev.home_team);
          const away = market.outcomes.find(o => o.name === ev.away_team);
          if (home && away && typeof home.point === "number") {
            spreads.push({ line: home.point, homePrice: home.price, awayPrice: away.price });
          }
        } else if (market.key === "totals") {
          const over = market.outcomes.find(o => o.name?.toLowerCase() === "over");
          const under = market.outcomes.find(o => o.name?.toLowerCase() === "under");
          if (over && under && typeof over.point === "number") {
            totals.push({ line: over.point, overPrice: over.price, underPrice: under.price });
          }
        }
      }
    }

    const consensusHome = homePrices.length
      ? { american: Math.round(median(homePrices)), impliedProb: americanToImplied(median(homePrices)) }
      : null;
    const consensusAway = awayPrices.length
      ? { american: Math.round(median(awayPrices)), impliedProb: americanToImplied(median(awayPrices)) }
      : null;

    const consensusSpread = spreads.length
      ? {
          line: median(spreads.map(s => s.line)),
          homePrice: Math.round(median(spreads.map(s => s.homePrice))),
          awayPrice: Math.round(median(spreads.map(s => s.awayPrice))),
        }
      : null;

    const consensusTotal = totals.length
      ? {
          line: median(totals.map(t => t.line)),
          overPrice: Math.round(median(totals.map(t => t.overPrice))),
          underPrice: Math.round(median(totals.map(t => t.underPrice))),
        }
      : null;

    // Best price = highest payout (for + odds, the bigger number; for - odds,
    // the closer to 0). American odds: the higher numeric value is always the
    // better payout for the bettor on that side.
    const bestHome =
      homeByBook.length > 0
        ? homeByBook.reduce((best, cur) => (cur.price > best.price ? cur : best))
        : null;
    const bestAway =
      awayByBook.length > 0
        ? awayByBook.reduce((best, cur) => (cur.price > best.price ? cur : best))
        : null;

    const homeSpreadCents =
      homeByBook.length > 0
        ? Math.max(...homeByBook.map(b => b.price)) - Math.min(...homeByBook.map(b => b.price))
        : null;
    const awaySpreadCents =
      awayByBook.length > 0
        ? Math.max(...awayByBook.map(b => b.price)) - Math.min(...awayByBook.map(b => b.price))
        : null;

    return {
      eventId: ev.id,
      commenceTime: ev.commence_time,
      homeTeam: ev.home_team,
      awayTeam: ev.away_team,
      consensus: {
        home: consensusHome,
        away: consensusAway,
        spread: consensusSpread,
        total: consensusTotal,
      },
      bestPrice: {
        home: bestHome
          ? { book: bestHome.book, american: bestHome.price, impliedProb: americanToImplied(bestHome.price) }
          : null,
        away: bestAway
          ? { book: bestAway.book, american: bestAway.price, impliedProb: americanToImplied(bestAway.price) }
          : null,
      },
      bookSpread: { home: homeSpreadCents, away: awaySpreadCents },
      bookCount: (ev.bookmakers ?? []).length,
    };
  });

  return { fetchedAt: data.fetchedAt ?? null, events };
}

// ─── Tool: get_model_probabilities ─────────────────────────────────────────

type NbaModelFile = {
  generatedAt?: string;
  data?: { results?: ModelView[] };
};
type MlbModelFile = {
  generatedAt?: string;
  results?: ModelView[];
};

export function getModelProbabilities(league: AgentLeague): {
  generatedAt: string | null;
  games: ModelView[];
} {
  const file = MODEL_FILE[league];
  if (!file) return { generatedAt: null, games: [] };

  // NBA, WNBA, and NHL all share the same envelope shape — outer
  // { generatedAt, data: { results } } — built by basketball-model.ts and
  // hockey-model.ts respectively. The agent reads them through the same path.
  if (league === "NBA" || league === "WNBA" || league === "NHL") {
    const data = loadJson<NbaModelFile>(file, {});
    return {
      generatedAt: data.generatedAt ?? null,
      games: data.data?.results ?? [],
    };
  }

  if (league === "MLB") {
    const data = loadJson<MlbModelFile>(file, {});
    return {
      generatedAt: data.generatedAt ?? null,
      games: data.results ?? [],
    };
  }

  return { generatedAt: null, games: [] };
}

// ─── Tool: get_injuries ────────────────────────────────────────────────────

type InjuryFile = { fetchedAt?: string; players?: Injury[] };

export function getInjuries(league: AgentLeague): { fetchedAt: string | null; players: Injury[] } {
  // We have nba/nfl/nhl injury snapshots; MLB / WNBA / NCAAB injuries surface
  // inside latest-summary for now. Return empty-list gracefully when absent.
  const file =
    league === "NBA" ? "injuries-nba.json"
    : league === "NHL" ? "injuries-nhl.json"
    : null;
  if (!file) return { fetchedAt: null, players: [] };
  const data = loadJson<InjuryFile>(file, {});
  return { fetchedAt: data.fetchedAt ?? null, players: data.players ?? [] };
}

// ─── Tool: get_player_props (NBA only currently) ───────────────────────────

type PropEntry = {
  player: string;
  team: string | null;
  opponent: string | null;
  market: string;
  marketLabel?: string;
  line: number;
  overPrice: number | null;
  underPrice: number | null;
  pickSide: "over" | "under";
  confidence: number;
  rationaleSignals: string[];
};
type PropsFile = {
  generatedAt?: string;
  sport?: string;
  available?: boolean;
  topProps?: PropEntry[];
  props?: PropEntry[];
};

export function getPlayerProps(league: AgentLeague): {
  generatedAt: string | null;
  available: boolean;
  topProps: PropEntry[];
} {
  if (league !== "NBA") return { generatedAt: null, available: false, topProps: [] };
  const data = loadJson<PropsFile>("latest-player-props.json", {});
  return {
    generatedAt: data.generatedAt ?? null,
    available: data.available ?? false,
    topProps: data.topProps ?? [],
  };
}

// ─── Tool: get_mlb_signals ─────────────────────────────────────────────────

type MlbSignals = {
  generatedAt?: string;
  regressionCandidates?: Array<{
    player: string;
    team: string | null;
    pa: number | null;
    woba: number | null;
    xwoba: number | null;
    xwobaGap: number | null;
  }>;
  velocityGainers?: Array<{
    player: string;
    team: string | null;
    ip: number | null;
    fbVelocity: number | null;
    velocityDelta: number | null;
    k9: number | null;
  }>;
  closerChanges?: Array<{ team: string; newCloser: string; effectiveDate: string }>;
};

export function getMlbSignals(): MlbSignals {
  return loadJson<MlbSignals>("mlb-advanced-signals.json", {});
}

// ─── Tool: get_trend_summary ───────────────────────────────────────────────

type SummaryLeague = {
  league: string;
  trendScore?: number;
  trendSignal?: string;
  confidence?: number;
  recentAvgPoints?: number | null;
  advanced?: Record<string, unknown>;
  bestBets?: unknown[];
};
type SummaryFile = { generatedAt?: string; leagues?: SummaryLeague[] };

export function getTrendSummary(league: AgentLeague): SummaryLeague | null {
  const data = loadJson<SummaryFile>("latest-summary.json", {});
  return (data.leagues ?? []).find(l => l.league.toUpperCase() === league) ?? null;
}

// ─── Tool dispatch table ───────────────────────────────────────────────────

export type ToolName =
  | "get_odds"
  | "get_model_probabilities"
  | "get_injuries"
  | "get_player_props"
  | "get_trend_summary"
  | "get_mlb_signals";

export const TOOL_HANDLERS: Record<ToolName, (input: { league: AgentLeague }) => unknown> = {
  get_odds: ({ league }) => getOdds(league),
  get_model_probabilities: ({ league }) => getModelProbabilities(league),
  get_injuries: ({ league }) => getInjuries(league),
  get_player_props: ({ league }) => getPlayerProps(league),
  get_trend_summary: ({ league }) => getTrendSummary(league),
  get_mlb_signals: () => getMlbSignals(),
};

// Anthropic tool definitions (JSON Schema format)
export const TOOL_DEFINITIONS = [
  {
    name: "get_odds",
    description:
      "Get today's consensus odds for all games in a league. Returns moneyline, spread, and total medians across major US books, with implied probabilities.",
    input_schema: {
      type: "object" as const,
      properties: { league: { type: "string", enum: ["NBA", "MLB", "WNBA", "NHL", "NCAAB"] } },
      required: ["league"],
    },
  },
  {
    name: "get_model_probabilities",
    description:
      "Get the in-house model's win probabilities for today's games. NBA model includes expected margin and net ratings; MLB model is calibrated and pitcher-aware.",
    input_schema: {
      type: "object" as const,
      properties: { league: { type: "string", enum: ["NBA", "MLB", "WNBA", "NHL", "NCAAB"] } },
      required: ["league"],
    },
  },
  {
    name: "get_injuries",
    description:
      "Get current injury list for a league. Returns player, team, status, injury type, and expected return date when available.",
    input_schema: {
      type: "object" as const,
      properties: { league: { type: "string", enum: ["NBA", "MLB", "WNBA", "NHL", "NCAAB"] } },
      required: ["league"],
    },
  },
  {
    name: "get_player_props",
    description:
      "Get the top-ranked player props for the league with consensus lines and the model's pick side and confidence. Currently NBA only.",
    input_schema: {
      type: "object" as const,
      properties: { league: { type: "string", enum: ["NBA", "MLB", "WNBA", "NHL", "NCAAB"] } },
      required: ["league"],
    },
  },
  {
    name: "get_trend_summary",
    description:
      "Get a high-level trend summary for the league, including trend score, recent averages, and best-bet rankings.",
    input_schema: {
      type: "object" as const,
      properties: { league: { type: "string", enum: ["NBA", "MLB", "WNBA", "NHL", "NCAAB"] } },
      required: ["league"],
    },
  },
  {
    name: "get_mlb_signals",
    description:
      "MLB-only advanced metrics from FanGraphs. Returns: regressionCandidates (batters with xwOBA - wOBA >= 0.020 = BABIP-suppressed, hits/total-bases overs are undervalued), velocityGainers (pitchers with rising FB velocity = strikeouts overs are undervalued), closerChanges (recent role shifts saves market may not have priced). Use to find props the market hasn't caught up with.",
    input_schema: {
      type: "object" as const,
      properties: { league: { type: "string", enum: ["NBA", "MLB", "WNBA", "NHL", "NCAAB"] } },
      required: [],
    },
  },
];
