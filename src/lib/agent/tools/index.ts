// Tool wrappers exposed to the Claude analyst.
// Each tool reads from data/processed snapshots produced by ingest scripts.

import fs from "node:fs";
import path from "node:path";
import { project as projectProp, type ProjectionInput } from "@/lib/prop-projector";

const PROCESSED = path.resolve(process.cwd(), "data", "processed");

// Staleness threshold for data files. Beyond this, the loader marks the file
// as "stale" — the tool will pass that signal back to the analyst so it can
// see in-band that its odds/model/injury data is old, and the orchestrator
// can decide whether to ingest before delegating. 6h covers a typical
// GH Actions ingest cadence (every 8h) plus headroom.
const STALE_AGE_MS = 6 * 60 * 60 * 1000;

export type DataStatus = "ok" | "stale" | "missing" | "malformed";

export type LoadResult<T> = {
  data: T;
  status: DataStatus;
  // Last-modified time of the file. Null if the file is missing.
  mtimeMs: number | null;
  // Age in milliseconds, computed at load time. Null if missing.
  ageMs: number | null;
};

// In-process de-dupe set so each (file, status) emission is logged once per
// process. Without this, every tool call on a stale/missing file would
// re-spam Discord.
const _emittedWarnings = new Set<string>();

function loadJsonWithStatus<T>(file: string, fallback: T): LoadResult<T> {
  const fullPath = path.join(PROCESSED, file);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(fullPath);
  } catch {
    emitWarning(file, "missing", null);
    return { data: fallback, status: "missing", mtimeMs: null, ageMs: null };
  }

  const ageMs = Date.now() - stat.mtimeMs;
  let raw: string;
  try {
    raw = fs.readFileSync(fullPath, "utf8");
  } catch {
    emitWarning(file, "missing", null);
    return { data: fallback, status: "missing", mtimeMs: stat.mtimeMs, ageMs };
  }

  let parsed: T;
  try {
    parsed = JSON.parse(raw) as T;
  } catch (err) {
    console.error(`loadJsonWithStatus: malformed JSON in ${file}:`, err);
    emitWarning(file, "malformed", ageMs);
    return { data: fallback, status: "malformed", mtimeMs: stat.mtimeMs, ageMs };
  }

  if (ageMs > STALE_AGE_MS) {
    emitWarning(file, "stale", ageMs);
    return { data: parsed, status: "stale", mtimeMs: stat.mtimeMs, ageMs };
  }
  return { data: parsed, status: "ok", mtimeMs: stat.mtimeMs, ageMs };
}

function emitWarning(file: string, status: DataStatus, ageMs: number | null): void {
  const key = `${file}:${status}`;
  if (_emittedWarnings.has(key)) return;
  _emittedWarnings.add(key);
  const ageStr = ageMs !== null ? `${(ageMs / 3_600_000).toFixed(1)}h old` : "no mtime";
  console.warn(`[tools/loadJson] ${status.toUpperCase()}: ${file} (${ageStr})`);
}

// Format a LoadResult's status into a string the analyst can read in the
// tool response payload. Returns null when the file is fresh — keeps the
// tool output unchanged in the common path.
function dataWarning(file: string, status: DataStatus, ageMs: number | null): string | null {
  if (status === "ok") return null;
  const ageHrs = ageMs !== null ? (ageMs / 3_600_000).toFixed(1) : "unknown";
  if (status === "stale") {
    return `DATA WARNING: ${file} is ${ageHrs}h old (stale > ${STALE_AGE_MS / 3_600_000}h). Numbers may not reflect the current slate — treat with caution and prefer skipping rather than picking on stale data.`;
  }
  if (status === "missing") {
    return `DATA ERROR: ${file} is missing. This tool returned empty/fallback data. You cannot reliably pick from missing data — pass on any pick that depends on this file.`;
  }
  return `DATA ERROR: ${file} is malformed JSON (age ${ageHrs}h). Treat as missing — pass on picks that depend on it.`;
}

// ─── Types we expose to the agent ──────────────────────────────────────────

export type AgentLeague = "NBA" | "MLB" | "WNBA" | "NHL" | "NCAAB";

// Leagues the pipeline is allowed to generate picks for. Tightened to NBA+MLB
// after the 2026-05 paper trial showed WNBA/NHL picks were leaking through
// scope-creep, contaminating the funding metrics, and bypassing the prop
// autograder (NBA/MLB only). Other leagues remain in the AgentLeague type so
// the autograder + dashboard can still surface legacy picks.
export const IN_SCOPE_LEAGUES = ["NBA", "MLB"] as const;
export type InScopeLeague = (typeof IN_SCOPE_LEAGUES)[number];

