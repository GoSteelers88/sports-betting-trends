// injuries-scope.ts — slate-scoping + team-name matching for the injury wire.
//
// Two systems name teams differently:
//   - ESPN injuries feed   → "LA Clippers", "St. Louis Cardinals"
//   - The Odds API slate   → "Los Angeles Clippers", "St Louis Cardinals"
//
// The wire (dashboard + agent tool) must surface ONLY injuries for teams that
// are actually on today's slate, per sport. That requires matching an ESPN
// team name against the home/away names in latest-odds-api-*.json.
//
// Strategy (pure, deterministic, testable — no I/O here):
//   1. Normalize both sides (lowercase, strip punctuation/accents/whitespace,
//      expand a few city aliases like "la" → "los angeles").
//   2. Match if the normalized strings are equal, OR if the team NICKNAME
//      (the trailing word(s) that identify the franchise — "trail blazers",
//      "red sox", "white sox") matches. The nickname is the most reliable
//      cross-source key because cities vary ("LA" vs "Los Angeles") but the
//      nickname rarely does.
//   3. A small explicit alias set covers the cases where even the nickname is
//      ambiguous (e.g. ESPN "Athletics" ↔ Odds "Oakland Athletics"/"Athletics").
//
// The nickname approach is intentionally conservative: it requires the FULL
// multi-word nickname to match, so "White Sox" never collides with "Red Sox",
// and the two New York / two LA / two Chicago franchises stay distinct because
// their nicknames differ.

export type InjuryStatusTier =
  | "OUT"
  | "DOUBTFUL"
  | "IL"
  | "QUESTIONABLE"
  | "DAY_TO_DAY"
  | "OTHER";

export type ScopeInjury = {
  player: string;
  team: string;
  position?: string;
  status: string;
  injuryType?: string;
  returnDate?: string;
};

// ─── Normalization ───────────────────────────────────────────────────────────

// City/word aliases applied AFTER tokenization so multi-source city spellings
// converge. Keys and values are already-normalized tokens.
const TOKEN_ALIASES: Record<string, string> = {
  la: "los angeles",
  ny: "new york",
  sf: "san francisco",
  st: "saint",
  "st.": "saint",
};

