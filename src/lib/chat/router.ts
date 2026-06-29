// The hybrid router for "The Sharp".
//
// Every inbound message is classified Lane A (persona-only, cheap, no tools) vs
// Lane B (live grounded analysis, Sonnet + read-only tools) BEFORE any expensive
// work. Cheapest signal first:
//   1. Scope gate — out-of-scope sport (NFL/NHL/soccer/college) → refuse,
//      never route to analysis.
//   2. Entity match — does the message name a team/player on TONIGHT'S NBA/MLB
//      slate (read from get_odds + the props snapshots)? Hit → Lane B candidate.
//   3. Ambiguity fallback — a short Haiku classifier ONLY for the genuinely
//      ambiguous middle (looks game-specific but no entity matched). Default on
//      no specific-entity match is Lane A.
//
// The router is pure-ish: slate reading is file I/O (the same snapshots the
// tools read), but the classification decision is separated from the model call
// so it unit-tests with an injected slate.

import { getOdds, getPlayerProps, type AgentLeague } from "@/lib/agent/tools";
import { getHomeRunLikes } from "@/lib/props-board";
import { getAnthropic, MODELS } from "@/lib/agent/client";

export type Lane = "A" | "B";

export type RouteDecision =
  | { lane: "A"; reason: string }
  | { lane: "B"; league: "NBA" | "MLB"; reason: string; matchedEntities: string[] }
  | {
      lane: "A";
      outOfScope: true;
      sport: string;
      reason: string;
    };

// ─── Out-of-scope sport detection ────────────────────────────────────────────
//
// We only put our name on NBA + MLB. A message that clearly names another
// sport gets an in-character refusal — never a fabricated read. NFL gets a
// softer one-clause acknowledgment ("in research, not live").

type OutOfScope = { sport: string; nflResearch: boolean };

const NFL_PATTERNS: RegExp[] = [
  /\bnfl\b/i,
  /\bsuper bowl\b/i,
  /\bquarterback\b/i,
  // NFL team nicknames that aren't shared with NBA/MLB. (Avoid "Giants" —
  // shared with MLB SF Giants — and "Cardinals" — shared with MLB STL.)
  /\b(?:chiefs|49ers|niners|cowboys|eagles|packers|bills|ravens|bengals|steelers|patriots|dolphins|jets|broncos|raiders|chargers|seahawks|vikings|lions|bears|saints|buccaneers|falcons|panthers|commanders|texans|colts|jaguars|titans|browns)\b/i,
];

const OTHER_SPORT_PATTERNS: Array<{ sport: string; re: RegExp }> = [
  { sport: "NHL / hockey", re: /\b(?:nhl|hockey|stanley cup|puck)\b/i },
  { sport: "soccer", re: /\b(?:soccer|premier league|la liga|champions league|mls|world cup|epl|bundesliga|serie a)\b/i },
  { sport: "college", re: /\b(?:college|ncaa|ncaab|ncaaf|march madness|cfb|cbb)\b/i },
  { sport: "golf", re: /\b(?:golf|pga|masters|the open)\b/i },
  { sport: "tennis", re: /\b(?:tennis|wimbledon|us open tennis|atp|wta)\b/i },
  { sport: "UFC / MMA", re: /\b(?:ufc|mma|boxing)\b/i },
  { sport: "WNBA", re: /\bwnba\b/i },
];

export function detectOutOfScope(message: string): OutOfScope | null {
  for (const { sport, re } of OTHER_SPORT_PATTERNS) {
    if (re.test(message)) return { sport, nflResearch: false };
  }
  if (NFL_PATTERNS.some((p) => p.test(message))) {
    return { sport: "NFL", nflResearch: true };
  }
  return null;
}

// ─── Slate entity extraction ─────────────────────────────────────────────────
//
// Pull the set of matchable tokens for tonight's NBA + MLB slate: full team
// names, their meaningful tokens (≥4 chars, the house token convention), and
// the player names that appear in the props snapshots / HR likes. This is the
// cheap keyword/entity surface the router matches user text against.

export type SlateEntities = {
  // Lowercased full team display names → league.
  teams: Map<string, "NBA" | "MLB">;
  // Lowercased ≥4-char team tokens (nickname/city words) → league.
  tokens: Map<string, "NBA" | "MLB">;
  // Lowercased player full names → league.
  players: Map<string, "NBA" | "MLB">;
};

const STOPWORD_TOKENS = new Set([
  "team",
  "city",
  "state",
  "united",
  "club",
  "athletic",
  "sports",
]);

function addTeam(ent: SlateEntities, name: string, league: "NBA" | "MLB"): void {
  const lower = name.toLowerCase().trim();
  if (!lower) return;
  ent.teams.set(lower, league);
  for (const tok of lower.split(/[^a-z0-9]+/)) {
    if (tok.length >= 4 && !STOPWORD_TOKENS.has(tok)) {
      ent.tokens.set(tok, league);
    }
  }
}

function addPlayer(ent: SlateEntities, name: string, league: "NBA" | "MLB"): void {
  const lower = name.toLowerCase().trim();
  if (lower.length >= 3) ent.players.set(lower, league);
}

