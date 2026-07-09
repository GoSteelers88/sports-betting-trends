// Tool wrappers exposed to the Claude analyst.
// Each tool reads from data/processed snapshots produced by ingest scripts.

import fs from "node:fs";
import path from "node:path";
import { project as projectProp, type ProjectionInput } from "@/lib/prop-projector";
import { getHomeRunLikes, type HomeRunLike } from "@/lib/props-board";
import {
  slateTeamsFromEvents,
  scopeInjuriesToSlate,
  injuriesForTeams,
  statusTier,
  matchTeam,
  isMlbTeam,
  type ScopeInjury,
} from "@/lib/injuries-scope";

const PROCESSED = path.resolve(process.cwd(), "data", "processed");

// Staleness threshold for data files. Beyond this, the loader marks the file
// as "stale" — the tool will pass that signal back to the analyst so it can
// see in-band that its odds/model/injury data is old, and the orchestrator
// can decide whether to ingest before delegating. 6h covers a typical
// GH Actions ingest cadence (every 8h) plus headroom.
const STALE_AGE_MS = 6 * 60 * 60 * 1000;

// "unknown" = file present + parsed, but no readable in-file timestamp
// (bare-array file, absent field, or an unparseable value). Treated like stale
// in the warning below — NEVER silent-fresh (the NaN trap: NaN > STALE is false).
export type DataStatus = "ok" | "stale" | "missing" | "malformed" | "unknown";

export type LoadResult<T> = {
  data: T;
  status: DataStatus;
  // Last-modified time of the file. Null if the file is missing.
  mtimeMs: number | null;
  // Age in milliseconds, computed from the DATA'S OWN in-file timestamp (NOT
  // mtime). Null if missing, malformed, or the timestamp is unknown.
  ageMs: number | null;
};

// Compute the data's age from its OWN timestamp, never the filesystem mtime.
// Vercel's bundle resets mtime (→ everything reads "stale"); GH Actions checkout
// resets it to now (→ genuinely-old files read "fresh", the inverse bug). We read
// fetchedAt | generatedAt | updatedAt (Date.parse handles both "Z" and "+00:00").
// Unparseable/absent/non-envelope → { ageMs: null, unknown: true } (NOT fresh).
export function freshnessFromData(data: unknown): { ageMs: number | null; unknown: boolean } {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ageMs: null, unknown: true };
  }
  const rec = data as Record<string, unknown>;
  const raw = rec.fetchedAt ?? rec.generatedAt ?? rec.updatedAt;
  if (typeof raw !== "string") return { ageMs: null, unknown: true };
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return { ageMs: null, unknown: true };
  return { ageMs: Date.now() - parsed, unknown: false };
}

// In-process de-dupe set so each (file, status) emission is logged once per
// process. Without this, every tool call on a stale/missing file would
// re-spam Discord.
const _emittedWarnings = new Set<string>();

function loadJsonWithStatus<T>(file: string, fallback: T): LoadResult<T> {
  const fullPath = path.join(PROCESSED, file);
  // mtime is retained ONLY for the reported mtimeMs field — it is NOT used for
  // freshness (it's untrustworthy: reset by the Vercel bundle AND by GH Actions
  // checkout). Freshness comes from the data's own in-file timestamp below.
  let mtimeMs: number | null = null;
  try {
    mtimeMs = fs.statSync(fullPath).mtimeMs;
  } catch {
    // stat failing usually means missing; the read below is the real gate.
  }

  let raw: string;
  try {
    raw = fs.readFileSync(fullPath, "utf8");
  } catch {
    emitWarning(file, "missing", null);
    return { data: fallback, status: "missing", mtimeMs, ageMs: null };
  }

  // PARSE-FIRST: we must parse before we can read the timestamp. Malformed path
  // preserved exactly (→ malformed, no age).
  let parsed: T;
  try {
    parsed = JSON.parse(raw) as T;
  } catch (err) {
    console.error(`loadJsonWithStatus: malformed JSON in ${file}:`, err);
    emitWarning(file, "malformed", null);
    return { data: fallback, status: "malformed", mtimeMs, ageMs: null };
  }

  const { ageMs, unknown } = freshnessFromData(parsed);
  if (unknown) {
    // No readable timestamp → UNKNOWN freshness. Warn (never silent-fresh),
    // never fall back to mtime as a freshness proof.
    emitWarning(file, "unknown", null);
    return { data: parsed, status: "unknown", mtimeMs, ageMs: null };
  }
  if (ageMs !== null && ageMs > STALE_AGE_MS) {
    emitWarning(file, "stale", ageMs);
    return { data: parsed, status: "stale", mtimeMs, ageMs };
  }
  return { data: parsed, status: "ok", mtimeMs, ageMs };
}

