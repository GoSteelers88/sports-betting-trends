// Shared helpers for fetching ESPN box scores and resolving player-prop
// outcomes. Extracted from snapshot-grader.ts so the AgentPick autograder
// and the prop projection engine can reuse the same player-stat lookup
// logic — there's exactly one ESPN parser in the codebase.

export type Espn = {
  events?: EspnEvent[];
};

export type EspnEvent = {
  id: string;
  date?: string;
  status?: { type?: { completed?: boolean } };
  competitions?: Array<{
    competitors?: Array<{
      homeAway?: "home" | "away";
      score?: string;
      team?: { displayName?: string; shortDisplayName?: string; abbreviation?: string };
    }>;
  }>;
};

export type EspnAthleteStat = {
  athletes?: Array<{
    athlete?: { displayName?: string };
    stats?: string[]; // values aligned with parent.labels
  }>;
  labels?: string[];
  names?: string[];
  keys?: string[];
};

export type EspnSummary = {
  boxscore?: {
    players?: Array<{
      team?: { displayName?: string; abbreviation?: string };
      statistics?: EspnAthleteStat[];
    }>;
  };
};

export const PROP_GRADING_LEAGUES = ["NBA", "MLB"] as const;
export type PropGradingLeague = (typeof PROP_GRADING_LEAGUES)[number];

export const SCOREBOARD: Record<PropGradingLeague, string> = {
  NBA: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",
  MLB: "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard",
};

export const SUMMARY: Record<PropGradingLeague, string> = {
  NBA: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary",
  MLB: "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/summary",
};

// 36-hour proximity gate — picks anchored to one snapshot date can only
// resolve against ESPN games whose date is within this window. Stops MLB
// series and NBA back-to-backs from mis-grading against the wrong day.
export const PROP_PROXIMITY_MS = 36 * 60 * 60 * 1000;

// Map our prop market keys to a function over the player's stat map.
// The lookup table here is the single source of truth — the projector,
// the snapshot grader, and the autograder all consult this same map.
export const PROP_STAT_MAP: Record<string, (stats: Map<string, number>) => number | null> = {
  // NBA
  player_points: s => s.get("PTS") ?? null,
  player_rebounds: s => s.get("REB") ?? null,
  player_assists: s => s.get("AST") ?? null,
  player_threes: s => s.get("3PM") ?? s.get("3FG") ?? null,
  player_blocks: s => s.get("BLK") ?? null,
  player_steals: s => s.get("STL") ?? null,
  player_turnovers: s => s.get("TO") ?? null,
  player_points_rebounds_assists: s => sumOrNull([s.get("PTS"), s.get("REB"), s.get("AST")]),
  player_points_rebounds: s => sumOrNull([s.get("PTS"), s.get("REB")]),
  player_points_assists: s => sumOrNull([s.get("PTS"), s.get("AST")]),
  player_rebounds_assists: s => sumOrNull([s.get("REB"), s.get("AST")]),
  player_blocks_steals: s => sumOrNull([s.get("BLK"), s.get("STL")]),
  // MLB batters
  batter_hits: s => s.get("H") ?? null,
  batter_home_runs: s => s.get("HR") ?? null,
  batter_rbis: s => s.get("RBI") ?? null,
  batter_runs_scored: s => s.get("R") ?? null,
  // Batter strikeouts share the "K" box-score label with pitcher strikeouts.
  // The two blocks differ: the PITCHING block carries an "IP" (innings) label,
  // the BATTING block does not. We attribute "K" to the batter ONLY when there
  // is no IP in the same stat map, and to the pitcher ONLY when IP is present —
  // so a pitcher's batting-K and a batter's K never cross-contaminate.
  batter_strikeouts: s => (s.has("IP") ? null : s.get("K") ?? null),
  // Total Bases: ESPN's MLB box exposes H and HR but NOT 2B/3B, so an exact TB
  // is unavailable from this feed. If a "TB" label ever appears we use it;
  // otherwise this returns null and the projector SYNTHESIZES TB from H + HR
  // (see prop-projector.ts). We deliberately do NOT fabricate a TB here so the
  // grader (which needs the TRUE outcome) never grades against an estimate.
  batter_total_bases: s => s.get("TB") ?? null,
  // MLB pitchers — gated on IP so a batter's "K" is never read as a pitcher's.
  pitcher_strikeouts: s => (s.has("IP") ? s.get("K") ?? null : null),
  pitcher_earned_runs: s => s.get("ER") ?? null,
};

export function sumOrNull(parts: Array<number | undefined>): number | null {
  if (parts.some(p => p === undefined)) return null;
  return (parts as number[]).reduce((a, b) => a + b, 0);
}

