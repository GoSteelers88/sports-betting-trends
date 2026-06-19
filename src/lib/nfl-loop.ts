// nfl-loop.ts — core of the private NFL Backtest Learning Loop.
//
// Pure + tested: parse the nflverse games.csv spine, build the BLIND model input
// (pre-game fields only — see the no-leakage guarantee in NFL_LOOP_SPEC.md),
// grade picks against real results, compute the full stat record from the graded
// log, and manage the season/week cursor.
//
// All state is JSON/JSONL/CSV under data/private/nfl-loop/ — no DB, no migration,
// kept quiet. The stat record is DERIVED from the picks log so nothing can drift.
//
// The impure Claude calls live in nfl-agent.ts; the runner is scripts/nfl-week.ts.

import fs from "node:fs";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

export function defaultStateDir(): string {
  return path.join(process.cwd(), "data", "private", "nfl-loop");
}

export function gamesCsvPath(dir: string): string {
  return path.join(dir, "games.csv");
}
export function injuriesCsvPath(dir: string): string {
  return path.join(dir, "injuries.csv");
}
export function cursorPath(dir: string): string {
  return path.join(dir, "cursor.json");
}
export function picksLogPath(dir: string): string {
  return path.join(dir, "picks-log.jsonl");
}
export function lessonsDir(dir: string): string {
  return path.join(dir, "lessons");
}
export function lessonsCurrentPath(dir: string): string {
  return path.join(lessonsDir(dir), "lessons-current.md");
}

// ─────────────────────────────────────────────────────────────────────────────
// The nflverse game row (the spine)
// ─────────────────────────────────────────────────────────────────────────────

export type GameType = "REG" | "POST";

/** A parsed nflverse games.csv row. Strings stay strings; numerics are numbers
 *  or null when the source cell is empty. */
export type GameRow = {
  gameId: string;
  season: number;
  gameType: GameType;
  week: number;
  gameday: string; // YYYY-MM-DD
  gametime: string; // HH:MM (may be empty)
  awayTeam: string;
  homeTeam: string;
  // pre-game market
  spreadLine: number | null; // home spread (negative = home favored)
  totalLine: number | null;
  awayMoneyline: number | null;
  homeMoneyline: number | null;
  overOdds: number | null;
  underOdds: number | null;
  // pre-game context
  awayRest: number | null;
  homeRest: number | null;
  divGame: boolean | null;
  roof: string;
  surface: string;
  temp: number | null;
  wind: number | null;
  awayQb: string;
  homeQb: string;
  awayCoach: string;
  homeCoach: string;
  referee: string;
  stadium: string;
  // POST-GAME (results) — NEVER allowed into the blind input
  awayScore: number | null;
  homeScore: number | null;
  result: number | null; // home margin (home - away)
  total: number | null; // actual combined points
};