function emitWarning(file: string, status: DataStatus, ageMs: number | null): void {
  const key = `${file}:${status}`;
  if (_emittedWarnings.has(key)) return;
  _emittedWarnings.add(key);
  const ageStr =
    ageMs !== null
      ? `${(ageMs / 3_600_000).toFixed(1)}h old`
      : status === "unknown"
        ? "no freshness metadata"
        : "no age";
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
  if (status === "unknown") {
    return `DATA WARNING: ${file} has no freshness metadata — treat its numbers as possibly old and prefer skipping over picking on data of unknown age.`;
  }
  if (status === "missing") {
    return `DATA ERROR: ${file} is missing. This tool returned empty/fallback data. You cannot reliably pick from missing data — pass on any pick that depends on this file.`;
  }
  return `DATA ERROR: ${file} is malformed JSON (age ${ageHrs}h). Treat as missing — pass on picks that depend on it.`;
}

// ─── Types we expose to the agent ──────────────────────────────────────────

export type AgentLeague = "NBA" | "MLB" | "WNBA" | "NHL" | "NCAAB";

// Leagues the pipeline is allowed to generate picks for. Tightened to NBA+MLB
// on 2026-05-20 after the paper trial showed WNBA/NHL leaking through
// scope-creep and contaminating the funding metrics. WNBA was RE-ADDED on
// 2026-06-30 (trial-integrated, by operator decision) once its grading path
// was confirmed wired: the autograder grades WNBA moneylines off the ESPN
// WNBA scoreboard, and prop-grading.ts carries the WNBA box-score endpoints.
// NHL/NCAAB remain out of scope (in AgentLeague only so legacy picks surface).
export const IN_SCOPE_LEAGUES = ["NBA", "MLB", "WNBA"] as const;
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

// ─── Tool: get_board_edges ──────────────────────────────────────────────────
// Joins tonight's odds with the in-house model and returns, PER GAME, the
// model-vs-market edge for the better side — sorted best-first. This exists so a
// SLATE-LEVEL question ("what's tonight's best play?") can be answered with
// GROUNDED data: the edge here is a real field (modelProb − best-price
// impliedProb), not a number the chatbot computed in its head. The grounding
// guard can verify edge/modelProb/impliedProb directly. Edge uses BEST price
// (the desk's "always best line" rule), so it's the true bettable edge.

export type BoardEdge = {
  eventId: string;
  matchup: string; // "Away @ Home"
  commenceTime: string;
  pick: string; // team name of the +edge side
  side: "home" | "away";
  modelProb: number; // 0–1 model win prob for the picked side
  impliedProb: number; // 0–1 best-price implied prob for the picked side
  edge: number; // modelProb − impliedProb (0–1 fraction)
  bestBook: string | null;
  bestPriceAmerican: number | null;
};