export function normalizeTeam(name: string): string {
  const base = (name ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .replace(/[.'’`-]/g, " ") // punctuation → space (St. Louis, Trail-Blazers)
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Token-level alias expansion (la → los angeles, st → saint).
  const expanded = base
    .split(" ")
    .map((tok) => TOKEN_ALIASES[tok] ?? tok)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return expanded;
}

// ─── Nickname extraction ─────────────────────────────────────────────────────

// Multi-word nicknames that must be kept whole so the trailing-token nickname
// rule doesn't truncate them ("red sox" → "sox" would collide with "white
// sox"). Listed as normalized strings; each must be matched on a WHOLE-TOKEN
// boundary (not a substring — "kings" must not match inside "vikings").
const MULTIWORD_NICKNAMES = [
  "red sox",
  "white sox",
  "blue jays",
  "trail blazers",
  "maple leafs",
  "golden knights",
  "red wings",
  "blue jackets",
];

// True if `normalized` ends with the multi-word `nick` on a token boundary.
function endsWithTokens(normalized: string, nick: string): boolean {
  return normalized === nick || normalized.endsWith(" " + nick);
}

// The nickname is the franchise identifier — the part that stays constant
// across naming conventions. We take the last multi-word nickname if one
// matches on a token boundary, else the last single token. Cities ("los
// angeles", "new york") are explicitly NOT nicknames.
export function teamNickname(normalized: string): string {
  for (const nick of MULTIWORD_NICKNAMES) {
    if (endsWithTokens(normalized, nick)) return nick;
  }
  const tokens = normalized.split(" ").filter(Boolean);
  return tokens[tokens.length - 1] ?? normalized;
}

// ─── Explicit alias pairs ────────────────────────────────────────────────────

// Normalized name → canonical normalized name. Only for cases the nickname
// rule can't resolve. Currently the Athletics (ESPN sometimes drops the city:
// "Athletics" vs Odds "Oakland Athletics" / "Athletics") map to one canonical.
const CANONICAL_ALIASES: Record<string, string> = {
  athletics: "athletics",
  "oakland athletics": "athletics",
  "las vegas athletics": "athletics",
};

function canonical(normalized: string): string {
  return CANONICAL_ALIASES[normalized] ?? normalized;
}

// ─── Matcher ─────────────────────────────────────────────────────────────────

// The "place" tokens of a normalized name = everything that isn't part of the
// nickname (the city/region: "los angeles", "boston", "new york").
function placeTokens(normalized: string, nickname: string): string[] {
  const nickTokens = new Set(nickname.split(" ").filter(Boolean));
  return normalized.split(" ").filter((t) => t && !nickTokens.has(t));
}

// True if two team names (from different sources) refer to the same franchise.
//
// A nickname match alone is NOT sufficient: nicknames are shared across leagues
// (Panthers, Lions, 49ers all exist in NFL AND college; "Cardinals" is MLB and
// NFL). So when the nickname matches we ALSO require the CITY/PLACE to be
// compatible — they must share a place token, or one side must be place-less
// (ESPN occasionally drops the city, e.g. "Athletics"). "Charlotte 49ers" vs
// "San Francisco 49ers" → same nickname, disjoint cities → NO match.
export function matchTeam(a: string, b: string): boolean {
  const na = canonical(normalizeTeam(a));
  const nb = canonical(normalizeTeam(b));
  if (!na || !nb) return false;
  if (na === nb) return true;

  const nickA = teamNickname(na);
  const nickB = teamNickname(nb);
  if (nickA.length < 3 || nickA !== nickB) return false;

  // Nickname agrees — now require place compatibility.
  const placeA = placeTokens(na, nickA);
  const placeB = placeTokens(nb, nickB);
  // One side has no city (e.g. bare "Athletics") → accept on nickname alone.
  if (placeA.length === 0 || placeB.length === 0) return true;
  // Otherwise the cities must overlap on at least one token (handles "los
  // angeles clippers" vs "la"→"los angeles clippers"; rejects cross-city
  // nickname collisions like Charlotte vs San Francisco 49ers).
  const setB = new Set(placeB);
  return placeA.some((t) => setB.has(t));
}

// ─── Slate-team set ──────────────────────────────────────────────────────────

export type SlateEvent = { home_team?: string; away_team?: string };

// Build the set of teams playing today from an odds feed's events. Returns the
// ORIGINAL (un-normalized) display names so the caller can show them; matching
// is done via matchTeam, not set membership.
export function slateTeamsFromEvents(events: SlateEvent[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ev of events) {
    for (const name of [ev.home_team, ev.away_team]) {
      const n = (name ?? "").trim();
      if (!n) continue;
      const key = canonical(normalizeTeam(n));
      if (key && !seen.has(key)) {
        seen.add(key);
        out.push(n);
      }
    }
  }
  return out;
}

// Is this (ESPN) team name on the slate?
export function isTeamOnSlate(team: string, slateTeams: string[]): boolean {
  return slateTeams.some((s) => matchTeam(team, s));
}

// ─── MLB franchise allowlist + slate filter ──────────────────────────────────
//
// The baseball_mlb odds endpoint (FanDuel/Bovada) returns MORE than MLB: NPB
// (Japan), KBO (Korea), CPBL (Taiwan), and NCAA college baseball all come back
// under the same sportKey. Downstream code that treats every team in the feed
// as "tonight's slate" must be scoped to the 30 real MLB franchises explicitly,
// not by the lucky accident that foreign/college players aren't in the gamelog.
//
// We reuse the same canonical/matchTeam logic the injury wire uses, so there is
// exactly ONE team-matcher in this file. "Athletics" carries no city (current
// A's branding) and is already covered by CANONICAL_ALIASES, so it matches on
// the place-less branch of matchTeam without false-matching a city'd team.
export const MLB_TEAMS: string[] = [
  "Arizona Diamondbacks",
  "Athletics",
  "Atlanta Braves",
  "Baltimore Orioles",
  "Boston Red Sox",
  "Chicago Cubs",
  "Chicago White Sox",
  "Cincinnati Reds",
  "Cleveland Guardians",
  "Colorado Rockies",
  "Detroit Tigers",
  "Houston Astros",
  "Kansas City Royals",
  "Los Angeles Angels",
  "Los Angeles Dodgers",
  "Miami Marlins",
  "Milwaukee Brewers",
  "Minnesota Twins",
  "New York Mets",
  "New York Yankees",
  "Philadelphia Phillies",
  "Pittsburgh Pirates",
  "San Diego Padres",
  "San Francisco Giants",
  "Seattle Mariners",
  "St. Louis Cardinals",
  "Tampa Bay Rays",
  "Texas Rangers",
  "Toronto Blue Jays",
  "Washington Nationals",
];

// True iff `name` matches one of the 30 current MLB franchises. Case- and
// punctuation-insensitive via the shared matchTeam (no second matcher).
export function isMlbTeam(name: string): boolean {
  const n = (name ?? "").trim();
  if (!n) return false;
  return MLB_TEAMS.some((mlb) => matchTeam(n, mlb));
}

// The UTC calendar date ("YYYY-MM-DD") of an ISO timestamp, or null if absent
// or unparseable. Used by mlbSlateEvents' optional onDateUtc gate.
function utcDateOf(commenceTime?: string): string | null {
  if (!commenceTime) return null;
  const t = Date.parse(commenceTime);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

// The US-EASTERN calendar date ("YYYY-MM-DD") of an ISO timestamp. This is the
// correct "game day" for MLB scheduling: a 04:00Z game is the prior US evening's
// late game (e.g. a West-coast night game), so UTC-date would mis-bucket it.
// Uses Intl with America/New_York so DST is handled by the runtime, not by us.
export function easternDateOf(commenceTime?: string): string | null {
  if (!commenceTime) return null;
  const t = Date.parse(commenceTime);
  if (Number.isNaN(t)) return null;
  // en-CA gives YYYY-MM-DD directly.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(t));
}

// "Today" as a US-Eastern date string. The slate day MLB bettors mean.
export function easternToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// Keep ONLY real MLB games from a baseball feed: both home AND away must be MLB
// franchises (an MLB-vs-NCAA exhibition is dropped — both sides must be MLB).
// This strips NPB/KBO/CPBL/NCAA contamination from the baseball_mlb endpoint.
//
// Date scoping (so a sparse, multi-day pre-match feed can't surface a team that
// plays TOMORROW as if it plays tonight):
//  - opts.onDateEt ("YYYY-MM-DD"): keep only events whose US-EASTERN game-date
//    equals it. This is the CORRECT scope for an MLB slate (game day is US-local).
//  - opts.onDateUtc ("YYYY-MM-DD"): legacy UTC-date gate (kept for callers that
//    already pass it). Prefer onDateEt.
//  - neither: no date filter (MLB-team filter only).
export function mlbSlateEvents<
  T extends { home_team?: string; away_team?: string; commence_time?: string }
>(events: T[], opts: { onDateUtc?: string; onDateEt?: string } = {}): T[] {
  if (!Array.isArray(events)) return [];
  const { onDateUtc, onDateEt } = opts;
  return events.filter((ev) => {
    if (!ev) return false;
    if (!isMlbTeam(ev.home_team ?? "") || !isMlbTeam(ev.away_team ?? "")) {
      return false;
    }
    if (onDateEt) return easternDateOf(ev.commence_time) === onDateEt;
    if (onDateUtc) return utcDateOf(ev.commence_time) === onDateUtc;
    return true;
  });
}

// ─── Status severity ─────────────────────────────────────────────────────────

// Classify a raw ESPN status string into a tier the wire + agent can rank by.
// IL is treated as its own tier (an MLB player on the IL is OUT-equivalent for
// the games on today's slate, but the label matters for display).
export function statusTier(status: string): InjuryStatusTier {
  const s = (status ?? "").toUpperCase();
  if (s.includes("DOUBTFUL")) return "DOUBTFUL";
  if (s.includes("OUT")) return "OUT";
  if (s.includes("IL") || s.includes("INJURED RESERVE") || /\bIR\b/.test(s)) return "IL";
  if (s.includes("QUESTIONABLE")) return "QUESTIONABLE";
  if (s.includes("DAY-TO-DAY") || s.includes("DAY TO DAY")) return "DAY_TO_DAY";
  return "OTHER";
}

// A player is "decision-relevant" if their absence/uncertainty can move a
// matchup: OUT, DOUBTFUL, IL, or QUESTIONABLE. DAY_TO_DAY/OTHER are surfaced
// in the full feed but excluded from the high-signal scoped view by default.
const DECISION_TIERS: ReadonlySet<InjuryStatusTier> = new Set([
  "OUT",
  "DOUBTFUL",
  "IL",
  "QUESTIONABLE",
]);

export function isDecisionRelevant(status: string): boolean {
  return DECISION_TIERS.has(statusTier(status));
}

// ─── MLB "high-impact" filter ────────────────────────────────────────────────
//
// MLB returns ~360 injured players, but most are season-long 60-Day-IL roster
// filler that the market priced months ago — they do NOT move tonight's line.
// "Follow only people that affect the game heavy" means surfacing the absences
// that actually swing a single game:
//   - PITCHERS on any near-term status (a starter/reliever out reshapes the
//     game — pitching is the single biggest MLB game lever), AND
//   - position players who are near-term out (Day-To-Day / short-IL / Out),
//   while DROPPING 60-Day-IL entirely (long-term, already priced in).
//
// This is MLB-specific; other leagues keep the standard decision-relevant rule.

const PITCHER_POSITIONS: ReadonlySet<string> = new Set(["SP", "RP", "P"]);

// Long-term IL that the market has already absorbed — not a game-night signal.
function isLongTermIL(status: string): boolean {
  return /\b60[\s-]*day/i.test(status);
}

export function isPitcherPosition(position?: string): boolean {
  return !!position && PITCHER_POSITIONS.has(position.toUpperCase());
}

// True if an MLB injury is "heavy" enough to follow for a specific game.
export function isMlbHighImpact(inj: { position?: string; status: string }): boolean {
  if (isLongTermIL(inj.status)) return false; // months-gone, already priced
  if (isPitcherPosition(inj.position)) return true; // any near-term pitcher absence
  return isDecisionRelevant(inj.status); // position player: OUT/DOUBTFUL/IL/QUESTIONABLE
}

// Apply the per-league relevance gate: MLB uses the high-impact rule above;
// every other league uses the standard decision-relevant rule.
export function isRelevantForLeague(
  league: string,
  inj: { position?: string; status: string }
): boolean {
  if (league.toUpperCase() === "MLB") return isMlbHighImpact(inj);
  return isDecisionRelevant(inj.status);
}

// Sort weight — lower = more severe / higher in the wire.
const TIER_WEIGHT: Record<InjuryStatusTier, number> = {
  OUT: 0,
  IL: 1,
  DOUBTFUL: 2,
  QUESTIONABLE: 3,
  DAY_TO_DAY: 4,
  OTHER: 5,
};

export function tierWeight(status: string): number {
  return TIER_WEIGHT[statusTier(status)];
}

// ─── Scope a feed to a slate ─────────────────────────────────────────────────

export type ScopeResult<T extends ScopeInjury> = {
  // Players whose team is on the slate (any status that survived ingest).
  scoped: T[];
  // Subset of `scoped` that is decision-relevant (OUT/DOUBTFUL/IL/QUESTIONABLE).
  relevant: T[];
  // Distinct slate teams that have at least one scoped injury.
  teamsPlaying: string[];
};

// Filter an injury list down to teams on the slate. Pure — caller supplies the
// already-loaded injuries and the slate team list. `decisionOnly` controls
// whether `scoped` is pre-filtered to relevant statuses. `league` selects the
// relevance gate: MLB uses the high-impact rule (pitchers + near-term absences,
// dropping 60-Day-IL); other leagues use the standard decision-relevant rule.
export function scopeInjuriesToSlate<T extends ScopeInjury>(
  injuries: T[],
  slateTeams: string[],
  opts: { decisionOnly?: boolean; league?: string } = {}
): ScopeResult<T> {
  const relevanceFn = (inj: ScopeInjury) =>
    opts.league ? isRelevantForLeague(opts.league, inj) : isDecisionRelevant(inj.status);
  const onSlate = injuries.filter((inj) => isTeamOnSlate(inj.team, slateTeams));
  const relevant = onSlate.filter((inj) => relevanceFn(inj));
  const scoped = opts.decisionOnly ? relevant : onSlate;

  const teamSet = new Set<string>();
  for (const inj of scoped) teamSet.add(inj.team);

  // Stable severity-then-name ordering so the wire reads worst-first.
  const sortFn = (a: T, b: T) =>
    tierWeight(a.status) - tierWeight(b.status) ||
    a.team.localeCompare(b.team) ||
    a.player.localeCompare(b.player);

  return {
    scoped: [...scoped].sort(sortFn),
    relevant: [...relevant].sort(sortFn),
    teamsPlaying: [...teamSet].sort(),
  };
}

// Filter an injury list to an explicit pair/list of teams (used by the agent
// tool when the analyst passes the matchup it's evaluating). Returns only
// decision-relevant players by default — that's what moves a moneyline.
export function injuriesForTeams<T extends ScopeInjury>(
  injuries: T[],
  teams: string[],
  opts: { decisionOnly?: boolean; league?: string } = { decisionOnly: true }
): T[] {
  const wanted = teams.filter(Boolean);
  if (wanted.length === 0) return [];
  const relevanceFn = (inj: ScopeInjury) =>
    opts.league ? isRelevantForLeague(opts.league, inj) : isDecisionRelevant(inj.status);
  const filtered = injuries.filter((inj) => wanted.some((t) => matchTeam(inj.team, t)));
  const out = opts.decisionOnly === false ? filtered : filtered.filter((i) => relevanceFn(i));
  return [...out].sort(
    (a, b) =>
      tierWeight(a.status) - tierWeight(b.status) ||
      a.team.localeCompare(b.team) ||
      a.player.localeCompare(b.player)
  );
}