// ─── CSV parsing (RFC-4180-ish: quotes + escaped quotes; nflverse is plain) ───

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      // swallow — handled by the following \n
    } else {
      field += c;
    }
  }
  // trailing field / row (no final newline)
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function num(v: string | undefined): number | null {
  if (v == null) return null;
  const t = v.trim();
  if (t === "" || t === "NA" || t === "NaN") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function bool(v: string | undefined): boolean | null {
  const n = num(v);
  if (n == null) return null;
  return n === 1;
}

function str(v: string | undefined): string {
  return (v ?? "").trim();
}

// nflverse labels postseason rounds individually (WC=wildcard, DIV=divisional,
// CON=conference, SB=Super Bowl), not as a single "POST". We fold all four into
// the POST phase; the source week numbers (19→22) preserve chronological order.
const POST_ROUNDS = new Set(["POST", "WC", "DIV", "CON", "SB"]);

function normalizeGameType(raw: string): GameType | null {
  if (raw === "REG") return "REG";
  if (POST_ROUNDS.has(raw)) return "POST";
  return null;
}

/** Parse the full games.csv into GameRow[], keeping only REG/POST rows. */
export function parseGames(csvText: string): GameRow[] {
  const matrix = parseCsv(csvText);
  if (matrix.length === 0) return [];
  const header = matrix[0].map((h) => h.trim());
  const idx = new Map<string, number>();
  header.forEach((h, i) => idx.set(h, i));
  const col = (r: string[], name: string): string | undefined => {
    const i = idx.get(name);
    return i == null ? undefined : r[i];
  };

  const out: GameRow[] = [];
  for (let r = 1; r < matrix.length; r++) {
    const row = matrix[r];
    if (!row || row.length === 0 || (row.length === 1 && row[0] === "")) continue;
    const gameType = normalizeGameType(str(col(row, "game_type")));
    if (gameType == null) continue;
    const season = num(col(row, "season"));
    const week = num(col(row, "week"));
    const gameId = str(col(row, "game_id"));
    if (!gameId || season == null || week == null) continue;
    out.push({
      gameId,
      season,
      gameType,
      week,
      gameday: str(col(row, "gameday")),
      gametime: str(col(row, "gametime")),
      awayTeam: str(col(row, "away_team")),
      homeTeam: str(col(row, "home_team")),
      spreadLine: num(col(row, "spread_line")),
      totalLine: num(col(row, "total_line")),
      awayMoneyline: num(col(row, "away_moneyline")),
      homeMoneyline: num(col(row, "home_moneyline")),
      overOdds: num(col(row, "over_odds")),
      underOdds: num(col(row, "under_odds")),
      awayRest: num(col(row, "away_rest")),
      homeRest: num(col(row, "home_rest")),
      divGame: bool(col(row, "div_game")),
      roof: str(col(row, "roof")),
      surface: str(col(row, "surface")),
      temp: num(col(row, "temp")),
      wind: num(col(row, "wind")),
      awayQb: str(col(row, "away_qb_name")),
      homeQb: str(col(row, "home_qb_name")),
      awayCoach: str(col(row, "away_coach")),
      homeCoach: str(col(row, "home_coach")),
      referee: str(col(row, "referee")),
      stadium: str(col(row, "stadium")),
      awayScore: num(col(row, "away_score")),
      homeScore: num(col(row, "home_score")),
      result: num(col(row, "result")),
      total: num(col(row, "total")),
    });
  }
  return out;
}

export function loadGames(dir: string): GameRow[] {
  const p = gamesCsvPath(dir);
  if (!fs.existsSync(p)) {
    throw new Error(
      `games.csv not found at ${p}. Run \`npm run nfl:ingest\` first.`,
    );
  }
  return parseGames(fs.readFileSync(p, "utf8"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Injury reports (nflverse weekly injury release) — a PRE-GAME source.
//
// Injury reports are published before kickoff, so attaching them to the blind
// input is NOT look-ahead. We still keep the no-leakage discipline strict: only
// report fields (player / position / status / injury) survive parsing, and the
// CSV carries no scores/results at all. The (season, phase, week, team) key uses
// the SAME normalization as games.csv — WC/DIV/CON/SB fold into POST with week
// numbers 19→22 preserved — so a game's slot matches its teams' injury slot.
// ─────────────────────────────────────────────────────────────────────────────

export type ReportStatus = "Out" | "Doubtful" | "Questionable" | "None";

/** One parsed injury-report row, already reduced to the report-only allowlist.
 *  Nothing post-game can appear here — the source CSV has no result columns. */
export type InjuryRow = {
  season: number;
  gameType: GameType; // normalized (POST folds WC/DIV/CON/SB)
  week: number;
  team: string;
  player: string;
  position: string;
  status: ReportStatus;
  injury: string; // report_primary_injury (+ secondary when present)
};

/** What the model sees per injured player — the report-only shape. Deliberately
 *  minimal; identical fields to InjuryRow minus the routing keys. */
export type BlindInjury = {
  player: string;
  position: string;
  status: ReportStatus;
  injury: string;
};

function normalizeStatus(raw: string): ReportStatus {
  const s = raw.trim().toLowerCase();
  if (s === "out") return "Out";
  if (s === "doubtful") return "Doubtful";
  if (s === "questionable") return "Questionable";
  return "None"; // blank/probable/other — keep the row, mark it undesignated
}

/** Parse a (possibly multi-season concatenated) nflverse injuries CSV into the
 *  report-only InjuryRow[]. Reuses the RFC-4180 parser because the source quotes
 *  fields that contain commas (injury descriptions). Header is detected per the
 *  `season,game_type,team,week,...` row, so concatenated season files (each with
 *  their own header) parse cleanly — extra header rows are skipped as non-data. */
export function parseInjuries(csvText: string): InjuryRow[] {
  const matrix = parseCsv(csvText);
  if (matrix.length === 0) return [];

  let idx: Map<string, number> | null = null;
  const out: InjuryRow[] = [];

  for (const row of matrix) {
    if (!row || row.length === 0 || (row.length === 1 && row[0] === "")) continue;
    // A header row re-establishes the column map (handles concatenated files).
    if (row[0]?.trim() === "season" && row.includes("report_status")) {
      idx = new Map();
      row.forEach((h, i) => idx!.set(h.trim(), i));
      continue;
    }
    if (!idx) continue; // data before any header — ignore
    const col = (name: string): string | undefined => {
      const i = idx!.get(name);
      return i == null ? undefined : row[i];
    };
    const gameType = normalizeGameType(str(col("game_type")));
    if (gameType == null) continue;
    const season = num(col("season"));
    const week = num(col("week"));
    const team = str(col("team"));
    const player = str(col("full_name"));
    if (season == null || week == null || !team || !player) continue;

    const primary = str(col("report_primary_injury"));
    const secondary = str(col("report_secondary_injury"));
    const injury = [primary, secondary].filter(Boolean).join(" / ");

    out.push({
      season,
      gameType,
      week,
      team,
      player,
      position: str(col("position")),
      status: normalizeStatus(str(col("report_status"))),
      injury,
    });
  }
  return out;
}

/** Load the cached injuries CSV. Returns [] when absent so the loop degrades
 *  gracefully (the no-key `report` path and tests never need the file). */
export function loadInjuries(dir: string): InjuryRow[] {
  const p = injuriesCsvPath(dir);
  if (!fs.existsSync(p)) return [];
  return parseInjuries(fs.readFileSync(p, "utf8"));
}

/** Index injuries by `${season}|${phase}|${week}|${team}` for O(1) per-game
 *  scoping. Sorted within a team by status severity (Out → Doubtful →
 *  Questionable → None) so the most decision-relevant rows lead. */
export function indexInjuries(rows: InjuryRow[]): Map<string, BlindInjury[]> {
  const rank: Record<ReportStatus, number> = {
    Out: 0,
    Doubtful: 1,
    Questionable: 2,
    None: 3,
  };
  const map = new Map<string, BlindInjury[]>();
  for (const r of rows) {
    const k = `${r.season}|${r.gameType}|${r.week}|${r.team}`;
    let list = map.get(k);
    if (!list) {
      list = [];
      map.set(k, list);
    }
    list.push({
      player: r.player,
      position: r.position,
      status: r.status,
      injury: r.injury,
    });
  }
  for (const list of map.values()) {
    list.sort((a, b) => {
      const d = rank[a.status] - rank[b.status];
      return d !== 0 ? d : a.player.localeCompare(b.player);
    });
  }
  return map;
}

function injuryKey(season: number, phase: GameType, week: number, team: string): string {
  return `${season}|${phase}|${week}|${team}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Season / week ordering + cursor
// ─────────────────────────────────────────────────────────────────────────────

export const LOOP_SEASONS = [2023, 2024, 2025] as const;
export type LoopSeason = (typeof LOOP_SEASONS)[number];

export type Cursor = {
  season: number;
  phase: GameType;
  week: number;
};

export function defaultCursor(): Cursor {
  return { season: LOOP_SEASONS[0], phase: "REG", week: 1 };
}

export function loadCursor(dir: string): Cursor {
  const p = cursorPath(dir);
  if (!fs.existsSync(p)) return defaultCursor();
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<Cursor>;
    const season = Number(raw.season);
    const week = Number(raw.week);
    const phase = raw.phase === "POST" ? "POST" : "REG";
    if (!Number.isFinite(season) || !Number.isFinite(week)) return defaultCursor();
    return { season, phase, week };
  } catch {
    return defaultCursor();
  }
}

export function saveCursor(dir: string, cursor: Cursor): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cursorPath(dir), JSON.stringify(cursor, null, 2));
}

/** All (phase, week) pairs that actually exist for a season, in chronological
 *  order: every REG week ascending, then every POST week ascending. Derived
 *  from the data so we never assume a fixed 18-week schedule. */
export function weeksForSeason(
  games: GameRow[],
  season: number,
): Array<{ phase: GameType; week: number }> {
  const reg = new Set<number>();
  const post = new Set<number>();
  for (const g of games) {
    if (g.season !== season) continue;
    if (g.gameType === "REG") reg.add(g.week);
    else if (g.gameType === "POST") post.add(g.week);
  }
  const asc = (s: Set<number>) => [...s].sort((a, b) => a - b);
  return [
    ...asc(reg).map((week) => ({ phase: "REG" as const, week })),
    ...asc(post).map((week) => ({ phase: "POST" as const, week })),
  ];
}

/** The flat chronological schedule across all loop seasons. */
export function fullSchedule(
  games: GameRow[],
): Array<{ season: number; phase: GameType; week: number }> {
  const out: Array<{ season: number; phase: GameType; week: number }> = [];
  for (const season of LOOP_SEASONS) {
    for (const w of weeksForSeason(games, season)) {
      out.push({ season, phase: w.phase, week: w.week });
    }
  }
  return out;
}

/** Where in the schedule does the cursor sit? -1 if past the end (caught up). */
export function cursorIndex(
  schedule: Array<{ season: number; phase: GameType; week: number }>,
  cursor: Cursor,
): number {
  return schedule.findIndex(
    (s) =>
      s.season === cursor.season &&
      s.phase === cursor.phase &&
      s.week === cursor.week,
  );
}

/** The cursor for the next populated week, or null when caught up. */
export function nextCursor(games: GameRow[], cursor: Cursor): Cursor | null {
  const schedule = fullSchedule(games);
  const i = cursorIndex(schedule, cursor);
  // If the current cursor isn't a real week (e.g. fresh start before week 1
  // exists, or a stale phase), snap forward to the first scheduled week ≥ it.
  if (i < 0) {
    const fwd = schedule.find(
      (s) =>
        s.season > cursor.season ||
        (s.season === cursor.season &&
          phaseRank(s.phase) > phaseRank(cursor.phase)) ||
        (s.season === cursor.season &&
          s.phase === cursor.phase &&
          s.week >= cursor.week),
    );
    return fwd ? { season: fwd.season, phase: fwd.phase, week: fwd.week } : null;
  }
  const next = schedule[i + 1];
  return next ? { season: next.season, phase: next.phase, week: next.week } : null;
}

function phaseRank(p: GameType): number {
  return p === "REG" ? 0 : 1;
}

/** The games for a given cursor week, chronologically by kickoff then id. */
export function gamesForCursor(games: GameRow[], cursor: Cursor): GameRow[] {
  return games
    .filter(
      (g) =>
        g.season === cursor.season &&
        g.gameType === cursor.phase &&
        g.week === cursor.week,
    )
    .sort((a, b) => {
      const ka = `${a.gameday} ${a.gametime}`;
      const kb = `${b.gameday} ${b.gametime}`;
      return ka === kb ? a.gameId.localeCompare(b.gameId) : ka.localeCompare(kb);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Standings-to-date (computed ONLY from games strictly before this week)
// ─────────────────────────────────────────────────────────────────────────────

export type TeamRecord = {
  team: string;
  wins: number;
  losses: number;
  ties: number;
  pointsFor: number;
  pointsAgainst: number;
};

/** Records for every team in `season`, using only completed games chronologically
 *  before (cursor). REG and POST both count toward the running record. A game
 *  counts only if it has a final score — so this is leak-safe by construction. */
export function standingsBefore(
  games: GameRow[],
  season: number,
  beforePhase: GameType,
  beforeWeek: number,
): Map<string, TeamRecord> {
  const table = new Map<string, TeamRecord>();
  const get = (team: string): TeamRecord => {
    let r = table.get(team);
    if (!r) {
      r = { team, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 };
      table.set(team, r);
    }
    return r;
  };
  const beforeRank = phaseRank(beforePhase);
  for (const g of games) {
    if (g.season !== season) continue;
    // strictly before the target week in (phase, week) order
    const gr = phaseRank(g.gameType);
    const isBefore = gr < beforeRank || (gr === beforeRank && g.week < beforeWeek);
    if (!isBefore) continue;
    if (g.homeScore == null || g.awayScore == null) continue; // not played
    const home = get(g.homeTeam);
    const away = get(g.awayTeam);
    home.pointsFor += g.homeScore;
    home.pointsAgainst += g.awayScore;
    away.pointsFor += g.awayScore;
    away.pointsAgainst += g.homeScore;
    if (g.homeScore > g.awayScore) {
      home.wins++;
      away.losses++;
    } else if (g.homeScore < g.awayScore) {
      away.wins++;
      home.losses++;
    } else {
      home.ties++;
      away.ties++;
    }
  }
  return table;
}

function fmtRecord(r: TeamRecord | undefined): string {
  if (!r) return "0-0";
  const base = `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ""}`;
  return `${base} (PF ${r.pointsFor}, PA ${r.pointsAgainst})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// BLIND model input — PRE-GAME FIELDS ONLY. This is the no-leakage boundary.
// Nothing post-game (score/result/total-actual) may appear here, ever.
// ─────────────────────────────────────────────────────────────────────────────

/** Tokens that must NEVER appear in a serialized blind input. The no-leakage
 *  test asserts against this list; keep it in sync with GameRow's post-game
 *  fields. (We check both the GameRow key names and their CSV-source names.) */
export const FORBIDDEN_LEAK_TOKENS = [
  "awayScore",
  "homeScore",
  "away_score",
  "home_score",
  "result",
  "actualTotal",
  "finalScore",
] as const;

export type BlindGame = {
  gameId: string;
  season: number;
  gameType: GameType;
  week: number;
  kickoff: string; // gameday + gametime
  away: string;
  home: string;
  awayRecord: string;
  homeRecord: string;
  market: {
    spreadLineHome: number | null; // home spread
    totalLine: number | null;
    awayMoneyline: number | null;
    homeMoneyline: number | null;
    overOdds: number | null;
    underOdds: number | null;
  };
  context: {
    awayRest: number | null;
    homeRest: number | null;
    divGame: boolean | null;
    roof: string;
    surface: string;
    temp: number | null;
    wind: number | null;
    awayQb: string;
    homeQb: string;
    awayCoach: string;
    homeCoach: string;
    referee: string;
    stadium: string;
  };
  // Pre-game injury reports, scoped to ONLY this game's two teams for this exact
  // (season, phase, week). Report-only fields — see BlindInjury. Empty arrays
  // when no injury cache is loaded (no-key / offline path).
  injuries: {
    away: BlindInjury[];
    home: BlindInjury[];
  };
};

export type BlindWeek = {
  season: number;
  phase: GameType;
  week: number;
  lessons: string; // the rolling lessons memo injected into the prompt
  games: BlindGame[];
};

/** Build the blind input for the cursor's week. `lessons` is the rolling memo;
 *  `injuries` is the (optional) pre-game injury report set — when omitted, every
 *  game's injury arrays are empty (the offline / no-cache path still works).
 *
 *  This function is the ONLY place that decides which fields the model sees — it
 *  copies an explicit allowlist and never touches the post-game fields. Injuries
 *  are scoped per game to ONLY that game's away_team and home_team for this exact
 *  (season, phase, week); never the whole league. */
export function buildBlindWeek(
  games: GameRow[],
  cursor: Cursor,
  lessons: string,
  injuries: InjuryRow[] = [],
): BlindWeek {
  const slate = gamesForCursor(games, cursor);
  const standings = standingsBefore(games, cursor.season, cursor.phase, cursor.week);
  const injIndex = indexInjuries(injuries);
  const blindGames: BlindGame[] = slate.map((g) => ({
    gameId: g.gameId,
    season: g.season,
    gameType: g.gameType,
    week: g.week,
    kickoff: `${g.gameday}${g.gametime ? ` ${g.gametime}` : ""}`.trim(),
    away: g.awayTeam,
    home: g.homeTeam,
    awayRecord: fmtRecord(standings.get(g.awayTeam)),
    homeRecord: fmtRecord(standings.get(g.homeTeam)),
    market: {
      spreadLineHome: g.spreadLine,
      totalLine: g.totalLine,
      awayMoneyline: g.awayMoneyline,
      homeMoneyline: g.homeMoneyline,
      overOdds: g.overOdds,
      underOdds: g.underOdds,
    },
    context: {
      awayRest: g.awayRest,
      homeRest: g.homeRest,
      divGame: g.divGame,
      roof: g.roof,
      surface: g.surface,
      temp: g.temp,
      wind: g.wind,
      awayQb: g.awayQb,
      homeQb: g.homeQb,
      awayCoach: g.awayCoach,
      homeCoach: g.homeCoach,
      referee: g.referee,
      stadium: g.stadium,
    },
    injuries: {
      away:
        injIndex.get(injuryKey(g.season, g.gameType, g.week, g.awayTeam)) ?? [],
      home:
        injIndex.get(injuryKey(g.season, g.gameType, g.week, g.homeTeam)) ?? [],
    },
  }));
  return {
    season: cursor.season,
    phase: cursor.phase,
    week: cursor.week,
    lessons,
    games: blindGames,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Picks (what the model returns) + graded rows (what we log)
// ─────────────────────────────────────────────────────────────────────────────

export type Side = "home" | "away";
export type Market = "ats" | "moneyline" | "total";

/** The model's per-game pick across all three markets. */
export type GamePick = {
  gameId: string;
  atsSide: Side; // which side it takes ATS
  atsSpreadHome: number; // the home spread it's taking (echo of the line)
  moneylineSide: Side; // who it thinks wins outright
  totalSide: "over" | "under";
  totalLine: number; // the total it's taking (echo of the line)
  confidence: number; // 0-1, applies to the game
  rationale: string; // cites the specific factors driving the picks
  keyFactors: string[]; // auditable list of the factors that moved the picks
};

export type PickResult = "win" | "loss" | "push";

/** One graded market outcome — the atomic row appended to picks-log.jsonl.
 *  Keyed by `${gameId}|${market}` for idempotent upsert. */
export type GradedRow = {
  key: string; // `${gameId}|${market}`
  season: number;
  phase: GameType;
  week: number;
  gameId: string;
  matchup: string; // "AWAY @ HOME"
  market: Market;
  selection: string; // human-readable pick
  side: Side | "over" | "under";
  confidence: number;
  result: PickResult;
  oddsAmerican: number; // the odds the pick was graded at (-110 default)
  pnlUnits: number; // profit/loss in units on a 1u stake
  // dimensions for splits (all pre-game, copied at grade time)
  favored: "favorite" | "underdog" | "pickem"; // for the side the pick is on
  homeAway: Side;
  divGame: boolean;
  dome: boolean;
  restAdvantage: number; // (pick-side rest) - (opponent rest); 0 if unknown
  wind: number | null;
  temp: number | null;
  gradedAt: string;
};

const DEFAULT_ODDS = -110;

export function americanToProfitUnits(odds: number): number {
  // profit on a 1u stake if the bet wins
  if (odds > 0) return odds / 100;
  return 100 / Math.abs(odds);
}

// ─── Grading primitives (pure) ───────────────────────────────────────────────

/** Grade an ATS pick. spreadHome is the home line (negative = home favored).
 *  result is the home margin (home - away). */
export function gradeAts(
  side: Side,
  spreadHome: number,
  homeMargin: number,
): PickResult {
  // home covers iff homeMargin + spreadHome > 0
  const homeMarginVsLine = homeMargin + spreadHome;
  if (homeMarginVsLine === 0) return "push";
  const homeCovered = homeMarginVsLine > 0;
  const pickedHome = side === "home";
  return homeCovered === pickedHome ? "win" : "loss";
}

export function gradeMoneyline(side: Side, homeMargin: number): PickResult {
  if (homeMargin === 0) return "push"; // tie → push (no winner)
  const homeWon = homeMargin > 0;
  const pickedHome = side === "home";
  return homeWon === pickedHome ? "win" : "loss";
}

export function gradeTotal(
  side: "over" | "under",
  totalLine: number,
  actualTotal: number,
): PickResult {
  if (actualTotal === totalLine) return "push";
  const wentOver = actualTotal > totalLine;
  const pickedOver = side === "over";
  return wentOver === pickedOver ? "win" : "loss";
}

function pnl(result: PickResult, odds: number): number {
  if (result === "push") return 0;
  return result === "win" ? americanToProfitUnits(odds) : -1;
}

/** Which side of the spread is the favorite for a given pick side. */
function favoredFor(side: Side, spreadHome: number): GradedRow["favored"] {
  if (spreadHome === 0) return "pickem";
  const homeIsFavorite = spreadHome < 0;
  const pickedHome = side === "home";
  return pickedHome === homeIsFavorite ? "favorite" : "underdog";
}

function isDome(roof: string): boolean {
  const r = roof.toLowerCase();
  return r === "dome" || r === "closed" || r === "indoors";
}

/** Grade one game's full pick set → up to three GradedRows. Pure: takes the
 *  real GameRow only for the result, never feeds it back into the model. */
export function gradeGame(game: GameRow, pick: GamePick): GradedRow[] {
  const rows: GradedRow[] = [];
  const matchup = `${game.awayTeam} @ ${game.homeTeam}`;
  const homeMargin = game.result;
  const actualTotal = game.total;
  const dome = isDome(game.roof);
  const div = game.divGame === true;
  const at = (s: Side): { rest: number; oppRest: number } => {
    const homeRest = game.homeRest ?? 0;
    const awayRest = game.awayRest ?? 0;
    return s === "home"
      ? { rest: homeRest, oppRest: awayRest }
      : { rest: awayRest, oppRest: homeRest };
  };

  // ATS
  if (homeMargin != null && Number.isFinite(pick.atsSpreadHome)) {
    const res = gradeAts(pick.atsSide, pick.atsSpreadHome, homeMargin);
    const odds = DEFAULT_ODDS; // spread odds standardized to -110
    const r = at(pick.atsSide);
    rows.push({
      key: `${game.gameId}|ats`,
      season: game.season,
      phase: game.gameType,
      week: game.week,
      gameId: game.gameId,
      matchup,
      market: "ats",
      selection: `${pick.atsSide === "home" ? game.homeTeam : game.awayTeam} ${fmtSpread(pick.atsSide, pick.atsSpreadHome)}`,
      side: pick.atsSide,
      confidence: clamp01(pick.confidence),
      result: res,
      oddsAmerican: odds,
      pnlUnits: +pnl(res, odds).toFixed(4),
      favored: favoredFor(pick.atsSide, pick.atsSpreadHome),
      homeAway: pick.atsSide,
      divGame: div,
      dome,
      restAdvantage: r.rest - r.oppRest,
      wind: game.wind,
      temp: game.temp,
      gradedAt: new Date().toISOString(),
    });
  }

  // Moneyline
  if (homeMargin != null) {
    const res = gradeMoneyline(pick.moneylineSide, homeMargin);
    const odds =
      pick.moneylineSide === "home"
        ? (game.homeMoneyline ?? DEFAULT_ODDS)
        : (game.awayMoneyline ?? DEFAULT_ODDS);
    const r = at(pick.moneylineSide);
    rows.push({
      key: `${game.gameId}|moneyline`,
      season: game.season,
      phase: game.gameType,
      week: game.week,
      gameId: game.gameId,
      matchup,
      market: "moneyline",
      selection: `${pick.moneylineSide === "home" ? game.homeTeam : game.awayTeam} ML`,
      side: pick.moneylineSide,
      confidence: clamp01(pick.confidence),
      result: res,
      oddsAmerican: odds,
      pnlUnits: +pnl(res, odds).toFixed(4),
      favored: favoredForMl(pick.moneylineSide, game),
      homeAway: pick.moneylineSide,
      divGame: div,
      dome,
      restAdvantage: r.rest - r.oppRest,
      wind: game.wind,
      temp: game.temp,
      gradedAt: new Date().toISOString(),
    });
  }

  // Total
  if (actualTotal != null && Number.isFinite(pick.totalLine)) {
    const res = gradeTotal(pick.totalSide, pick.totalLine, actualTotal);
    const odds =
      pick.totalSide === "over"
        ? (game.overOdds ?? DEFAULT_ODDS)
        : (game.underOdds ?? DEFAULT_ODDS);
    rows.push({
      key: `${game.gameId}|total`,
      season: game.season,
      phase: game.gameType,
      week: game.week,
      gameId: game.gameId,
      matchup,
      market: "total",
      selection: `${pick.totalSide} ${pick.totalLine}`,
      side: pick.totalSide,
      confidence: clamp01(pick.confidence),
      result: res,
      oddsAmerican: odds,
      pnlUnits: +pnl(res, odds).toFixed(4),
      favored: "pickem", // n/a for totals
      homeAway: "home", // n/a for totals; kept stable
      divGame: div,
      dome,
      restAdvantage: 0,
      wind: game.wind,
      temp: game.temp,
      gradedAt: new Date().toISOString(),
    });
  }

  return rows;
}

function favoredForMl(side: Side, game: GameRow): GradedRow["favored"] {
  const home = game.homeMoneyline;
  const away = game.awayMoneyline;
  if (home == null || away == null) {
    // fall back to spread sign
    if (game.spreadLine == null || game.spreadLine === 0) return "pickem";
    return favoredFor(side, game.spreadLine);
  }
  if (home === away) return "pickem";
  const homeIsFavorite = home < away; // more negative / smaller = favorite
  const pickedHome = side === "home";
  return pickedHome === homeIsFavorite ? "favorite" : "underdog";
}

function fmtSpread(side: Side, spreadHome: number): string {
  const v = side === "home" ? spreadHome : -spreadHome;
  return v > 0 ? `+${v}` : `${v}`;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

// ─────────────────────────────────────────────────────────────────────────────
// Picks log I/O (JSONL, keyed upsert — idempotent)
// ─────────────────────────────────────────────────────────────────────────────

export function loadGradedRows(dir: string): GradedRow[] {
  const p = picksLogPath(dir);
  if (!fs.existsSync(p)) return [];
  const out: GradedRow[] = [];
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as GradedRow);
    } catch {
      // skip a corrupt line rather than crash the whole report
    }
  }
  return out;
}

/** Upsert rows keyed by `.key`. Re-running a week replaces its rows in place —
 *  no double-count. Rewrites the whole file (small: ~850 rows/season). */
export function upsertGradedRows(dir: string, rows: GradedRow[]): { added: number; replaced: number } {
  fs.mkdirSync(dir, { recursive: true });
  const existing = loadGradedRows(dir);
  const byKey = new Map<string, GradedRow>();
  for (const r of existing) byKey.set(r.key, r);
  let added = 0;
  let replaced = 0;
  for (const r of rows) {
    if (byKey.has(r.key)) replaced++;
    else added++;
    byKey.set(r.key, r);
  }
  const all = [...byKey.values()];
  const body = all.map((r) => JSON.stringify(r)).join("\n") + (all.length ? "\n" : "");
  fs.writeFileSync(picksLogPath(dir), body);
  return { added, replaced };
}

// ─────────────────────────────────────────────────────────────────────────────
// Lessons memo I/O
// ─────────────────────────────────────────────────────────────────────────────

function weekLessonName(season: number, phase: GameType, week: number): string {
  const wk = String(week).padStart(2, "0");
  return `${season}-${phase.toLowerCase()}wk${wk}.md`;
}

export function loadLessonsCurrent(dir: string): string {
  const p = lessonsCurrentPath(dir);
  if (!fs.existsSync(p)) return "";
  return fs.readFileSync(p, "utf8");
}

/** Write this week's memo file, then rebuild lessons-current.md as the last
 *  `keep` weekly memos concatenated newest-first. Idempotent: rewriting the same
 *  week overwrites its file and rebuilds from the directory contents. */
export function writeWeekLessons(
  dir: string,
  cursor: Cursor,
  memo: string,
  keep = 4,
): void {
  const ldir = lessonsDir(dir);
  fs.mkdirSync(ldir, { recursive: true });
  const fname = weekLessonName(cursor.season, cursor.phase, cursor.week);
  const body = `# ${cursor.season} ${cursor.phase} week ${cursor.week}\n\n${memo.trim()}\n`;
  fs.writeFileSync(path.join(ldir, fname), body);

  // Rebuild rolling current from the weekly files, newest-first by filename.
  const files = fs
    .readdirSync(ldir)
    .filter((f) => /\d{4}-(reg|post)wk\d{2}\.md$/.test(f))
    .sort()
    .reverse()
    .slice(0, keep);
  const rolling = files
    .map((f) => fs.readFileSync(path.join(ldir, f), "utf8").trim())
    .join("\n\n---\n\n");
  fs.writeFileSync(lessonsCurrentPath(dir), rolling + "\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Stat record — DERIVED from the graded log (the "track every stat" requirement)
// ─────────────────────────────────────────────────────────────────────────────

export type Tally = {
  wins: number;
  losses: number;
  pushes: number;
  pnlUnits: number;
};

export type SplitStat = Tally & {
  label: string;
  n: number; // decisive (win+loss)
  winRate: number | null;
  roiPct: number | null; // pnl / staked (staked = decisive count, 1u each)
};

export type CalibrationBucket = {
  label: string; // e.g. "0.6-0.7"
  n: number;
  predicted: number; // mean confidence
  realized: number | null; // realized win rate
};

export type StatRecord = {
  totalRows: number;
  overall: Record<Market, SplitStat>;
  splits: {
    favoriteVsDog: SplitStat[];
    homeVsAway: SplitStat[];
    divisional: SplitStat[];
    domeVsOutdoor: SplitStat[];
    byRestAdvantage: SplitStat[];
    byWind: SplitStat[];
    byTemp: SplitStat[];
  };
  baseRates: {
    favoriteCoverRate: number | null; // among ATS picks on favorites, win rate
    overRate: number | null; // among total picks, share graded over (win if picked over)
  };
  calibration: CalibrationBucket[];
};

function emptyTally(): Tally {
  return { wins: 0, losses: 0, pushes: 0, pnlUnits: 0 };
}

function add(t: Tally, r: GradedRow): void {
  if (r.result === "win") t.wins++;
  else if (r.result === "loss") t.losses++;
  else t.pushes++;
  t.pnlUnits += r.pnlUnits;
}

function toSplit(label: string, t: Tally): SplitStat {
  const decisive = t.wins + t.losses;
  return {
    label,
    ...t,
    pnlUnits: +t.pnlUnits.toFixed(3),
    n: decisive,
    winRate: decisive > 0 ? +(t.wins / decisive).toFixed(4) : null,
    roiPct: decisive > 0 ? +((t.pnlUnits / decisive) * 100).toFixed(2) : null,
  };
}

/** Group rows by a string key → SplitStat[], stable-ordered by the provided
 *  order array when given, else by label. */
function groupBy(
  rows: GradedRow[],
  keyFn: (r: GradedRow) => string | null,
  order?: string[],
): SplitStat[] {
  const tallies = new Map<string, Tally>();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    let t = tallies.get(k);
    if (!t) {
      t = emptyTally();
      tallies.set(k, t);
    }
    add(t, r);
  }
  const keys = order
    ? order.filter((k) => tallies.has(k))
    : [...tallies.keys()].sort();
  return keys.map((k) => toSplit(k, tallies.get(k)!));
}

function restBucket(adv: number): string {
  if (adv >= 4) return "+4 or more";
  if (adv >= 1) return "+1 to +3";
  if (adv === 0) return "even";
  if (adv >= -3) return "-1 to -3";
  return "-4 or less";
}
const REST_ORDER = ["+4 or more", "+1 to +3", "even", "-1 to -3", "-4 or less"];

function windBucket(w: number | null): string | null {
  if (w == null) return null;
  if (w <= 5) return "calm (0-5)";
  if (w <= 12) return "breezy (6-12)";
  if (w <= 20) return "windy (13-20)";
  return "gale (20+)";
}
const WIND_ORDER = ["calm (0-5)", "breezy (6-12)", "windy (13-20)", "gale (20+)"];

function tempBucket(t: number | null): string | null {
  if (t == null) return null;
  if (t <= 32) return "freezing (<=32)";
  if (t <= 50) return "cold (33-50)";
  if (t <= 70) return "mild (51-70)";
  return "warm (70+)";
}
const TEMP_ORDER = ["freezing (<=32)", "cold (33-50)", "mild (51-70)", "warm (70+)"];

function confBucket(c: number): string {
  // 0.5-0.6, 0.6-0.7, ... ; clamp into [0,1]
  const x = Math.max(0, Math.min(0.999, c));
  const lo = Math.floor(x * 10) / 10;
  const hi = +(lo + 0.1).toFixed(1);
  return `${lo.toFixed(1)}-${hi.toFixed(1)}`;
}

export function computeStatRecord(rows: GradedRow[]): StatRecord {
  const overall: Record<Market, SplitStat> = {
    ats: toSplit("ATS", tallyMarket(rows, "ats")),
    moneyline: toSplit("Moneyline", tallyMarket(rows, "moneyline")),
    total: toSplit("Total", tallyMarket(rows, "total")),
  };

  // Favorite-cover rate: among ATS picks placed on a side that was the favorite.
  const atsRows = rows.filter((r) => r.market === "ats");
  const favRows = atsRows.filter((r) => r.favored === "favorite");
  const favDecisive = favRows.filter((r) => r.result !== "push");
  const favoriteCoverRate =
    favDecisive.length > 0
      ? +(favDecisive.filter((r) => r.result === "win").length / favDecisive.length).toFixed(4)
      : null;

  // Over rate: among total picks, the realized share of games that went over,
  // reconstructed from result+side (over-win or under-loss ⇒ went over).
  const totalRows = rows.filter((r) => r.market === "total" && r.result !== "push");
  const overGames = totalRows.filter(
    (r) =>
      (r.side === "over" && r.result === "win") ||
      (r.side === "under" && r.result === "loss"),
  ).length;
  const overRate = totalRows.length > 0 ? +(overGames / totalRows.length).toFixed(4) : null;

  return {
    totalRows: rows.length,
    overall,
    splits: {
      favoriteVsDog: groupBy(atsRows, (r) => r.favored, ["favorite", "underdog", "pickem"]),
      homeVsAway: groupBy(
        rows.filter((r) => r.market !== "total"),
        (r) => r.homeAway,
        ["home", "away"],
      ),
      divisional: groupBy(rows, (r) => (r.divGame ? "divisional" : "non-divisional"), [
        "divisional",
        "non-divisional",
      ]),
      domeVsOutdoor: groupBy(rows, (r) => (r.dome ? "dome" : "outdoor"), ["dome", "outdoor"]),
      byRestAdvantage: groupBy(
        rows.filter((r) => r.market !== "total"),
        (r) => restBucket(r.restAdvantage),
        REST_ORDER,
      ),
      byWind: groupBy(rows, (r) => windBucket(r.wind), WIND_ORDER),
      byTemp: groupBy(rows, (r) => tempBucket(r.temp), TEMP_ORDER),
    },
    baseRates: { favoriteCoverRate, overRate },
    calibration: computeCalibration(rows),
  };
}

function tallyMarket(rows: GradedRow[], market: Market): Tally {
  const t = emptyTally();
  for (const r of rows) if (r.market === market) add(t, r);
  return t;
}

function computeCalibration(rows: GradedRow[]): CalibrationBucket[] {
  const buckets = new Map<string, { confSum: number; n: number; wins: number; decisive: number }>();
  for (const r of rows) {
    const k = confBucket(r.confidence);
    let b = buckets.get(k);
    if (!b) {
      b = { confSum: 0, n: 0, wins: 0, decisive: 0 };
      buckets.set(k, b);
    }
    b.confSum += r.confidence;
    b.n++;
    if (r.result !== "push") {
      b.decisive++;
      if (r.result === "win") b.wins++;
    }
  }
  return [...buckets.keys()]
    .sort()
    .map((k) => {
      const b = buckets.get(k)!;
      return {
        label: k,
        n: b.n,
        predicted: +(b.confSum / b.n).toFixed(3),
        realized: b.decisive > 0 ? +(b.wins / b.decisive).toFixed(3) : null,
      };
    });
}