// Build the slate-entity index from the live snapshots. Pure over its inputs:
// readers are injected (defaulting to the real tools) so tests pass a fixture.
export function buildSlateEntities(deps?: {
  odds?: (league: AgentLeague) => ReturnType<typeof getOdds>;
  props?: (league: AgentLeague) => ReturnType<typeof getPlayerProps>;
  hrLikes?: () => ReturnType<typeof getHomeRunLikes>;
}): SlateEntities {
  const oddsFn = deps?.odds ?? getOdds;
  const propsFn = deps?.props ?? getPlayerProps;
  const hrFn = deps?.hrLikes ?? getHomeRunLikes;

  const ent: SlateEntities = {
    teams: new Map(),
    tokens: new Map(),
    players: new Map(),
  };

  for (const league of ["NBA", "MLB"] as const) {
    try {
      const { events } = oddsFn(league);
      for (const ev of events) {
        addTeam(ent, ev.homeTeam, league);
        addTeam(ent, ev.awayTeam, league);
      }
    } catch (err) {
      console.error(`[chat/router] buildSlateEntities odds ${league}:`, err);
    }
  }

  try {
    const { topProps } = propsFn("NBA");
    for (const p of topProps) addPlayer(ent, p.player, "NBA");
  } catch (err) {
    console.error("[chat/router] buildSlateEntities NBA props:", err);
  }

  try {
    for (const like of hrFn()) addPlayer(ent, like.player, "MLB");
  } catch (err) {
    console.error("[chat/router] buildSlateEntities HR likes:", err);
  }

  return ent;
}

// ─── Cheap entity match ──────────────────────────────────────────────────────

export type EntityMatch = {
  league: "NBA" | "MLB";
  matched: string[];
};

