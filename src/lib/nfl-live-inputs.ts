// nfl-live-inputs.ts — the LIVE-week input layer for Experiment No. 5.
//
// The backtest loop reads every pre-game factor from nflverse games.csv +
// injuries.csv, which are complete for PLAYED seasons. For a live week they are
// not: measured 2026-09-10 on the week-1 board, the model saw
//   • injuries — 0 rows (injuries.csv ends at 2024; ESPN's injuries-nfl.json
//     had 343 players / 158 IR / 43 Out at the same moment), and wrote
//     "no injuries either side" as a key factor;
//   • temp / wind / referee — 0 of 16 games (nflverse fills them post-game);
//   • neutral sites — none (the `location` column was never parsed), so the
//     Rams' Melbourne "home" game carried full home-field in the prompt and
//     +55 Elo in the dry-run.
// Every function here is PURE (no fs, no network, injected clock) so the
// leak boundary — nothing at or after the cursor week — is unit-tested. The
// impure script is scripts/ingest-nfl-live-inputs.ts.

import { FRANCHISES, franchiseKey } from "./nfl-receipts/teams";
import { devigTwoWay } from "./nfl-devig";
import type { Cursor, GameRow, GameType, InjuryRow, ReportStatus } from "./nfl-loop";

// ─────────────────────────────────────────────────────────────────────────────
// Team codes
// ─────────────────────────────────────────────────────────────────────────────

/** nflverse team code for an Odds API / ESPN display name ("Green Bay Packers"
 *  → "GB"). FRANCHISES lists the modern nflverse code FIRST in `abbrs`; the
 *  frozen-anchor test checks that against every code in games.csv. */