export function yyyymmdd(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

// Common name suffixes ("Jr.", "II", etc.) shouldn't break matches.
const NAME_SUFFIX_RE = /\b(jr|sr|ii|iii|iv|v)\b/g;

export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .replace(/[.'-]/g, "")
    .replace(NAME_SUFFIX_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Token-aware team matcher — avoids "New York" matching both Yankees + Mets.
export function teamMatches(needle: string, hay: string): boolean {
  const a = normalizeName(needle);
  const b = normalizeName(hay);
  if (!a || !b) return false;
  if (a === b) return true;
  const tokensA = a.split(/\s+/).filter(t => t.length >= 4);
  const tokensB = b.split(/\s+/).filter(t => t.length >= 4);
  if (tokensA.length === 0 || tokensB.length === 0) {
    return a.includes(b) || b.includes(a);
  }
  const [need, have] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  const haveSet = new Set(have);
  return need.every(t => haveSet.has(t));
}

export async function fetchJson<T>(url: string, timeoutMs = 12_000): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "sports-betting-trends-grader/1.0" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// Per-event player stat lookup. Each player maps to one or more entries,
// each carrying the event date so callers can pick the right game when
// the same player appeared on multiple days inside the lookup window.
export type PlayerStatEntry = { eventDate: number; stats: Map<string, number> };
export type PlayerStatLookup = { byPlayer: Map<string, PlayerStatEntry[]> };

// Build a player-stat lookup spanning ±1 day around `yyyymmddDate`. Used
// for both grading (resolve a prop against its game) and projection
// (build a rolling history). For larger windows, call buildPlayerStatLookupRange.
export async function buildPlayerStatLookup(
  league: PropGradingLeague,
  yyyymmddDate: string
): Promise<PlayerStatLookup> {
  const base = parseYyyymmdd(yyyymmddDate);
  const dates = [-1, 0, 1].map(offset =>
    yyyymmdd(new Date(base.getTime() + offset * 24 * 60 * 60 * 1000))
  );
  return buildPlayerStatLookupForDates(league, dates);
}

// Multi-day variant — fetches scoreboard+summary for an arbitrary list of
// YYYYMMDD dates. Used by the game-log ingester to assemble rolling history.
export async function buildPlayerStatLookupForDates(
  league: PropGradingLeague,
  dates: string[]
): Promise<PlayerStatLookup> {
  const lookup: PlayerStatLookup = { byPlayer: new Map() };
  const seenEvents = new Set<string>();
  const events: EspnEvent[] = [];
  for (const d of dates) {
    const board = await fetchJson<Espn>(`${SCOREBOARD[league]}?dates=${d}`);
    for (const ev of board?.events ?? []) {
      if (seenEvents.has(ev.id)) continue;
      seenEvents.add(ev.id);
      events.push(ev);
    }
  }

  for (const ev of events) {
    if (!ev.status?.type?.completed) continue;
    const eventDate = ev.date ? new Date(ev.date).getTime() : NaN;
    if (!Number.isFinite(eventDate)) continue;
    const summary = await fetchJson<EspnSummary>(`${SUMMARY[league]}?event=${ev.id}`);
    if (!summary?.boxscore?.players) continue;

    for (const teamBlock of summary.boxscore.players) {
      for (const stat of teamBlock.statistics ?? []) {
        const labels = stat.labels ?? [];
        for (const ath of stat.athletes ?? []) {
          const name = ath.athlete?.displayName;
          const stats = ath.stats ?? [];
          if (!name || stats.length === 0) continue;
          const norm = normalizeName(name);
          const statMap = new Map<string, number>();
          for (let i = 0; i < Math.min(labels.length, stats.length); i++) {
            const label = labels[i];
            const raw = stats[i];
            const num = parseFloat(raw);
            if (Number.isFinite(num)) statMap.set(label, num);
          }
          if (statMap.size === 0) continue;
          const list = lookup.byPlayer.get(norm) ?? [];
          list.push({ eventDate, stats: statMap });
          lookup.byPlayer.set(norm, list);
        }
      }
    }
  }
  return lookup;
}

function parseYyyymmdd(s: string): Date {
  return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`);
}

// Resolve one prop pick against a player stat lookup. Returns null if no
// game matched within the proximity window (caller should mark unmatched).
export type PropResolveInput = {
  player: string;
  propType: string;
  line: number;
  side: "over" | "under";
  // Anchor — the snapshotDate (UTC midnight) or createdAt of the pick.
  anchorMs: number;
};

export type PropResolveOutput = {
  actual: number;
  result: "win" | "loss" | "push";
};

export function resolveProp(
  lookup: PlayerStatLookup,
  input: PropResolveInput
): PropResolveOutput | null {
  const entries = lookup.byPlayer.get(normalizeName(input.player));
  if (!entries || entries.length === 0) return null;
  const compute = PROP_STAT_MAP[input.propType];
  if (!compute) return null;

  let best: PlayerStatEntry | null = null;
  let bestDiff = Infinity;
  for (const e of entries) {
    const diff = Math.abs(e.eventDate - input.anchorMs);
    if (diff < PROP_PROXIMITY_MS && diff < bestDiff) {
      best = e;
      bestDiff = diff;
    }
  }
  if (!best) return null;
  const actual = compute(best.stats);
  if (actual === null) return null;

  let result: "win" | "loss" | "push";
  if (actual === input.line) result = "push";
  else if (input.side === "over") result = actual > input.line ? "win" : "loss";
  else result = actual < input.line ? "win" : "loss";

  return { actual, result };
}

// Probability via standard normal CDF — used by the projector to convert
// a (mean, stddev, line) tuple into modelProb_over. Abramowitz-Stegun
// approximation, max error ~7.5e-8.
export function normalCdf(x: number, mean: number, stddev: number): number {
  if (stddev <= 0) return x >= mean ? 1 : 0;
  const z = (x - mean) / (stddev * Math.SQRT2);
  return 0.5 * (1 + erf(z));
}

function erf(x: number): number {
  // Abramowitz & Stegun 7.1.26
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-a * a);
  return sign * y;
}