// Does the message name a specific team or player on tonight's slate? Returns
// the league + matched entities, or null. Whole-word/substring-aware so
// "Lakers" matches "lakers" without matching inside another word.
export function matchSlateEntity(
  message: string,
  ent: SlateEntities
): EntityMatch | null {
  const lower = ` ${message.toLowerCase()} `;
  const matched: string[] = [];
  let league: "NBA" | "MLB" | null = null;

  const consider = (key: string, lg: "NBA" | "MLB") => {
    // Word-boundaried contains: surround the haystack with spaces and require
    // the key to be flanked by non-alphanumerics.
    const re = new RegExp(`[^a-z0-9]${escapeRe(key)}[^a-z0-9]`, "i");
    if (re.test(lower)) {
      matched.push(key);
      league ??= lg;
    }
  };

  for (const [name, lg] of ent.teams) consider(name, lg);
  for (const [player, lg] of ent.players) consider(player, lg);
  // Tokens last — they're the weakest signal (a single nickname word).
  if (matched.length === 0) {
    for (const [tok, lg] of ent.tokens) consider(tok, lg);
  }

  if (matched.length === 0 || !league) return null;
  return { league, matched: [...new Set(matched)] };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Ambiguity signal ────────────────────────────────────────────────────────
//
// A message can look game-specific ("who do you like tonight", "should I bet
// the over") without naming a slate entity we indexed (the player/team might
// not be in our snapshots). Only THOSE go to the Haiku tiebreaker; everything
// else defaults to Lane A.

const GAME_SPECIFIC_HINTS: RegExp[] = [
  /\btonight\b/i,
  /\btoday\b/i,
  /\bwho (?:do you |would you )?(?:like|got|take)\b/i,
  /\bshould i (?:bet|take|play|back)\b/i,
  /\b(?:the )?(?:over|under|spread|moneyline|ml|total|first five|f5|run line|puck line)\b/i,
  /\bany (?:plays|picks|edge|action|value)\b/i,
  /\bwhat'?s your (?:read|take|play|pick)\b/i,
  /\bbet (?:on|the)\b/i,
];

export function looksGameSpecific(message: string): boolean {
  return GAME_SPECIFIC_HINTS.some((p) => p.test(message));
}

// ─── Slate-level intent ──────────────────────────────────────────────────────
//
// "What's tonight's best play?", "what do you like tonight?", "any plays?" — a
// question about the DESK'S BOARD, not a single named game. These are exactly
// the questions a betting desk must answer well (and one is a starter chip), but
// they name no entity, so they used to fall through to persona-only Lane A and
// answer "the numbers aren't in front of me" — while we have the whole slate +
// model + quant desk on hand. They route to Lane B (data-backed) and the model
// SURVEYS the board via get_odds / get_model_probabilities / get_quant_desk_analysis.
const SLATE_LEVEL_HINTS: RegExp[] = [
  /\b(?:best|top|favorite|strongest|sharpest) (?:play|plays|bet|bets|pick|picks|value)\b/i,
  /\bwhat(?:'?s| is| are)?\s+(?:the\s+|your\s+|tonight'?s\s+)*(?:best |top )?(?:play|plays|bet|bets|pick|picks)\b/i,
  /\bwhat (?:should|would|do|can) i (?:bet|play|take|back|pick)\b/i,
  /\bwhat (?:do|would) you (?:like|got|have|take|recommend)\b/i,
  /\bwho do you (?:like|got|take)\b/i,
  /\bany (?:plays|picks|bets|action|value|edges?|good bets?)\b/i,
  /\bgive me (?:a|the|your|one|some) (?:play|plays|pick|picks|bet|bets|best|action)\b/i,
  /\bwhat'?s good (?:tonight|today)?\b/i,
  /\b(?:your )?(?:best|top) (?:plays|bets|picks)\b/i,
];

export function looksSlateLevel(message: string): boolean {
  return SLATE_LEVEL_HINTS.some((p) => p.test(message));
}

// The league to survey for a slate-level question = whichever has more games on
// tonight's board (teams Map carries 2 entries per game). Null when nothing is
// on the board at all.
export function primaryLeagueWithGames(ent: SlateEntities): "NBA" | "MLB" | null {
  let nba = 0;
  let mlb = 0;
  for (const lg of ent.teams.values()) {
    if (lg === "NBA") nba++;
    else mlb++;
  }
  if (nba === 0 && mlb === 0) return null;
  return mlb >= nba ? "MLB" : "NBA";
}

// ─── Main router ─────────────────────────────────────────────────────────────

// Deterministic classification with NO model call. Returns a decision, or
// "ambiguous" to signal the caller should run the Haiku tiebreaker. This is the
// pure core — fully unit-testable with an injected slate.
export type ClassifyResult =
  | { lane: "A"; outOfScope: true; sport: string; reason: string }
  | { lane: "B"; league: "NBA" | "MLB"; matchedEntities: string[]; reason: string }
  | { lane: "A"; ambiguous: true; reason: string }
  | { lane: "A"; reason: string };

export function classifyDeterministic(
  message: string,
  ent: SlateEntities
): ClassifyResult {
  const oos = detectOutOfScope(message);
  if (oos) {
    return {
      lane: "A",
      outOfScope: true,
      sport: oos.sport,
      reason: oos.nflResearch ? "nfl-research" : `out-of-scope:${oos.sport}`,
    };
  }

  const entity = matchSlateEntity(message, ent);
  if (entity) {
    return {
      lane: "B",
      league: entity.league,
      matchedEntities: entity.matched,
      reason: `entity-match:${entity.matched.join(",")}`,
    };
  }

  // Slate-level intent ("best play tonight", "what do you like", "any plays?")
  // — no named entity, but it's a question about the desk's board. Route to
  // Lane B (data-backed) so the model surveys tonight's slate, NOT to a
  // clueless persona-only answer. matchedEntities is empty → Lane B runs in
  // "slate" survey mode (see sharp.ts / runLaneB scope).
  if (looksSlateLevel(message)) {
    const lg = primaryLeagueWithGames(ent);
    if (lg) {
      return {
        lane: "B",
        league: lg,
        matchedEntities: [],
        reason: "slate-level",
      };
    }
    // No games on the board at all — let it fall through; the persona answer
    // can honestly say there's no slate tonight.
  }

  if (looksGameSpecific(message)) {
    return { lane: "A", ambiguous: true, reason: "ambiguous-game-specific" };
  }

  return { lane: "A", reason: "no-entity-match" };
}

// The Haiku tiebreaker for the ambiguous middle. Returns the lane only; when it
// picks B but we have no entity, we still need a league — Haiku returns that
// too, defaulting to the league with games tonight. Cheap (one short Haiku
// call, tiny tokens). Injected client for tests.
export async function classifyAmbiguousWithModel(
  message: string,
  ent: SlateEntities,
  client = getAnthropic()
): Promise<{ lane: "A" } | { lane: "B"; league: "NBA" | "MLB" }> {
  const leaguesTonight = new Set([...ent.teams.values()]);
  const leagueList = [...leaguesTonight].join(", ") || "none";

  const resp = await client.messages.create({
    model: MODELS.chatPersona,
    max_tokens: 16,
    system:
      "You are a strict router for a sports-betting chatbot that ONLY covers NBA and MLB. " +
      "Answer with the LEAGUE (NBA or MLB) if the user wants a LIVE READ on tonight's games — this INCLUDES " +
      "a specific game/player AND slate-level asks like 'what's the best play tonight', 'what do you like', " +
      "'any plays', 'who do you got' (these need tonight's board, so they are a live read, NOT general). " +
      "Answer GENERAL only for questions about betting discipline/philosophy/definitions with no need for tonight's numbers. " +
      `Leagues with games tonight: ${leagueList}. When a slate-level ask doesn't name a league, pick the one with games tonight. ` +
      "Reply with EXACTLY one token: NBA, MLB, or GENERAL. No other text.",
    messages: [{ role: "user", content: message.slice(0, 500) }],
  });

  const text = resp.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim()
    .toUpperCase();

  if (text.startsWith("NBA")) return { lane: "B", league: "NBA" };
  if (text.startsWith("MLB")) return { lane: "B", league: "MLB" };
  return { lane: "A" };
}
