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

import {
  getOdds,
  getPlayerProps,
  IN_SCOPE_LEAGUES,
  type AgentLeague,
  type InScopeLeague,
} from "@/lib/agent/tools";
import type { StatsLeague } from "@/lib/agent/tools/stats";
import { getHomeRunLikes } from "@/lib/props-board";
import { getAnthropic, MODELS } from "@/lib/agent/client";

export type Lane = "A" | "B";

export type RouteDecision =
  | { lane: "A"; reason: string }
  | {
      lane: "B";
      league: InScopeLeague;
      reason: string;
      matchedEntities: string[];
    }
  | {
      lane: "A";
      outOfScope: true;
      sport: string;
      reason: string;
    };

// ─── Three-tier scope detection ──────────────────────────────────────────────
//
// A message that clearly names a non-bettable sport is classified into one of
// two buckets BEFORE any model call:
//
//   "stats-only"  — we have TRUSTWORTHY stat data for the league (standings/
//                   gamelogs/efficiency) but we do NOT bet it: NFL, NHL, NCAAB
//                   (basketball). Routes to Lane B in STATS mode: pull + cite the
//                   numbers, but never issue a pick, edge, or stake.
//   "refuse"      — no data, or no TRUSTWORTHY data. golf/tennis/UFC (none),
//                   NCAAF/college-football (none), and SOCCER (standings drop
//                   draws → false records). In-character refusal, NO model call.
//
// WNBA is NOT here — it's bettable now (IN_SCOPE_LEAGUES), so it falls through
// to the normal entity/slate flow.

// Discriminated scope classification. `null` = in-scope (NBA/MLB/WNBA) or
// unmatched → normal entity/slate flow downstream.
export type ScopeClass =
  | { kind: "stats-only"; statsLeague: StatsLeague; sport: string }
  | { kind: "refuse"; sport: string };

// Stats-only leagues (data exists AND is trustworthy, but not bettable). Each
// pattern maps to the StatsLeague whose snapshot files back it. The STATS-ONLY
// tier is now exactly NFL, NHL, and NCAAB (basketball). Ordered most-specific-
// first.
//
// SOCCER is NOT here — it moved to REFUSE (see REFUSE_PATTERNS): our only soccer
// data is standings-{epl,mls,ucl}.json and StandingsRow drops draws, so a club's
// "W-L" record is false (Arsenal shows 22-5 for an actual 22-5-11). On a bot
// whose brand is "every number is real", a false record is worse than a refusal.
//
// COLLEGE is split: basketball (NCAAB, data exists) is stats-only; football
// (NCAAF/CFB, NO data) refuses. The college-BASKETBALL pattern here matches
// ncaab/cbb/"college basketball"/"march madness" AND the bare "college"/"ncaa"
// generic (defaulting the ambiguous "college" ask to basketball, which we have),
// while ncaaf/cfb/"college football" is caught by REFUSE_PATTERNS FIRST.
const STATS_ONLY_PATTERNS: Array<{
  sport: string;
  statsLeague: StatsLeague;
  re: RegExp;
}> = [
  { sport: "NHL / hockey", statsLeague: "NHL", re: /\b(?:nhl|hockey|stanley cup|puck)\b/i },
  {
    sport: "college basketball",
    statsLeague: "NCAAB",
    re: /\b(?:ncaab|cbb|college basketball|march madness|college|ncaa)\b/i,
  },
];

const NFL_PATTERNS: RegExp[] = [
  /\bnfl\b/i,
  /\bsuper bowl\b/i,
  /\bquarterback\b/i,
  // NFL team nicknames that aren't shared with NBA/MLB. (Avoid "Giants" —
  // shared with MLB SF Giants — and "Cardinals" — shared with MLB STL.)
  /\b(?:chiefs|49ers|niners|cowboys|eagles|packers|bills|ravens|bengals|steelers|patriots|dolphins|jets|broncos|raiders|chargers|seahawks|vikings|lions|bears|saints|buccaneers|falcons|panthers|commanders|texans|colts|jaguars|titans|browns)\b/i,
];

// Refused sports — no trustworthy data. In-character refusal, no model call.
// Includes:
//   - golf / tennis / UFC — no data at all.
//   - NCAAF / college football — no data (only NCAAB basketball standings exist).
//   - SOCCER — data exists but is untrustworthy (StandingsRow drops draws → false
//     records), so we refuse rather than cite a wrong number. This is checked
//     BEFORE the stats-only college pattern so "college football" refuses rather
//     than falling into NCAAB basketball.
const REFUSE_PATTERNS: Array<{ sport: string; re: RegExp }> = [
  { sport: "golf", re: /\b(?:golf|pga|masters|the open)\b/i },
  { sport: "tennis", re: /\b(?:tennis|wimbledon|us open tennis|atp|wta)\b/i },
  { sport: "UFC / MMA", re: /\b(?:ufc|mma|boxing)\b/i },
  { sport: "college football", re: /\b(?:ncaaf|cfb|college football)\b/i },
  {
    sport: "soccer",
    re: /\b(?:soccer|premier league|la liga|champions league|mls|epl|ucl|bundesliga|serie a|world cup|major league soccer|football club)\b/i,
  },
];