export function isInScope(league: string): league is InScopeLeague {
  return (IN_SCOPE_LEAGUES as readonly string[]).includes(league);
}

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

export function getOdds(
  league: AgentLeague
): { fetchedAt: string | null; events: GameOdds[]; dataWarning?: string } {
  const file = ODDS_FILE[league];
  const loaded = loadJsonWithStatus<RawOddsFile>(file, { events: [] });
  const data = loaded.data;
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

  const warn = dataWarning(file, loaded.status, loaded.ageMs);
  return {
    fetchedAt: data.fetchedAt ?? null,
    events,
    ...(warn ? { dataWarning: warn } : {}),
  };
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
  dataWarning?: string;
} {
  const file = MODEL_FILE[league];
  if (!file) return { generatedAt: null, games: [] };

  // NBA, WNBA, and NHL all share the same envelope shape — outer
  // { generatedAt, data: { results } } — built by basketball-model.ts and
  // hockey-model.ts respectively. The agent reads them through the same path.
  if (league === "NBA" || league === "WNBA" || league === "NHL") {
    const loaded = loadJsonWithStatus<NbaModelFile>(file, {});
    const warn = dataWarning(file, loaded.status, loaded.ageMs);
    return {
      generatedAt: loaded.data.generatedAt ?? null,
      games: loaded.data.data?.results ?? [],
      ...(warn ? { dataWarning: warn } : {}),
    };
  }

  if (league === "MLB") {
    const loaded = loadJsonWithStatus<MlbModelFile>(file, {});
    const warn = dataWarning(file, loaded.status, loaded.ageMs);
    return {
      generatedAt: loaded.data.generatedAt ?? null,
      games: loaded.data.results ?? [],
      ...(warn ? { dataWarning: warn } : {}),
    };
  }

  return { generatedAt: null, games: [] };
}

// ─── Tool: get_injuries ────────────────────────────────────────────────────

type InjuryFile = { fetchedAt?: string; players?: Injury[] };