export function getBoardEdges(league: AgentLeague): {
  generatedAt: string | null;
  edges: BoardEdge[];
  note: string;
  dataWarning?: string;
} {
  const odds = getOdds(league);
  const model = getModelProbabilities(league);

  // MLB's odds feed carries NPB/KBO/CPBL/NCAA pollution — drop anything that
  // isn't a real MLB matchup before joining (mirrors the dashboard's slate
  // scope). Harmless for NBA (every team passes the no-op).
  const cleanEvents =
    league === "MLB"
      ? odds.events.filter((e) => isMlbTeam(e.homeTeam) && isMlbTeam(e.awayTeam))
      : odds.events;

  // Edges above this are almost certainly a DATA ARTIFACT (a single stale/garbage
  // book line that best-price picked up), not a real edge — an MLB/NBA moneyline
  // edge in the real world tops out well under this. We compute edge vs the
  // CONSENSUS (median across books), not best price, so one bad book can't mint a
  // fake edge; we still report best price as where to actually bet. Anything over
  // the ceiling is flagged suspicious and kept OUT of the playable set.
  const ARTIFACT_CEILING = 0.2;

  const edges: BoardEdge[] = [];
  let suspicious = 0;
  for (const m of model.games) {
    const ev = cleanEvents.find(
      (e) => matchTeam(e.homeTeam, m.homeTeam) && matchTeam(e.awayTeam, m.awayTeam)
    );
    if (!ev) continue;
    // Edge is computed vs CONSENSUS (robust). Fall back to best price only if no
    // consensus exists (thin market).
    const homeImplied = ev.consensus.home?.impliedProb ?? ev.bestPrice.home?.impliedProb ?? null;
    const awayImplied = ev.consensus.away?.impliedProb ?? ev.bestPrice.away?.impliedProb ?? null;
    if (homeImplied == null || awayImplied == null) continue;
    if (typeof m.homeWinProb !== "number" || typeof m.awayWinProb !== "number") continue;

    const homeEdge = m.homeWinProb - homeImplied;
    const awayEdge = m.awayWinProb - awayImplied;
    const side: "home" | "away" = homeEdge >= awayEdge ? "home" : "away";
    const modelProb = side === "home" ? m.homeWinProb : m.awayWinProb;
    const impliedProb = side === "home" ? homeImplied : awayImplied;
    const edge = modelProb - impliedProb;
    // Where to actually bet — best price for the side (for display only).
    const best = side === "home" ? ev.bestPrice.home : ev.bestPrice.away;

    if (edge > ARTIFACT_CEILING) {
      // Implausible — drop it from the survey rather than recommend a stale line.
      suspicious++;
      continue;
    }

    edges.push({
      eventId: ev.eventId,
      matchup: `${ev.awayTeam} @ ${ev.homeTeam}`,
      commenceTime: ev.commenceTime,
      pick: side === "home" ? ev.homeTeam : ev.awayTeam,
      side,
      modelProb: +modelProb.toFixed(4),
      impliedProb: +impliedProb.toFixed(4),
      edge: +edge.toFixed(4),
      bestBook: best?.book ?? null,
      bestPriceAmerican: best?.american ?? null,
    });
  }

  edges.sort((a, b) => b.edge - a.edge);
  const playable = edges.filter((e) => e.edge >= 0.06);
  const suspiciousNote =
    suspicious > 0
      ? ` (${suspicious} game(s) had implausible >20% edges — stale/outlier lines — dropped.)`
      : "";

  let note: string;
  if (edges.length === 0) {
    note =
      "No games could be joined between the odds feed and the model — data may be stale or non-overlapping. No read; don't force a play." +
      suspiciousNote;
  } else if (playable.length > 0) {
    note = `${playable.length} game(s) clear the 6% edge floor (best first). edge = modelProb − consensus impliedProb; these are grounded fields, cite them directly. Bet at the best price/book shown.${suspiciousNote}`;
  } else {
    note = `No game clears the 6% edge floor tonight. Highest is ${(edges[0].edge * 100).toFixed(1)}% on ${edges[0].pick} — still a pass. The honest answer is "nothing on the board clears my number." Don't manufacture a play.${suspiciousNote}`;
  }

  const warn = odds.dataWarning || model.dataWarning;
  return {
    generatedAt: model.generatedAt,
    edges,
    note,
    ...(warn ? { dataWarning: warn } : {}),
  };
}

// ─── Tool: get_injuries ────────────────────────────────────────────────────

