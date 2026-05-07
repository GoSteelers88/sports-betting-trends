// Grades ModelPickSnapshot rows by fetching final scores + box scores from
// ESPN's public scoreboard/summary endpoints. Idempotent — only grades rows
// where `result` is null and the game is completed.

import { prisma } from "./prisma";

type Espn = {
  events?: EspnEvent[];
};

type EspnEvent = {
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

type EspnAthleteStat = {
  athletes?: Array<{
    athlete?: { displayName?: string };
    stats?: string[]; // values aligned with parent.labels
  }>;
  labels?: string[];
  names?: string[];
  keys?: string[];
};

type EspnSummary = {
  boxscore?: {
    players?: Array<{
      team?: { displayName?: string; abbreviation?: string };
      statistics?: EspnAthleteStat[];
    }>;
  };
};

const SCOREBOARD: Record<"NBA" | "MLB", string> = {
  NBA: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",
  MLB: "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard",
};

const SUMMARY: Record<"NBA" | "MLB", string> = {
  NBA: "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary",
  MLB: "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/summary",
};

// Map our prop market keys to ESPN box-score stat labels (or sum-of)
const PROP_STAT_MAP: Record<string, (stats: Map<string, number>) => number | null> = {
  // NBA
  player_points:           s => s.get("PTS") ?? null,
  player_rebounds:         s => s.get("REB") ?? null,
  player_assists:          s => s.get("AST") ?? null,
  player_threes:           s => s.get("3PM") ?? s.get("3FG") ?? null,
  player_blocks:           s => s.get("BLK") ?? null,
  player_steals:           s => s.get("STL") ?? null,
  player_turnovers:        s => s.get("TO") ?? null,
  player_points_rebounds_assists: s => sumOrNull([s.get("PTS"), s.get("REB"), s.get("AST")]),
  player_points_rebounds:  s => sumOrNull([s.get("PTS"), s.get("REB")]),
  player_points_assists:   s => sumOrNull([s.get("PTS"), s.get("AST")]),
  player_rebounds_assists: s => sumOrNull([s.get("REB"), s.get("AST")]),
  player_blocks_steals:    s => sumOrNull([s.get("BLK"), s.get("STL")]),
  // MLB batters (ESPN labels: H, HR, RBI, R, TB)
  batter_hits:             s => s.get("H") ?? null,
  batter_home_runs:        s => s.get("HR") ?? null,
  batter_rbis:             s => s.get("RBI") ?? null,
  batter_runs_scored:      s => s.get("R") ?? null,
  batter_total_bases:      s => s.get("TB") ?? null,
  // MLB pitchers (ESPN labels: K, ER)
  pitcher_strikeouts:      s => s.get("K") ?? null,
  pitcher_earned_runs:     s => s.get("ER") ?? null,
};

// MLB summary endpoint returns "boxscore" with separate batting / pitching
// stat groups. Both share the same statistics[] structure as NBA.

function sumOrNull(parts: Array<number | undefined>): number | null {
  if (parts.some(p => p === undefined)) return null;
  return (parts as number[]).reduce((a, b) => a + b, 0);
}

function yyyymmdd(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

// Common name suffixes to strip so "Jr." / "II" / "III" don't break matches.
const NAME_SUFFIX_RE = /\b(jr|sr|ii|iii|iv|v)\b/g;

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics (was a literal-char bug)
    .replace(/[.'-]/g, "")
    .replace(NAME_SUFFIX_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Token-aware team matcher. Avoids the "New York" → both Yankees AND Mets
// false-positive that bidirectional `includes` produces. Requires every
// non-trivial token from the shorter side to be present in the longer side.
function teamMatches(needle: string, hay: string): boolean {
  const a = normalizeName(needle);
  const b = normalizeName(hay);
  if (!a || !b) return false;
  if (a === b) return true;

  const tokensA = a.split(/\s+/).filter(t => t.length >= 4);
  const tokensB = b.split(/\s+/).filter(t => t.length >= 4);
  if (tokensA.length === 0 || tokensB.length === 0) {
    // Falls back to substring only when we have nothing to tokenize on
    return a.includes(b) || b.includes(a);
  }

  // Use the shorter token set as the "must match" — every one of those tokens
  // must appear (whole-word) in the other side.
  const [need, have] = tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];
  const haveSet = new Set(have);
  return need.every(t => haveSet.has(t));
}

async function fetchJson<T>(url: string, ms = 12_000): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "sports-betting-trends-grader/1.0" },
      signal: AbortSignal.timeout(ms),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ─── unit P&L ──────────────────────────────────────────────────────────────

function unitsPnl(american: number | null, stake: number, result: string): number | null {
  if (american === null) return null;
  if (result === "win") {
    const decimal = american > 0 ? american / 100 : 100 / -american;
    return +(stake * decimal).toFixed(4);
  }
  if (result === "loss") return -stake;
  if (result === "push" || result === "void") return 0;
  return null;
}

// ─── prop grading ──────────────────────────────────────────────────────────

// Per-event player stat lookup so we can pick the right game when a player
// played in multiple games inside the ±1 day fetch window.
type PlayerStatLookup = {
  // normalized name → array of (event date, stat label → value) entries
  byPlayer: Map<string, Array<{ eventDate: number; stats: Map<string, number> }>>;
};

async function buildPlayerStatLookup(
  league: "NBA" | "MLB",
  yyyymmddDate: string
): Promise<PlayerStatLookup> {
  const lookup: PlayerStatLookup = { byPlayer: new Map() };
  // Query ±1 day to cover ET/UTC boundary slip on late-night games.
  const base = new Date(
    `${yyyymmddDate.slice(0, 4)}-${yyyymmddDate.slice(4, 6)}-${yyyymmddDate.slice(6, 8)}T00:00:00Z`
  );
  const dates = [-1, 0, 1].map(offset => {
    const d = new Date(base.getTime() + offset * 24 * 60 * 60 * 1000);
    return yyyymmdd(d);
  });
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

async function gradeProps(daysBack: number): Promise<{ graded: number; unmatched: number }> {
  const target = new Date();
  target.setUTCDate(target.getUTCDate() - daysBack);
  const yyyymmddDate = yyyymmdd(target);
  const since = new Date(target);
  since.setUTCDate(since.getUTCDate() - 2);

  // Both NBA and MLB props get graded — different stat lookups per league.
  const pending = await prisma.modelPickSnapshot.findMany({
    where: {
      source: { in: ["prop_nba", "prop_mlb"] },
      result: null,
      createdAt: { gte: since },
    },
  });
  if (pending.length === 0) return { graded: 0, unmatched: 0 };

  const nbaLookup = pending.some(p => p.source === "prop_nba")
    ? await buildPlayerStatLookup("NBA", yyyymmddDate)
    : { byPlayer: new Map() };
  const mlbLookup = pending.some(p => p.source === "prop_mlb")
    ? await buildPlayerStatLookup("MLB", yyyymmddDate)
    : { byPlayer: new Map() };
  let graded = 0;
  let unmatched = 0;

  // 36-hour proximity: prop snapshots are anchored to snapshotDate (or
  // createdAt if missing), and we pick the player's game whose ESPN date is
  // closest within the window — handles back-to-backs and DH situations.
  const PROXIMITY_MS = 36 * 60 * 60 * 1000;

  for (const p of pending) {
    if (!p.player || p.line === null || !p.market) {
      unmatched++;
      continue;
    }
    const lookup = p.source === "prop_mlb" ? mlbLookup : nbaLookup;
    const allEntries = lookup.byPlayer.get(normalizeName(p.player));
    if (!allEntries || allEntries.length === 0) {
      unmatched++;
      continue;
    }
    const compute = PROP_STAT_MAP[p.market];
    if (!compute) {
      unmatched++;
      continue;
    }
    const anchor = p.snapshotDate
      ? new Date(`${p.snapshotDate}T12:00:00Z`).getTime()
      : p.createdAt.getTime();
    // Pick the game whose date is closest to the anchor and within 36h
    let best: (typeof allEntries)[number] | null = null;
    let bestDiff = Infinity;
    for (const e of allEntries) {
      const diff = Math.abs(e.eventDate - anchor);
      if (diff < PROXIMITY_MS && diff < bestDiff) {
        best = e;
        bestDiff = diff;
      }
    }
    if (!best) {
      unmatched++;
      continue;
    }
    const actual = compute(best.stats);
    if (actual === null) {
      unmatched++;
      continue;
    }

    const side = /^over\b/i.test(p.selection.trim()) ? "over" : "under";
    let result: "win" | "loss" | "push";
    if (actual === p.line) result = "push";
    else if (side === "over") result = actual > p.line ? "win" : "loss";
    else result = actual < p.line ? "win" : "loss";

    const stake = 1; // 1 unit per prop snapshot for tracking purposes
    const pnl = unitsPnl(p.oddsAmerican, stake, result);

    await prisma.modelPickSnapshot.update({
      where: { id: p.id },
      data: {
        result,
        actualValue: actual,
        notes: `auto-graded vs ESPN box: ${p.player} ${actual} ${side === "over" ? ">" : "<"} ${p.line}`,
        gradedAt: new Date(),
      },
    });
    void pnl; // P&L stored on AgentOutcome only; ModelPickSnapshot tracks per-pick result
    graded++;
  }
  return { graded, unmatched };
}

// ─── market grading (team-level, like moneylines) ──────────────────────────

async function gradeMarketPicks(daysBack: number): Promise<{ graded: number; unmatched: number }> {
  const target = new Date();
  target.setUTCDate(target.getUTCDate() - daysBack);
  const yyyymmddDate = yyyymmdd(target);
  const since = new Date(target);
  since.setUTCDate(since.getUTCDate() - 2);

  // For now we only auto-grade moneyline picks. Spread/total grading needs the
  // line at-bet-time and the actual final score deltas — added in a follow-up.
  const pending = await prisma.modelPickSnapshot.findMany({
    where: {
      source: "market",
      result: null,
      market: "moneyline",
      createdAt: { gte: since },
    },
  });
  if (pending.length === 0) return { graded: 0, unmatched: 0 };

  // Determine final scores by league. Query ±1 day to cover ET/UTC boundary slip.
  const base = new Date(
    `${yyyymmddDate.slice(0, 4)}-${yyyymmddDate.slice(4, 6)}-${yyyymmddDate.slice(6, 8)}T00:00:00Z`
  );
  const dates = [-1, 0, 1].map(offset => {
    const d = new Date(base.getTime() + offset * 24 * 60 * 60 * 1000);
    return yyyymmdd(d);
  });
  const byLeague: Record<string, EspnEvent[]> = {};
  for (const lg of new Set(pending.map(p => p.league))) {
    if (lg !== "NBA" && lg !== "MLB") continue;
    const seen = new Set<string>();
    const events: EspnEvent[] = [];
    for (const d of dates) {
      const board = await fetchJson<Espn>(`${SCOREBOARD[lg as "NBA" | "MLB"]}?dates=${d}`);
      for (const ev of board?.events ?? []) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        if (ev.status?.type?.completed) events.push(ev);
      }
    }
    byLeague[lg] = events;
  }

  let graded = 0;
  let unmatched = 0;

  // 36-hour proximity window to prevent repeat-matchups (MLB series, NBA b2b)
  // from being graded against the wrong day's score.
  const PROXIMITY_MS = 36 * 60 * 60 * 1000;

  for (const p of pending) {
    const events = byLeague[p.league] ?? [];
    // Anchor to snapshotDate (logged when the pick was generated) for the
    // proximity check; fall back to createdAt if snapshotDate is missing.
    const anchor = p.snapshotDate
      ? new Date(`${p.snapshotDate}T12:00:00Z`).getTime()
      : p.createdAt.getTime();
    const match = events.find(ev => {
      const competitors = ev.competitions?.[0]?.competitors ?? [];
      const home = competitors.find(c => c.homeAway === "home")?.team?.displayName ?? "";
      const away = competitors.find(c => c.homeAway === "away")?.team?.displayName ?? "";
      const teamOk =
        teamMatches(home, p.selection) ||
        teamMatches(away, p.selection) ||
        (p.matchup &&
          (teamMatches(home, p.matchup) || teamMatches(away, p.matchup)));
      if (!teamOk) return false;
      if (!ev.date) return true;
      const ft = new Date(ev.date).getTime();
      if (!Number.isFinite(ft)) return true;
      return Math.abs(ft - anchor) < PROXIMITY_MS;
    });
    if (!match) {
      unmatched++;
      continue;
    }
    const competitors = match.competitions?.[0]?.competitors ?? [];
    const home = competitors.find(c => c.homeAway === "home");
    const away = competitors.find(c => c.homeAway === "away");
    const homeScore = parseInt(home?.score ?? "", 10);
    const awayScore = parseInt(away?.score ?? "", 10);
    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) {
      unmatched++;
      continue;
    }

    const homeName = home?.team?.displayName ?? "";
    const awayName = away?.team?.displayName ?? "";
    const pickedHome = teamMatches(homeName, p.selection);
    const pickedAway = teamMatches(awayName, p.selection);
    if (!pickedHome && !pickedAway) {
      unmatched++;
      continue;
    }
    const homeWon = homeScore > awayScore;
    const result: "win" | "loss" | "push" =
      homeScore === awayScore ? "push" : (pickedHome ? (homeWon ? "win" : "loss") : (homeWon ? "loss" : "win"));

    await prisma.modelPickSnapshot.update({
      where: { id: p.id },
      data: {
        result,
        actualValue: pickedHome ? homeScore - awayScore : awayScore - homeScore,
        notes: `auto-graded vs ESPN final: ${awayName} ${awayScore} @ ${homeName} ${homeScore}`,
        gradedAt: new Date(),
      },
    });
    graded++;
  }
  return { graded, unmatched };
}

// ─── orchestrator ──────────────────────────────────────────────────────────

export type SnapshotGradeReport = {
  ranAt: string;
  daysBack: number;
  propsGraded: number;
  propsUnmatched: number;
  marketGraded: number;
  marketUnmatched: number;
};

export async function gradeAllSnapshots(daysBack = 1): Promise<SnapshotGradeReport> {
  const props = await gradeProps(daysBack);
  const market = await gradeMarketPicks(daysBack);
  return {
    ranAt: new Date().toISOString(),
    daysBack,
    propsGraded: props.graded,
    propsUnmatched: props.unmatched,
    marketGraded: market.graded,
    marketUnmatched: market.unmatched,
  };
}