export function getInjuries(
  league: AgentLeague
): { fetchedAt: string | null; players: Injury[]; dataWarning?: string } {
  // We have nba/nfl/nhl injury snapshots; MLB / WNBA / NCAAB injuries surface
  // inside latest-summary for now. Return empty-list gracefully when absent.
  const file =
    league === "NBA" ? "injuries-nba.json"
    : league === "NHL" ? "injuries-nhl.json"
    : null;
  if (!file) return { fetchedAt: null, players: [] };
  const loaded = loadJsonWithStatus<InjuryFile>(file, {});
  const warn = dataWarning(file, loaded.status, loaded.ageMs);
  return {
    fetchedAt: loaded.data.fetchedAt ?? null,
    players: loaded.data.players ?? [],
    ...(warn ? { dataWarning: warn } : {}),
  };
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
  dataWarning?: string;
} {
  if (league !== "NBA") return { generatedAt: null, available: false, topProps: [] };
  const file = "latest-player-props.json";
  const loaded = loadJsonWithStatus<PropsFile>(file, {});
  const warn = dataWarning(file, loaded.status, loaded.ageMs);
  return {
    generatedAt: loaded.data.generatedAt ?? null,
    available: loaded.data.available ?? false,
    topProps: loaded.data.topProps ?? [],
    ...(warn ? { dataWarning: warn } : {}),
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

export function getMlbSignals(): MlbSignals & { dataWarning?: string } {
  const file = "mlb-advanced-signals.json";
  const loaded = loadJsonWithStatus<MlbSignals>(file, {});
  const warn = dataWarning(file, loaded.status, loaded.ageMs);
  return {
    ...loaded.data,
    ...(warn ? { dataWarning: warn } : {}),
  };
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

export function getTrendSummary(
  league: AgentLeague
): (SummaryLeague & { dataWarning?: string }) | { dataWarning: string } | null {
  const file = "latest-summary.json";
  const loaded = loadJsonWithStatus<SummaryFile>(file, {});
  const warn = dataWarning(file, loaded.status, loaded.ageMs);
  const found = (loaded.data.leagues ?? []).find(l => l.league.toUpperCase() === league) ?? null;
  if (!found) {
    return warn ? { dataWarning: warn } : null;
  }
  return warn ? { ...found, dataWarning: warn } : found;
}

// ─── Tool: get_prop_projection ─────────────────────────────────────────────
// Deterministic projection for a player prop. Required source of modelProb
// for any prop pick the analyst returns — Claude must NOT invent
// modelProbs for props from reasoning alone (LLMs are unreliable on
// stat-level prop math; see OpticOdds + Anthropic research).

export type PropProjectionInput = {
  league: "NBA" | "MLB";
  player: string;
  propType: string;
  line: number;
  side: "over" | "under";
  opponent?: string | null;
};

export function getPropProjection(input: PropProjectionInput) {
  if (input.league !== "NBA" && input.league !== "MLB") {
    return { available: false, reason: "prop projection only supported for NBA + MLB" };
  }
  const proj = projectProp(input satisfies ProjectionInput);
  if (!proj) {
    return {
      available: false,
      reason:
        "no projection available — player not found in last 10–14 day game log, or insufficient games (need ≥5). Skip this prop.",
    };
  }
  return {
    available: true,
    ...proj,
  };
}

// ─── Tool dispatch table ───────────────────────────────────────────────────

export type ToolName =
  | "get_odds"
  | "get_model_probabilities"
  | "get_injuries"
  | "get_player_props"
  | "get_trend_summary"
  | "get_mlb_signals"
  | "get_prop_projection"
  | "get_dream_memory"
  | "get_team_recent_records";

// Per-run dependencies the analyst passes in via buildToolHandlers(). Lets us
// inject DB-backed snapshots (active memory rules, latest dream notes, per-team
// recent results) without making the tool handlers themselves async, which
// would force a bigger refactor of the analyst's tool-use loop.
export type ToolDeps = {
  activeMemories: Array<{
    id: number;
    type: string;
    scope: string;
    rule: string;
    reasoning: string;
    weight: number;
  }>;
  latestDream: {
    startedAt: string;
    picksReviewed: number;
    memoriesAdded: number;
    memoriesRetired: number;
    notes: string | null;
  } | null;
  teamRecords: Array<{
    team: string;
    picks: Array<{
      pickId: number;
      selection: string;
      oddsAmerican: number;
      edge: number;
      gameDate: string;
      result: string;
    }>;
  }>;
};

export function buildToolHandlers(
  deps: ToolDeps
): Record<ToolName, (input: unknown) => unknown> {
  return {
    get_odds: input => getOdds((input as { league: AgentLeague }).league),
    get_model_probabilities: input =>
      getModelProbabilities((input as { league: AgentLeague }).league),
    get_injuries: input => getInjuries((input as { league: AgentLeague }).league),
    get_player_props: input => getPlayerProps((input as { league: AgentLeague }).league),
    get_trend_summary: input => getTrendSummary((input as { league: AgentLeague }).league),
    get_mlb_signals: () => getMlbSignals(),
    get_prop_projection: input => getPropProjection(input as PropProjectionInput),
    get_dream_memory: () => ({
      // Return EVERYTHING the analyst needs from dream in one payload. The
      // analyst is required to call this tool first thing every run (enforced
      // in the system prompt + reasoning trace audit by the critic).
      activeRules: deps.activeMemories,
      latestDreamRun: deps.latestDream,
      note: deps.activeMemories.length === 0
        ? "No active rules yet — dream has not consolidated enough graded picks."
        : `Rules with weight ≥ 0.5 are HARD GUARDRAILS. If a pick matches a hard rule, either drop the pick OR cite the rule id in your thesis and give a SPECIFIC, evidence-backed reason why today's data overrides it.`,
    }),
    get_team_recent_records: () => ({
      teams: deps.teamRecords,
      note:
        deps.teamRecords.length === 0
          ? "No team has ≥2 graded picks in the last 14d."
          : "Teams listed here have ≥2 graded picks recently. Use this to avoid re-picking teams that are cold. If you must re-pick, explain in the thesis what's specifically different.",
    }),
  };
}

// Legacy export kept for callers that don't have dep injection wired (e.g.
// older smoke scripts). Returns handlers with empty memory state — the new
// tools will respond accurately ("no rules / no team records yet") rather
// than throw, but the analyst won't see real memory through this path.
export const TOOL_HANDLERS = buildToolHandlers({
  activeMemories: [],
  latestDream: null,
  teamRecords: [],
});

// Anthropic tool definitions (JSON Schema format)
export const TOOL_DEFINITIONS = [
  {
    name: "get_odds",
    description:
      "Get today's consensus odds for all games in a league. Returns moneyline, spread, and total medians across major US books, with implied probabilities.",
    input_schema: {
      type: "object" as const,
      properties: { league: { type: "string", enum: ["NBA", "MLB"] } },
      required: ["league"],
    },
  },
  {
    name: "get_model_probabilities",
    description:
      "Get the in-house model's win probabilities for today's games. NBA model includes expected margin and net ratings; MLB model is calibrated and pitcher-aware.",
    input_schema: {
      type: "object" as const,
      properties: { league: { type: "string", enum: ["NBA", "MLB"] } },
      required: ["league"],
    },
  },
  {
    name: "get_injuries",
    description:
      "Get current injury list for a league. Returns player, team, status, injury type, and expected return date when available.",
    input_schema: {
      type: "object" as const,
      properties: { league: { type: "string", enum: ["NBA", "MLB"] } },
      required: ["league"],
    },
  },
  {
    name: "get_player_props",
    description:
      "Get the top-ranked player props for the league with consensus lines and the model's pick side and confidence. Currently NBA only.",
    input_schema: {
      type: "object" as const,
      properties: { league: { type: "string", enum: ["NBA", "MLB"] } },
      required: ["league"],
    },
  },
  {
    name: "get_trend_summary",
    description:
      "Get a high-level trend summary for the league, including trend score, recent averages, and best-bet rankings.",
    input_schema: {
      type: "object" as const,
      properties: { league: { type: "string", enum: ["NBA", "MLB"] } },
      required: ["league"],
    },
  },
  {
    name: "get_mlb_signals",
    description:
      "MLB-only advanced metrics from FanGraphs. Returns: regressionCandidates (batters with xwOBA - wOBA >= 0.020 = BABIP-suppressed, hits/total-bases overs are undervalued), velocityGainers (pitchers with rising FB velocity = strikeouts overs are undervalued), closerChanges (recent role shifts saves market may not have priced). Use to find props the market hasn't caught up with.",
    input_schema: {
      type: "object" as const,
      properties: { league: { type: "string", enum: ["NBA", "MLB"] } },
      required: [],
    },
  },
  {
    name: "get_prop_projection",
    description:
      "REQUIRED source of modelProb for any prop pick you ship. Computes a deterministic projection from the player's last 10-14 games + opponent allowance. Returns: projected (adjusted mean), stddev, modelProb (probability of the chosen side hitting), nGames, rollingMean, opponentFactor (1.0 = neutral, <1 = tough matchup, >1 = soft), recentForm (last 5 values), notes. Returns { available: false } when the player has < 5 games in the window — in that case you MUST skip the prop, never invent a modelProb. Currently NBA + MLB only. propType uses the keys from get_player_props (player_points, player_rebounds, batter_hits, etc.). Opponent must be the full team displayName (e.g. 'Minnesota Timberwolves'), not abbreviations.",
    input_schema: {
      type: "object" as const,
      properties: {
        league: { type: "string", enum: ["NBA", "MLB"] },
        player: { type: "string", description: "Full player display name" },
        propType: { type: "string", description: "Prop key (player_points, player_rebounds, batter_hits, etc.)" },
        line: { type: "number" },
        side: { type: "string", enum: ["over", "under"] },
        opponent: { type: "string", description: "Opponent team displayName, used for matchup adjustment" },
      },
      required: ["league", "player", "propType", "line", "side"],
    },
  },
  {
    name: "get_dream_memory",
    description:
      "REQUIRED FIRST STEP of every analyst run. Returns the active AgentMemory rules (consolidated weekly by the dream agent) and the latest dream-run notes. Rules with weight ≥ 0.5 are HARD GUARDRAILS — if a pick matches a hard rule, either drop the pick or justify the override in your thesis by referencing the rule id and citing specific evidence for why today is the exception. The critic gets the same rule list and will kill picks that violate a hard rule without justification.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_team_recent_records",
    description:
      "Returns recent moneyline pick results grouped by team (last 14 days). Use this to avoid re-picking teams the agent is cold on. Surfaces only teams with ≥2 graded picks in the window so singletons don't create noise. If you decide to re-pick a team that's 0-2, your thesis MUST explain what's specifically different today (lineup, matchup, pitcher, etc.) — the critic checks this.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];