type InjuryFile = { fetchedAt?: string; players?: Injury[] };

// Every in-scope league has an ESPN injury snapshot written by
// scripts/ingest-injuries.ts (NBA, WNBA, MLB, NHL). NCAAB has no feed
// (return empty gracefully).
export const INJURY_FILE: Record<AgentLeague, string | null> = {
  NBA: "injuries-nba.json",
  WNBA: "injuries-wnba.json",
  MLB: "injuries-mlb.json",
  NHL: "injuries-nhl.json",
  NCAAB: null,
};

export type GetInjuriesInput = {
  league: AgentLeague;
  // When the analyst is evaluating a specific matchup it passes the two team
  // names here (full Odds API display names from get_odds). The tool then
  // returns ONLY those teams' decision-relevant players (OUT/DOUBTFUL/IL/
  // QUESTIONABLE) — the injuries that actually move THIS game.
  teams?: string[];
  // Default true: restrict the player list to teams on today's slate (read
  // from the odds feed). Set false to get the entire league feed.
  scopeToSlate?: boolean;
};

export type GetInjuriesResult = {
  fetchedAt: string | null;
  // When `teams` is supplied: the decision-relevant players for that matchup.
  // Otherwise: the slate-scoped (or full, if scopeToSlate=false) player list.
  players: Injury[];
  // Teams the returned players belong to (helps the analyst confirm scope).
  teamsCovered: string[];
  // How the list was filtered, so the analyst knows what it's looking at.
  scope: "matchup" | "slate" | "full";
  // Compact "key absence" summary the analyst should weigh: OUT/IL players by
  // team, so a star being out is impossible to miss in the tool payload.
  keyAbsences: Array<{ team: string; player: string; status: string; position?: string }>;
  dataWarning?: string;
};

function slateTeamsForLeague(league: AgentLeague): string[] {
  const oddsFile = ODDS_FILE[league];
  const loaded = loadJsonWithStatus<RawOddsFile>(oddsFile, { events: [] });
  return slateTeamsFromEvents(loaded.data.events ?? []);
}

export function getInjuries(input: GetInjuriesInput): GetInjuriesResult {
  const { league } = input;
  const file = INJURY_FILE[league];
  const empty: GetInjuriesResult = {
    fetchedAt: null,
    players: [],
    teamsCovered: [],
    scope: input.teams && input.teams.length ? "matchup" : input.scopeToSlate === false ? "full" : "slate",
    keyAbsences: [],
  };
  if (!file) return empty;

  const loaded = loadJsonWithStatus<InjuryFile>(file, {});
  const warn = dataWarning(file, loaded.status, loaded.ageMs);
  const all = (loaded.data.players ?? []) as ScopeInjury[];

  // Matchup mode — the analyst passed the two teams it's evaluating.
  if (input.teams && input.teams.length > 0) {
    const players = injuriesForTeams(all, input.teams, { decisionOnly: true, league }) as Injury[];
    return {
      fetchedAt: loaded.data.fetchedAt ?? null,
      players,
      teamsCovered: [...new Set(players.map((p) => p.team))].sort(),
      scope: "matchup",
      keyAbsences: keyAbsencesOf(players),
      ...(warn ? { dataWarning: warn } : {}),
    };
  }

  // Full-feed mode — explicit opt-out of slate scoping.
  if (input.scopeToSlate === false) {
    const players = [...all].sort((a, b) => a.team.localeCompare(b.team)) as Injury[];
    return {
      fetchedAt: loaded.data.fetchedAt ?? null,
      players,
      teamsCovered: [...new Set(players.map((p) => p.team))].sort(),
      scope: "full",
      keyAbsences: keyAbsencesOf(players),
      ...(warn ? { dataWarning: warn } : {}),
    };
  }

  // Default — scope to today's slate for this league.
  const slateTeams = slateTeamsForLeague(league);
  const result = scopeInjuriesToSlate(all, slateTeams, { decisionOnly: true, league });
  const players = result.scoped as Injury[];
  return {
    fetchedAt: loaded.data.fetchedAt ?? null,
    players,
    teamsCovered: result.teamsPlaying,
    scope: "slate",
    keyAbsences: keyAbsencesOf(players),
    ...(warn ? { dataWarning: warn } : {}),
  };
}