// Classify a message's out-of-scope sport into stats-only vs refuse, or null
// when it's in-scope / unmatched.
//
// REFUSE is checked FIRST because two refused sports overlap the stats-only
// college pattern: "college football" (NCAAF, refuse) must beat the generic
// "college" → NCAAB basketball (stats-only), and soccer's "football club" /
// generic terms must refuse rather than be mistaken for anything else. After
// refuse: stats-only leagues, then NFL.
export function detectOutOfScope(message: string): ScopeClass | null {
  for (const { sport, re } of REFUSE_PATTERNS) {
    if (re.test(message)) return { kind: "refuse", sport };
  }
  for (const { sport, statsLeague, re } of STATS_ONLY_PATTERNS) {
    if (re.test(message)) return { kind: "stats-only", statsLeague, sport };
  }
  if (NFL_PATTERNS.some((p) => p.test(message))) {
    return { kind: "stats-only", statsLeague: "NFL", sport: "NFL" };
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
  teams: Map<string, InScopeLeague>;
  // Lowercased ≥4-char team tokens (nickname/city words) → league.
  tokens: Map<string, InScopeLeague>;
  // Lowercased player full names → league.
  players: Map<string, InScopeLeague>;
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

// League precedence on a SHARED key (city/nickname token, or a name that two
// leagues both put on the board — "chicago" = Cubs AND Sky). Higher rank wins so
// indexing order (NBA, then MLB, then WNBA in IN_SCOPE_LEAGUES) can't let WNBA
// last-writer-wins clobber MLB/NBA. Mirrors primaryLeagueWithGames' MLB>NBA>WNBA
// tie-break so a shared token routes to the deeper-book league.
const LEAGUE_RANK: Record<InScopeLeague, number> = { MLB: 3, NBA: 2, WNBA: 1 };

// Set key→league only if the new league outranks whatever's already there. First
// write wins for a fresh key; a collision keeps the higher-ranked league.
function setRanked(
  map: Map<string, InScopeLeague>,
  key: string,
  league: InScopeLeague
): void {
  const existing = map.get(key);
  if (existing === undefined || LEAGUE_RANK[league] > LEAGUE_RANK[existing]) {
    map.set(key, league);
  }
}

function addTeam(ent: SlateEntities, name: string, league: InScopeLeague): void {
  const lower = name.toLowerCase().trim();
  if (!lower) return;
  setRanked(ent.teams, lower, league);
  for (const tok of lower.split(/[^a-z0-9]+/)) {
    if (tok.length >= 4 && !STOPWORD_TOKENS.has(tok)) {
      setRanked(ent.tokens, tok, league);
    }
  }
}

function addPlayer(ent: SlateEntities, name: string, league: InScopeLeague): void {
  const lower = name.toLowerCase().trim();
  if (lower.length >= 3) setRanked(ent.players, lower, league);
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

  // Index every bettable league's board (NBA, MLB, WNBA). getOdds("WNBA")
  // reads latest-odds-api-basketball_wnba.json; an absent/empty feed degrades
  // to [] rather than throwing, so a dark WNBA night just adds nothing.
  for (const league of IN_SCOPE_LEAGUES) {
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

  // Player props for the leagues with a props feed. NBA + WNBA share the
  // PropEntry schema via getPlayerProps; both degrade to available:false with
  // an empty topProps when the feed is absent — index whatever's there, never
  // crash on a missing WNBA feed.
  for (const league of ["NBA", "WNBA"] as const) {
    try {
      const { topProps } = propsFn(league);
      for (const p of topProps) addPlayer(ent, p.player, league);
    } catch (err) {
      console.error(`[chat/router] buildSlateEntities ${league} props:`, err);
    }
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
  league: InScopeLeague;
  matched: string[];
  // "name"  — at least one hit was a FULL team name or a player name (a strong,
  //           unambiguous slate signal). Full-name/player hits KEEP entity-first
  //           precedence over the scope class.
  // "token" — the ONLY hits were ≥4-char nickname/city TOKENS (the weakest
  //           signal). Most tokens ("yankees", "astros") are still safe; but a
  //           token that is ALSO a nickname of an out-of-scope league ("rangers"
  //           = Texas Rangers / NY Rangers) is a COLLISION and yields to the
  //           scope class — see `sharedOosToken`.
  tier: "name" | "token";
  // True when the ONLY hits were token-tier AND at least one matched token is a
  // nickname shared with an out-of-scope league (SHARED_OOS_NICKNAMES). This is
  // the exact ambiguity ("Rangers puck line") the scope class must win.
  sharedOosToken: boolean;
};

// Nicknames a bettable (NBA/MLB/WNBA) team shares with an out-of-scope league
// (NHL/NFL). When such a token is the ONLY entity signal AND the message trips
// the scope gate, the user almost certainly means the out-of-scope team
// ("Rangers puck line" = NY Rangers, not Texas Rangers), so the scope class
// wins. A FULL team-name or player hit is unambiguous and is exempt. Lowercased.
//
// Deliberately small — only nicknames that genuinely collide across our
// in-scope and out-of-scope lists. Rangers (MLB Texas / NHL NY), Kings (NBA
// Sacramento / NHL LA), Panthers (NHL Florida / NFL Carolina), Giants (MLB SF /
// NFL NY), Cardinals (MLB STL / NFL Arizona), Jets (MLB? no — NFL / NHL Winnipeg).
const SHARED_OOS_NICKNAMES: ReadonlySet<string> = new Set([
  "rangers", // MLB Texas ↔ NHL New York
  "kings", // NBA Sacramento ↔ NHL Los Angeles
  "panthers", // NHL Florida ↔ NFL Carolina
  "giants", // MLB San Francisco ↔ NFL New York
  "cardinals", // MLB St. Louis ↔ NFL Arizona
]);

// Does the message name a specific team or player on tonight's slate? Returns
// the league + matched entities + the match TIER, or null. Whole-word/substring-
// aware so "Lakers" matches "lakers" without matching inside another word.
export function matchSlateEntity(
  message: string,
  ent: SlateEntities
): EntityMatch | null {
  const lower = ` ${message.toLowerCase()} `;
  const matched: string[] = [];
  let league: InScopeLeague | null = null;
  // Did any FULL team-name or player-name (not a bare token) hit? That's the
  // strong signal that survives the scope-class tiebreak.
  let hasNameHit = false;

  const consider = (key: string, lg: InScopeLeague, isNameTier: boolean) => {
    // Word-boundaried contains: surround the haystack with spaces and require
    // the key to be flanked by non-alphanumerics.
    const re = new RegExp(`[^a-z0-9]${escapeRe(key)}[^a-z0-9]`, "i");
    if (re.test(lower)) {
      matched.push(key);
      league ??= lg;
      if (isNameTier) hasNameHit = true;
    }
  };

  for (const [name, lg] of ent.teams) consider(name, lg, true);
  for (const [player, lg] of ent.players) consider(player, lg, true);
  // Tokens last — they're the weakest signal (a single nickname word).
  if (matched.length === 0) {
    for (const [tok, lg] of ent.tokens) consider(tok, lg, false);
  }

  if (matched.length === 0 || !league) return null;
  const tier: "name" | "token" = hasNameHit ? "name" : "token";
  const sharedOosToken =
    tier === "token" && matched.some((t) => SHARED_OOS_NICKNAMES.has(t));
  return {
    league,
    matched: [...new Set(matched)],
    tier,
    sharedOosToken,
  };
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

// The league to survey for a slate-level question = whichever has the most
// games on tonight's board (teams Map carries 2 entries per game). Null when
// nothing is on the board at all. Ties break by IN_SCOPE_LEAGUES order reversed
// so MLB wins an NBA/MLB tie (preserves the historical default), then WNBA.
export function primaryLeagueWithGames(ent: SlateEntities): InScopeLeague | null {
  const counts = new Map<InScopeLeague, number>();
  for (const lg of IN_SCOPE_LEAGUES) counts.set(lg, 0);
  for (const lg of ent.teams.values()) {
    counts.set(lg, (counts.get(lg) ?? 0) + 1);
  }
  // Tie-break precedence: MLB > NBA > WNBA (a slate-level ask with no named
  // league leans to the deeper-book leagues first).
  const precedence: InScopeLeague[] = ["MLB", "NBA", "WNBA"];
  let best: InScopeLeague | null = null;
  let bestCount = 0;
  for (const lg of precedence) {
    const c = counts.get(lg) ?? 0;
    if (c > bestCount) {
      best = lg;
      bestCount = c;
    }
  }
  return bestCount === 0 ? null : best;
}

// ─── Main router ─────────────────────────────────────────────────────────────

// Deterministic classification with NO model call. Returns a decision, or
// "ambiguous" to signal the caller should run the Haiku tiebreaker. This is the
// pure core — fully unit-testable with an injected slate.
export type ClassifyResult =
  | { lane: "A"; outOfScope: true; sport: string; reason: string }
  | {
      lane: "B";
      mode: "stats";
      statsLeague: StatsLeague;
      sport: string;
      reason: string;
    }
  | {
      lane: "B";
      league: InScopeLeague;
      matchedEntities: string[];
      reason: string;
    }
  | { lane: "A"; ambiguous: true; reason: string }
  | { lane: "A"; reason: string };

export function classifyDeterministic(
  message: string,
  ent: SlateEntities
): ClassifyResult {
  // (1) BETTABLE ENTITY MATCH takes precedence over the scope class — but ONLY
  // for a strong (full team-name or player) hit. A mixed message ("parlay the
  // Yankees ML with the Chiefs") names both a bettable NAME (Yankees, on
  // tonight's board) AND a stats-only scope word (Chiefs → NFL); the bettable
  // read is the one we can act on, so it wins and we route to bets Lane B.
  //
  // The collision case is narrow: the ONLY entity hit is a bare TOKEN that is a
  // SHARED out-of-scope nickname ("Rangers" = Texas Rangers token, but the user
  // means the NHL Rangers in "Rangers puck line tonight?"), AND the message
  // trips the scope gate (an explicit other-sport cue like "puck line"/"NHL").
  // Only then does the SCOPE CLASS win. Every other entity hit keeps entity-first
  // precedence:
  //   • a full team-name or player hit (unambiguous), and
  //   • a token hit that is NOT a shared nickname — e.g. "parlay the Yankees ML
  //     with the Chiefs": "yankees" is token-tier but NOT a shared OOS nickname,
  //     so the bettable MLB read wins even though "Chiefs" trips the NFL gate.
  const entity = matchSlateEntity(message, ent);
  const oos = detectOutOfScope(message);
  if (entity && !(entity.sharedOosToken && oos)) {
    return {
      lane: "B",
      league: entity.league,
      matchedEntities: entity.matched,
      reason: `entity-match:${entity.matched.join(",")}`,
    };
  }

  // (2) SCOPE CLASS — cheapest, no model. A stats-only league (trustworthy data,
  // not bettable) routes to Lane B in STATS mode; a refused sport (no data / no
  // trustworthy data) returns the out-of-scope Lane-A refusal.
  if (oos) {
    if (oos.kind === "stats-only") {
      return {
        lane: "B",
        mode: "stats",
        statsLeague: oos.statsLeague,
        sport: oos.sport,
        reason: `stats-only:${oos.sport}`,
      };
    }
    return {
      lane: "A",
      outOfScope: true,
      sport: oos.sport,
      reason: `out-of-scope:${oos.sport}`,
    };
  }

  // (3) Slate-level intent ("best play tonight", "what do you like", "any plays?")
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
): Promise<{ lane: "A" } | { lane: "B"; league: InScopeLeague }> {
  const leaguesTonight = new Set([...ent.teams.values()]);
  const leagueList = [...leaguesTonight].join(", ") || "none";

  const resp = await client.messages.create({
    model: MODELS.chatPersona,
    max_tokens: 16,
    system:
      "You are a strict router for a sports-betting chatbot that covers NBA, MLB, and WNBA. " +
      "Answer with the LEAGUE (NBA, MLB, or WNBA) if the user wants a LIVE READ on tonight's games — this INCLUDES " +
      "a specific game/player AND slate-level asks like 'what's the best play tonight', 'what do you like', " +
      "'any plays', 'who do you got' (these need tonight's board, so they are a live read, NOT general). " +
      "Answer GENERAL only for questions about betting discipline/philosophy/definitions with no need for tonight's numbers. " +
      `Leagues with games tonight: ${leagueList}. When a slate-level ask doesn't name a league, pick the one with games tonight. ` +
      "Reply with EXACTLY one token: NBA, MLB, WNBA, or GENERAL. No other text.",
    messages: [{ role: "user", content: message.slice(0, 500) }],
  });

  const text = resp.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim()
    .toUpperCase();

  // Check WNBA before NBA — "WNBA" starts with "W", not "N", so order-safe, but
  // be explicit for clarity.
  if (text.startsWith("WNBA")) return { lane: "B", league: "WNBA" };
  if (text.startsWith("NBA")) return { lane: "B", league: "NBA" };
  if (text.startsWith("MLB")) return { lane: "B", league: "MLB" };
  return { lane: "A" };
}