export function nflverseAbbr(fullName: string): string | null {
  const key = franchiseKey(fullName);
  if (!key) return null;
  const f = FRANCHISES.find((x) => x.key === key);
  return f?.abbrs[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. ESPN injuries → the loop's InjuryRow shape (live weeks only)
// ─────────────────────────────────────────────────────────────────────────────

export type EspnInjuryPlayer = {
  player: string;
  team: string; // full display name
  position?: string;
  status: string; // "Out" | "Injured Reserve" | "Questionable" | "Doubtful" | "Day-To-Day" | …
  injuryType?: string;
  returnDate?: string; // YYYY-MM-DD when ESPN gives one
};

export type EspnInjuryFile = { fetchedAt?: string; sport?: string; players?: EspnInjuryPlayer[] };

/** ESPN status → the report-only status the loop already models. IR / PUP /
 *  NFI / Suspended players will not play this week — that is "Out" for the
 *  purpose of a pick, and the original wording travels in `injury` so the
 *  model can tell a season-ender from a one-week scratch. */
export function espnStatusToReport(status: string): ReportStatus {
  const s = status.trim().toLowerCase();
  if (s === "out") return "Out";
  if (/injured reserve|^ir\b|\bpup\b|physically unable|non-football|\bnfi\b|suspend/.test(s)) return "Out";
  if (s === "doubtful") return "Doubtful";
  if (s === "questionable" || /day-to-day|day to day/.test(s)) return "Questionable";
  return "None";
}

export type EspnConversion = {
  rows: InjuryRow[];
  /** Players whose team name did not resolve to a franchise — surfaced, never guessed. */
  unresolvedTeams: string[];
};

/** Convert the ESPN feed into InjuryRow[] keyed to the cursor week, so
 *  indexInjuries / buildBlindWeek attach them exactly like nflverse rows. */
export function espnInjuriesToRows(
  file: EspnInjuryFile,
  cursor: Cursor,
  phase: GameType = cursor.phase,
): EspnConversion {
  const rows: InjuryRow[] = [];
  const unresolved = new Set<string>();
  for (const p of file.players ?? []) {
    const team = nflverseAbbr(p.team);
    if (!team) {
      unresolved.add(p.team);
      continue;
    }
    const status = espnStatusToReport(p.status);
    const detail = [p.injuryType?.trim() || "", p.status.trim()]
      .filter(Boolean)
      .join(" — ");
    const ret = p.returnDate ? ` (est. return ${p.returnDate})` : "";
    rows.push({
      season: cursor.season,
      gameType: phase,
      week: cursor.week,
      team,
      player: p.player,
      position: p.position ?? "",
      status,
      injury: `${detail}${ret}`,
    });
  }
  return { rows, unresolvedTeams: [...unresolved].sort() };
}

/** nflverse rows for the cursor week (if any — they only exist from Wednesday)
 *  win; ESPN fills in every player they do not already list. Keyed by
 *  team|player so a re-run never duplicates. */
export function mergeInjuryRows(nflverse: InjuryRow[], espn: InjuryRow[], cursor: Cursor): InjuryRow[] {
  const inWeek = (r: InjuryRow) =>
    r.season === cursor.season && r.gameType === cursor.phase && r.week === cursor.week;
  const seen = new Set<string>();
  const out: InjuryRow[] = [];
  for (const r of nflverse) {
    if (inWeek(r)) seen.add(`${r.team}|${r.player.toLowerCase()}`);
    out.push(r);
  }
  for (const r of espn) {
    const k = `${r.team}|${r.player.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Stadiums → cities (for the forecast lookup)
// ─────────────────────────────────────────────────────────────────────────────

export type StadiumCity = {
  /** Geocoder query (a CITY — Open-Meteo's gazetteer does not index stadium
   *  names; measured 2026-09-10: 0/6 stadium names resolved, 15/15 cities did). */
  query: string;
  /** admin1 the geocoder must return (disambiguates Glendale AZ/CA, Arlington
   *  TX/VA, Paris FR/TX …). */
  admin1?: string;
  country: string; // ISO-3166 alpha-2
};

/** nflverse stadium_id → city. Every id that appears in the 2026 schedule is
 *  here (frozen-anchor test). International venues are keyed by BOTH their
 *  own id (LON00, MEX00 …) and, via VENUE_OVERRIDES, by stadium NAME — nflverse
 *  files the Jaguars' London game under JAX00 with the Tottenham stadium
 *  string, so the id alone would put that forecast in Jacksonville. */
export const STADIUM_CITIES: Record<string, StadiumCity> = {
  ATL97: { query: "Atlanta", admin1: "Georgia", country: "US" },
  BAL00: { query: "Baltimore", admin1: "Maryland", country: "US" },
  BOS00: { query: "Foxborough", admin1: "Massachusetts", country: "US" },
  BUF00: { query: "Orchard Park", admin1: "New York", country: "US" },
  CAR00: { query: "Charlotte", admin1: "North Carolina", country: "US" },
  CHI98: { query: "Chicago", admin1: "Illinois", country: "US" },
  CIN00: { query: "Cincinnati", admin1: "Ohio", country: "US" },
  CLE00: { query: "Cleveland", admin1: "Ohio", country: "US" },
  DAL00: { query: "Arlington", admin1: "Texas", country: "US" },
  DEN00: { query: "Denver", admin1: "Colorado", country: "US" },
  DET00: { query: "Detroit", admin1: "Michigan", country: "US" },
  GNB00: { query: "Green Bay", admin1: "Wisconsin", country: "US" },
  HOU00: { query: "Houston", admin1: "Texas", country: "US" },
  IND00: { query: "Indianapolis", admin1: "Indiana", country: "US" },
  JAX00: { query: "Jacksonville", admin1: "Florida", country: "US" },
  KAN00: { query: "Kansas City", admin1: "Missouri", country: "US" },
  LAX01: { query: "Inglewood", admin1: "California", country: "US" },
  LON00: { query: "London", admin1: "England", country: "GB" },
  LON02: { query: "London", admin1: "England", country: "GB" },
  MAD01: { query: "Madrid", admin1: "Madrid", country: "ES" },
  MEL00: { query: "Melbourne", admin1: "Victoria", country: "AU" },
  MEX00: { query: "Mexico City", country: "MX" },
  MIA00: { query: "Miami Gardens", admin1: "Florida", country: "US" },
  MIN01: { query: "Minneapolis", admin1: "Minnesota", country: "US" },
  MUN01: { query: "Munich", admin1: "Bavaria", country: "DE" },
  NAS00: { query: "Nashville", admin1: "Tennessee", country: "US" },
  NOR00: { query: "New Orleans", admin1: "Louisiana", country: "US" },
  NYC01: { query: "East Rutherford", admin1: "New Jersey", country: "US" },
  PAR00: { query: "Saint-Denis", admin1: "Île-de-France", country: "FR" },
  PHI00: { query: "Philadelphia", admin1: "Pennsylvania", country: "US" },
  PHO00: { query: "Glendale", admin1: "Arizona", country: "US" },
  PIT00: { query: "Pittsburgh", admin1: "Pennsylvania", country: "US" },
  RIO00: { query: "Rio de Janeiro", admin1: "Rio de Janeiro", country: "BR" },
  SEA00: { query: "Seattle", admin1: "Washington", country: "US" },
  SFO01: { query: "Santa Clara", admin1: "California", country: "US" },
  TAM00: { query: "Tampa", admin1: "Florida", country: "US" },
  VEG00: { query: "Paradise", admin1: "Nevada", country: "US" },
  WAS00: { query: "Landover", admin1: "Maryland", country: "US" },
};

/** Stadium NAME → city, for games nflverse files under the home team's id
 *  while playing abroad. Checked before STADIUM_CITIES. */
export const VENUE_OVERRIDES: Record<string, StadiumCity> = {
  "Tottenham Hotspur Stadium": STADIUM_CITIES.LON02,
  "Wembley Stadium": STADIUM_CITIES.LON00,
  "Bernabeu": STADIUM_CITIES.MAD01,
  "Melbourne Cricket Ground": STADIUM_CITIES.MEL00,
  "Estadio Banorte": STADIUM_CITIES.MEX00,
  "Estadio Azteca": STADIUM_CITIES.MEX00,
  "FC Bayern Munich Stadium": STADIUM_CITIES.MUN01,
  "Allianz Arena": STADIUM_CITIES.MUN01,
  "Stade de France": STADIUM_CITIES.PAR00,
  "Maracana Stadium": STADIUM_CITIES.RIO00,
};

export function stadiumCityFor(stadiumId: string, stadiumName: string): StadiumCity | null {
  return VENUE_OVERRIDES[stadiumName.trim()] ?? STADIUM_CITIES[stadiumId] ?? null;
}

/** Roofs that make weather irrelevant. Blank (retractable, unknown for a
 *  future game) is NOT a dome: the forecast is fetched and the prompt says
 *  the roof may close. */
export function isDomeRoof(roof: string): boolean {
  const r = roof.trim().toLowerCase();
  return r === "dome" || r === "closed" || r === "indoors";
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Kickoff time — nflverse gametime is US/Eastern
// ─────────────────────────────────────────────────────────────────────────────

function newYorkOffsetMinutes(utcMs: number): number {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
  return Math.round((asUtc - utcMs) / 60_000);
}

/** "2026-09-13" + "13:00" (Eastern) → "2026-09-13T17:00:00.000Z". Empty
 *  gametime → 13:00 ET, the default Sunday slot. */
export function kickoffUtcFromEastern(gameday: string, gametime: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(gameday.trim());
  if (!m) return null;
  const t = /^(\d{1,2}):(\d{2})$/.exec(gametime.trim()) ?? ["", "13", "00"];
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +t[1], +t[2]);
  // Two passes converge across a DST boundary.
  let utc = naive - newYorkOffsetMinutes(naive) * 60_000;
  utc = naive - newYorkOffsetMinutes(utc) * 60_000;
  return new Date(utc).toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Weather forecasts → GameRow.temp / wind (outdoor games only)
// ─────────────────────────────────────────────────────────────────────────────

export type WeatherForecast = {
  gameId: string;
  stadiumId: string;
  city: string;
  kickoffUtc: string;
  /** Forecast hour actually used (nearest hour to kickoff). */
  forecastHourUtc: string;
  tempF: number | null;
  windMph: number | null;
  gustMph: number | null;
  precipPct: number | null;
  /** Hours between fetch and kickoff — the honest horizon of the forecast. */
  hoursAhead: number;
  fetchedAt: string;
  source: "open-meteo";
};

export type WeatherFile = { generatedAt?: string; season?: number; week?: number; forecasts?: WeatherForecast[] };

export type WeatherApplied = {
  games: GameRow[];
  applied: number; // outdoor games that received a forecast
  skippedDome: number;
  missing: string[]; // outdoor game ids with no forecast on file
};

/** Overlay forecasts onto the rows of ONE week. nflverse leaves temp/wind
 *  blank until the game is played; a value already present (a played game,
 *  or a backtest row) is never overwritten. Domes stay null — the prompt
 *  treats a dome as weather-neutral. */
export function applyForecasts(games: GameRow[], forecasts: WeatherForecast[]): WeatherApplied {
  const byId = new Map(forecasts.map((f) => [f.gameId, f]));
  const out: GameRow[] = [];
  let applied = 0;
  let skippedDome = 0;
  const missing: string[] = [];
  for (const g of games) {
    if (isDomeRoof(g.roof)) {
      skippedDome++;
      out.push(g);
      continue;
    }
    const f = byId.get(g.gameId);
    if (!f) {
      if (g.temp == null && g.wind == null) missing.push(g.gameId);
      out.push(g);
      continue;
    }
    applied++;
    out.push({
      ...g,
      temp: g.temp ?? (f.tempF == null ? null : Math.round(f.tempF)),
      wind: g.wind ?? (f.windMph == null ? null : Math.round(f.windMph)),
      weatherForecastHoursAhead: f.hoursAhead,
    });
  }
  return { games: out, applied, skippedDome, missing };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. EPA features (research rec 4 — the Open Source Football 8-feature recipe)
// ─────────────────────────────────────────────────────────────────────────────

/** One team-game from nflverse stats_team_week_<season>.csv. OFFENSE only —
 *  the defensive side of a matchup is the opponent's offense in the same
 *  game_id (rec 4: do NOT opponent-adjust defensive EPA; it measurably hurts). */
export type TeamGameEpa = {
  season: number;
  week: number;
  seasonType: string; // "REG" | "POST"
  gameId: string;
  team: string;
  opponent: string;
  passEpa: number;
  dropbacks: number; // attempts + sacks suffered
  rushEpa: number;
  carries: number;
};

export type EpaFeatures = {
  /** Offense: EPA per dropback / per carry (positive = good for the offense). */
  offPassEpaPerDropback: number;
  offRushEpaPerCarry: number;
  /** Defense: EPA per dropback / per carry ALLOWED (negative = good defense). */
  defPassEpaPerDropbackAllowed: number;
  defRushEpaPerCarryAllowed: number;
  gamesInWindow: number;
  /** Effective plays behind the estimate (decay-weighted) — small = thin. */
  weightedDropbacks: number;
  weightedCarries: number;
  window: string; // e.g. "2025 wk1 → 2026 wk1"
};

export type EpaOptions = {
  /** Per-game geometric decay (0.9 → half-life ≈ 6.6 games; rec 4 asks for
   *  dynamic 10–20 game windows weighted by play count). */
  decay?: number;
  /** Hard cap on games considered, most recent first. */
  maxGames?: number;
  /** Extra multiplier on games from an EARLIER season than the cursor (roster
   *  turnover) — the same 1/3 regression the Elo dry-run uses. */
  priorSeasonWeight?: number;
};

const EPA_DEFAULTS: Required<EpaOptions> = { decay: 0.9, maxGames: 20, priorSeasonWeight: 0.67 };

/** Parse the nflverse team-week CSV (already split into a matrix by the loop's
 *  RFC-4180 parser) into TeamGameEpa rows. Unknown / non-numeric rows are
 *  dropped, never defaulted to 0 — a phantom 0-EPA game is a lie. */
export function parseTeamWeekEpa(matrix: string[][]): TeamGameEpa[] {
  if (matrix.length === 0) return [];
  const header = matrix[0].map((h) => h.trim());
  const ix = new Map(header.map((h, i) => [h, i]));
  const need = ["season", "week", "team", "season_type", "game_id", "opponent_team", "attempts", "sacks_suffered", "passing_epa", "carries", "rushing_epa"];
  for (const n of need) if (!ix.has(n)) return [];
  const num = (r: string[], k: string): number | null => {
    const raw = r[ix.get(k)!];
    // Number("") is 0 — a blank cell must be "no data", never a 0-EPA game.
    if (raw === undefined || raw.trim() === "") return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  };
  const out: TeamGameEpa[] = [];
  for (let i = 1; i < matrix.length; i++) {
    const r = matrix[i];
    if (!r || r.length < header.length) continue;
    const season = num(r, "season");
    const week = num(r, "week");
    const attempts = num(r, "attempts");
    const sacks = num(r, "sacks_suffered");
    const passEpa = num(r, "passing_epa");
    const carries = num(r, "carries");
    const rushEpa = num(r, "rushing_epa");
    if (season == null || week == null || attempts == null || sacks == null || passEpa == null || carries == null || rushEpa == null) continue;
    const gameId = r[ix.get("game_id")!]?.trim();
    const team = r[ix.get("team")!]?.trim();
    const opponent = r[ix.get("opponent_team")!]?.trim();
    if (!gameId || !team || !opponent) continue;
    out.push({
      season,
      week,
      seasonType: r[ix.get("season_type")!]?.trim() ?? "REG",
      gameId,
      team,
      opponent,
      passEpa,
      dropbacks: attempts + sacks,
      rushEpa,
      carries,
    });
  }
  return out;
}

function orderKey(season: number, week: number): number {
  return season * 100 + week;
}

/** EWMA EPA features for every team, from games STRICTLY BEFORE the cursor
 *  week (the loop's leak boundary; nflverse postseason weeks are 19+ so they
 *  sort after the regular season naturally). Weighted by plays × decay^age,
 *  so a 60-dropback game counts twice a 30-dropback one. */
export function computeEpaFeatures(
  rows: TeamGameEpa[],
  cursor: Cursor,
  opts: EpaOptions = {},
): Map<string, EpaFeatures> {
  const o = { ...EPA_DEFAULTS, ...opts };
  const cutoff = orderKey(cursor.season, cursor.week);
  // Opponent offense in the same game = this team's defense allowed.
  const byGame = new Map<string, TeamGameEpa[]>();
  for (const r of rows) {
    if (orderKey(r.season, r.week) >= cutoff) continue; // leak boundary
    const list = byGame.get(r.gameId) ?? [];
    list.push(r);
    byGame.set(r.gameId, list);
  }
  const byTeam = new Map<string, Array<{ own: TeamGameEpa; opp: TeamGameEpa }>>();
  for (const list of byGame.values()) {
    if (list.length !== 2) continue; // need both sides to know the defense
    for (const own of list) {
      const opp = list.find((x) => x !== own)!;
      const arr = byTeam.get(own.team) ?? [];
      arr.push({ own, opp });
      byTeam.set(own.team, arr);
    }
  }
  const out = new Map<string, EpaFeatures>();
  for (const [team, games] of byTeam) {
    games.sort((a, b) => orderKey(b.own.season, b.own.week) - orderKey(a.own.season, a.own.week));
    const recent = games.slice(0, o.maxGames);
    let offPass = 0, offDrop = 0, offRush = 0, offCarry = 0;
    let defPass = 0, defDrop = 0, defRush = 0, defCarry = 0;
    recent.forEach(({ own, opp }, age) => {
      const w = Math.pow(o.decay, age) * (own.season < cursor.season ? o.priorSeasonWeight : 1);
      offPass += w * own.passEpa;
      offDrop += w * own.dropbacks;
      offRush += w * own.rushEpa;
      offCarry += w * own.carries;
      defPass += w * opp.passEpa;
      defDrop += w * opp.dropbacks;
      defRush += w * opp.rushEpa;
      defCarry += w * opp.carries;
    });
    if (offDrop <= 0 || offCarry <= 0 || defDrop <= 0 || defCarry <= 0) continue;
    const oldest = recent[recent.length - 1].own;
    const newest = recent[0].own;
    out.set(team, {
      offPassEpaPerDropback: round3(offPass / offDrop),
      offRushEpaPerCarry: round3(offRush / offCarry),
      defPassEpaPerDropbackAllowed: round3(defPass / defDrop),
      defRushEpaPerCarryAllowed: round3(defRush / defCarry),
      gamesInWindow: recent.length,
      weightedDropbacks: Math.round(offDrop),
      weightedCarries: Math.round(offCarry),
      window: `${oldest.season} wk${oldest.week} → ${newest.season} wk${newest.week}`,
    });
  }
  return out;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. The moneyline gate's fair probability (doctrine tightening T4)
// ─────────────────────────────────────────────────────────────────────────────

/** The fair probability the PLAY gate judges an edge against. Research rec 7:
 *  never the naive proportional split for a dog. For a PLAY decision the
 *  conservative envelope is the HIGHEST fair probability of the side across
 *  the four devig methods (the smallest edge) — note this is the opposite end
 *  from `DevigResult.worstCaseA`, which is the conservative envelope for a CLV
 *  verdict (the lowest fair CLOSE probability is the hardest close to beat).
 *  Measured on the 2026 wk1 board: max−min across methods ≤ 0.7pp, 0/16
 *  verdicts flip — tightening-only, as the 2026 doctrine requires. */
export function gateFairProb(sideAmerican: number, otherAmerican: number): number {
  const d = devigTwoWay(sideAmerican, otherAmerican);
  return Math.max(...Object.values(d.byMethod));
}