// Pull the highest-impact absences (OUT / IL) to the top of the tool payload
// so a star sitting can't be buried under a wall of questionable role players.
function keyAbsencesOf(players: Injury[]): GetInjuriesResult["keyAbsences"] {
  return players
    .filter((p) => {
      const t = statusTier(p.status);
      return t === "OUT" || t === "IL";
    })
    .map((p) => ({ team: p.team, player: p.player, status: p.status, position: p.position }));
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

// Analyst-facing player-prop feeds, in PropEntry shape (topProps/props +
// available flag), produced by the prop scrapers. MLB props reach the analyst
// through get_mlb_signals + get_home_run_likes instead, so MLB is intentionally
// not served here. WNBA reads latest-player-props-wnba.json — when that feed
// doesn't exist yet the loader returns available:false and the analyst skips
// props cleanly (no fabricated picks).
const PLAYER_PROPS_FILE: Partial<Record<AgentLeague, string>> = {
  NBA: "latest-player-props.json",
  WNBA: "latest-player-props-wnba.json",
};

export function getPlayerProps(league: AgentLeague): {
  generatedAt: string | null;
  available: boolean;
  topProps: PropEntry[];
  dataWarning?: string;
} {
  const file = PLAYER_PROPS_FILE[league];
  if (!file) return { generatedAt: null, available: false, topProps: [] };
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
  league: "NBA" | "MLB" | "WNBA";
  player: string;
  propType: string;
  line: number;
  side: "over" | "under";
  opponent?: string | null;
};

export function getPropProjection(input: PropProjectionInput) {
  if (input.league !== "NBA" && input.league !== "MLB" && input.league !== "WNBA") {
    return { available: false, reason: "prop projection only supported for NBA, MLB + WNBA" };
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

// ─── Tool: get_home_run_likes (MLB only) ───────────────────────────────────
// Surfaces the 🔥 home-run "likes" the props board has already flagged: MLB
// HomeRuns/Over props whose de-vigged sharp fair prob beats the soft book's
// implied prob by the playable EV floor. The number is NOT fabricated by the
// LLM — it comes from the same devigged sharp HR line the props board uses.
// The analyst can promote a flagged HR like into a prop pick, but it MUST still
// run get_prop_projection for the player to source modelProb (this tool gives
// the market-edge signal, not the projection). Read-only; empty/missing log
// degrades to [] so the analyst can skip cleanly.

export function getHomeRunLikesForAgent(league: AgentLeague): {
  available: boolean;
  count: number;
  likes: HomeRunLike[];
  note: string;
} {
  if (league !== "MLB") {
    return {
      available: false,
      count: 0,
      likes: [],
      note: "home-run likes are MLB-only — no HR market for this league.",
    };
  }
  const likes = getHomeRunLikes();
  return {
    available: true,
    count: likes.length,
    likes,
    note:
      likes.length === 0
        ? "No HR likes on the current board — no MLB HomeRuns/Over prop currently beats the de-vigged sharp line by the playable floor. Don't force an HR pick."
        : "These MLB batter_home_runs OVER props beat the de-vigged sharp (Pinnacle) line by the playable EV floor. evPct is the edge vs the soft book. To pick one, call get_prop_projection(MLB, player, 'batter_home_runs', line, 'over', opponent) for the modelProb — this tool supplies the sharp-market edge, NOT the projection. Still apply the ≥6% pick floor and one-prop-per-player cap.",
  };
}

// ─── Tool: get_quant_desk_analysis (MLB only) ──────────────────────────────
// Shows the analyst what the deterministic quant desk (Benter/Benham/Bloom)
// has already flagged for today's MLB slate. The desk runs a separate,
// code-only scan: model fair value → 3% edge floor → sharp-direction gate →
// ¼-Kelly sizing. An open play here corroborates an analyst pick on the same
// game. An empty result is a mild bearish signal for the slate.

type QuantDeskBetStub = {
  gameId?: string;
  matchup?: string;
  market?: string;
  selection?: string;
  commenceTime?: string;
  priceAmerican?: number;
  modelFairProb?: number;
  devigMarketProb?: number;
  edge?: number;
  status?: "open" | "won" | "lost" | "void";
  clvCents?: number | null;
  beatClose?: boolean | null;
};

type QuantDeskBookFile = {
  updatedAt?: string;
  bets?: QuantDeskBetStub[];
};

export function getQuantDeskAnalysis(league: AgentLeague): {
  available: boolean;
  openCount: number;
  openPlays: Array<{
    gameId: string;
    matchup: string;
    selection: string;
    market: string;
    priceAmerican: number;
    edge: number;
    modelFairProb: number;
    devigMarketProb: number;
    commenceTime: string;
  }>;
  recentStats: {
    settledCount: number;
    wins: number;
    losses: number;
    clvBeatRatePct: number | null;
    avgClvCents: number | null;
  } | null;
  note: string;
  dataWarning?: string;
} {
  if (league !== "MLB") {
    return {
      available: false,
      openCount: 0,
      openPlays: [],
      recentStats: null,
      note: "Quant desk is MLB-only — no quant desk analysis available for this league.",
    };
  }

  const file = "quant-desk-mlb-book.json";
  const loaded = loadJsonWithStatus<QuantDeskBookFile>(file, {});
  const warn = dataWarning(file, loaded.status, loaded.ageMs);

  const bets = loaded.data.bets ?? [];
  const openPlays = bets
    .filter(b => b.status === "open")
    .sort((a, b) => (b.edge ?? 0) - (a.edge ?? 0))
    .map(b => ({
      gameId: b.gameId ?? "",
      matchup: b.matchup ?? "",
      selection: b.selection ?? "",
      market: b.market ?? "",
      priceAmerican: b.priceAmerican ?? 0,
      edge: b.edge ?? 0,
      modelFairProb: b.modelFairProb ?? 0,
      devigMarketProb: b.devigMarketProb ?? 0,
      commenceTime: b.commenceTime ?? "",
    }));

  const settled = bets.filter(b => b.status === "won" || b.status === "lost");
  const wins = settled.filter(b => b.status === "won").length;
  const withClv = settled.filter(b => b.clvCents != null && b.beatClose != null);
  const beatClvCount = withClv.filter(b => b.beatClose === true).length;
  const avgClvCents =
    withClv.length > 0
      ? withClv.reduce((s, b) => s + (b.clvCents ?? 0), 0) / withClv.length
      : null;

  const recentStats =
    settled.length > 0
      ? {
          settledCount: settled.length,
          wins,
          losses: settled.length - wins,
          clvBeatRatePct:
            withClv.length > 0 ? (beatClvCount / withClv.length) * 100 : null,
          avgClvCents,
        }
      : null;

  const topEdgePct = openPlays.length > 0
    ? ((openPlays[0]?.edge ?? 0) * 100).toFixed(1)
    : "0.0";
  const note =
    openPlays.length === 0
      ? "No quant desk open plays for today's MLB slate. The deterministic model found no games clearing the 3% edge + sharp-direction floor. This is a mild bearish signal — don't force a pick, but your tools may still surface edge the model missed."
      : `Quant desk has ${openPlays.length} open MLB play(s), highest edge first. These games cleared 3% model mispricing vs the de-vigged Pinnacle line AND sharp-direction agreement. A corroborating analyst pick on the same game is stronger evidence — cite the desk's top edge (${topEdgePct}%) in your thesis.`;

  return {
    available: true,
    openCount: openPlays.length,
    openPlays,
    recentStats,
    note,
    ...(warn ? { dataWarning: warn } : {}),
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
  | "get_home_run_likes"
  | "get_dream_memory"
  | "get_team_recent_records"
  | "get_quant_desk_analysis"
  | "get_board_edges";

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
    get_injuries: input => getInjuries(input as GetInjuriesInput),
    get_player_props: input => getPlayerProps((input as { league: AgentLeague }).league),
    get_trend_summary: input => getTrendSummary((input as { league: AgentLeague }).league),
    get_mlb_signals: () => getMlbSignals(),
    get_prop_projection: input => getPropProjection(input as PropProjectionInput),
    get_home_run_likes: input =>
      getHomeRunLikesForAgent((input as { league: AgentLeague }).league),
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
    get_quant_desk_analysis: input =>
      getQuantDeskAnalysis((input as { league: AgentLeague }).league),
    get_board_edges: input =>
      getBoardEdges((input as { league: AgentLeague }).league),
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
      properties: { league: { type: "string", enum: ["NBA", "MLB", "WNBA"] } },
      required: ["league"],
    },
  },
  {
    name: "get_model_probabilities",
    description:
      "Get the in-house model's win probabilities for today's games. NBA model includes expected margin and net ratings; MLB model is calibrated and pitcher-aware.",
    input_schema: {
      type: "object" as const,
      properties: { league: { type: "string", enum: ["NBA", "MLB", "WNBA"] } },
      required: ["league"],
    },
  },
  {
    name: "get_injuries",
    description:
      "Get the injury report for a league, scoped to teams playing today. By default returns ONLY decision-relevant players (OUT / DOUBTFUL / IL / QUESTIONABLE) for teams on today's slate, worst-first, plus a keyAbsences list of OUT/IL players you must not overlook. **For MLB the list is filtered to GAME-HEAVY absences only: any near-term injured pitcher (starter/reliever) plus position players who are OUT/short-IL — season-long 60-Day-IL players are excluded because the market already priced them. So an MLB injury appearing here is one that can actually move tonight's line (especially a scratched/IL starting pitcher).** When evaluating a specific game, pass `teams` (the two full team names from get_odds) to get just that matchup's injuries — a key player OUT should move your modelProb, and the critic will check you accounted for it. Set scopeToSlate=false only if you need the entire league feed. Covers NBA, MLB, and NHL.",
    input_schema: {
      type: "object" as const,
      properties: {
        league: { type: "string", enum: ["NBA", "MLB", "WNBA"] },
        teams: {
          type: "array",
          items: { type: "string" },
          description:
            "The two team names of the matchup you are evaluating (full Odds API display names, e.g. ['Los Angeles Clippers','Boston Celtics']). Returns only these teams' decision-relevant injuries.",
        },
        scopeToSlate: {
          type: "boolean",
          description: "Default true. False returns the entire league feed (rarely needed).",
        },
      },
      required: ["league"],
    },
  },
  {
    name: "get_player_props",
    description:
      "Get the top-ranked player props for the league with consensus lines and the model's pick side and confidence. Available for NBA and WNBA; returns available:false when no scraped props feed exists for the league today (skip props in that case).",
    input_schema: {
      type: "object" as const,
      properties: { league: { type: "string", enum: ["NBA", "MLB", "WNBA"] } },
      required: ["league"],
    },
  },
  {
    name: "get_trend_summary",
    description:
      "Get a high-level trend summary for the league, including trend score, recent averages, and best-bet rankings.",
    input_schema: {
      type: "object" as const,
      properties: { league: { type: "string", enum: ["NBA", "MLB", "WNBA"] } },
      required: ["league"],
    },
  },
  {
    name: "get_mlb_signals",
    description:
      "MLB-only advanced metrics from FanGraphs. Returns: regressionCandidates (batters with xwOBA - wOBA >= 0.020 = BABIP-suppressed, hits/total-bases overs are undervalued), velocityGainers (pitchers with rising FB velocity = strikeouts overs are undervalued), closerChanges (recent role shifts saves market may not have priced). Use to find props the market hasn't caught up with.",
    input_schema: {
      type: "object" as const,
      properties: { league: { type: "string", enum: ["NBA", "MLB", "WNBA"] } },
      required: [],
    },
  },
  {
    name: "get_prop_projection",
    description:
      "REQUIRED source of modelProb for any prop pick you ship. Computes a deterministic projection from the player's last 10-14 games + opponent allowance. Returns: projected (adjusted mean), stddev, modelProb (probability of the chosen side hitting), nGames, rollingMean, opponentFactor (1.0 = neutral, <1 = tough matchup, >1 = soft), recentForm (last 5 values), notes. Returns { available: false } when the player has < 5 games in the window — in that case you MUST skip the prop, never invent a modelProb. Supports NBA, MLB + WNBA (WNBA shares the basketball box-score schema). propType uses the keys from get_player_props (player_points, player_rebounds, batter_hits, etc.). Opponent must be the full team displayName (e.g. 'Minnesota Timberwolves'), not abbreviations.",
    input_schema: {
      type: "object" as const,
      properties: {
        league: { type: "string", enum: ["NBA", "MLB", "WNBA"] },
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
    name: "get_home_run_likes",
    description:
      "MLB-only. Returns the current home-run 'likes' the props board has flagged: batter_home_runs OVER props whose de-vigged sharp (Pinnacle) fair probability beats the soft book's implied price by the playable EV floor. Each like has player, line, book, softAmerican, evPct (edge vs the soft book), team, opponent, and commence. The edge here is sharp-market-derived, not invented. Use this when generating MLB prop picks to find HR overs the soft books haven't caught up to — but you MUST still call get_prop_projection for the player to source the pick's modelProb (this tool supplies the market edge, not the projection), apply the ≥6% pick floor, and respect the one-prop-per-player cap. Returns count=0 / empty when no HR over currently clears the floor — don't force a pick.",
    input_schema: {
      type: "object" as const,
      properties: { league: { type: "string", enum: ["NBA", "MLB", "WNBA"] } },
      required: ["league"],
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
  {
    name: "get_quant_desk_analysis",
    description:
      "MLB-only. Returns what the deterministic quant desk model (Benter/Benham/Bloom doctrine) has already flagged for today's slate. The desk is a separate, code-only engine: model fair value → 3% edge floor + sharp-direction agreement (de-vigged Pinnacle) → ¼-Kelly sizing. Returns: openPlays (current open bets, each with matchup, selection, edge, modelFairProb, devigMarketProb, priceAmerican), recentStats (settled record + CLV beat rate + avg CLV), and a note. A quant desk open play on a game you were already leaning toward is STRONG corroborating evidence — cite the desk's edge in your thesis. Zero open plays is a mild bearish signal but NOT a hard block. You CANNOT substitute quant desk edge for your own modelProb — you still MUST call get_model_probabilities and get_injuries for any game you pick. For non-MLB leagues, returns available=false.",
    input_schema: {
      type: "object" as const,
      properties: { league: { type: "string", enum: ["NBA", "MLB", "WNBA"] } },
      required: ["league"],
    },
  },
  {
    name: "get_board_edges",
    description:
      "THE BEST-PLAY SURVEY. Joins tonight's odds with the in-house model and returns, per game, the model-vs-market edge for the better side — sorted best-first. Use this to answer 'what's tonight's best play?' / 'what do you like?' across the whole slate in ONE call. Each entry: matchup, pick (the +edge side), modelProb, impliedProb (best price), edge (= modelProb − best-price impliedProb, a 0–1 fraction), bestBook, bestPriceAmerican, commenceTime. edge/modelProb/impliedProb are real grounded fields — cite them directly (an edge of 0.062 = 6.2%). Plus a note saying how many clear the 6% floor (or that nothing does, with the highest). This is the survey tool: call it for a slate-level question, then optionally get_injuries on the top candidate. Don't invent edges — read them here.",
    input_schema: {
      type: "object" as const,
      properties: { league: { type: "string", enum: ["NBA", "MLB", "WNBA"] } },
      required: ["league"],
    },
  },
];
