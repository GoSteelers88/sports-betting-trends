// TODAY'S SLATE — the deterministic schedule read.
//
// "What games are on today?" has a correct answer that needs no model: it is a
// date filter over the odds snapshots. Before this module the desk had no way to
// produce it — `get_odds` returns EVERY event in a file regardless of date, and
// the September NBA snapshot holds October-20 and December-25 games while the
// WNBA snapshot holds next week's. A model handed that raw feed and asked "what's
// on tonight" either invents a slate or falls back.
//
// So the schedule is computed HERE, in pure code, and handed to the model as a
// tool result it can read off directly:
//   • which games start on TODAY'S calendar day in America/New_York,
//   • their ET start times, already formatted (no UTC→ET arithmetic by a model),
//   • the moneyline on each side,
//   • which leagues are DARK today and the next date they're on the board,
//   • when each league's lines were last refreshed.
//
// Pure over its inputs: the odds reader and `now` are injected, so it unit-tests
// against a fixture with no filesystem and no clock.
//
// GROUNDING NOTE (load-bearing): every numeric field here is named so the
// grounding whitelist in grounding.ts already accepts it —
// `homeMoneylineAmerican`/`awayMoneylineAmerican` are PRICE_KEYS, `gameCount` is
// a STAT_VALUE_KEY, and `note` is a TEXT_VALUE_KEY. Start times and dates are
// strings, exempted by collectTimeRaws/collectDateRaws. Do not rename a field
// without checking that file.

import { getOdds, type AgentLeague, type GameOdds } from "@/lib/agent/tools";

export const ET_ZONE = "America/New_York";

// The leagues a schedule answer covers. NBA/MLB/WNBA are the bets lane. NFL is
// carried for the SCHEDULE ONLY — the desk's NFL read lives on the receipts lane
// (/nfl), and the schedule prompt says so — because "what's on today" is a
// calendar question and answering it with three of the four leagues is a lie of
// omission on a Saturday in September.
export const SCHEDULE_LEAGUES = ["MLB", "NFL", "NBA", "WNBA"] as const;
export type ScheduleLeague = (typeof SCHEDULE_LEAGUES)[number];

// The bettable-lane leagues whose board a "best play" survey can draw from.
export const BETS_LANE_LEAGUES = ["MLB", "NBA", "WNBA"] as const;

// ─── ET formatting (Intl, not hand-rolled timezone math) ─────────────────────

const DAY_KEY_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: ET_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const LONG_DATE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: ET_ZONE,
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

const SHORT_DATE_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: ET_ZONE,
  month: "long",
  day: "numeric",
});

const CLOCK_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: ET_ZONE,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** "2026-09-12" — the calendar day in America/New_York. The join key for "today". */
export function etDayKey(d: Date): string {
  return DAY_KEY_FMT.format(d);
}

/** "Saturday, September 12, 2026" */
export function etLongDate(d: Date): string {
  return LONG_DATE_FMT.format(d);
}

/** "September 12" */
export function etShortDate(d: Date): string {
  return SHORT_DATE_FMT.format(d);
}

/** "7:15 PM ET" */
export function etClock(d: Date): string {
  return `${CLOCK_FMT.format(d).replace(/ /g, " ")} ET`;
}

/** Parse an ISO timestamp, returning null rather than an Invalid Date. */
export function parseIso(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t) : null;
}

// ─── The brief ───────────────────────────────────────────────────────────────

export type SlateGame = {
  matchup: string;
  awayTeam: string;
  homeTeam: string;
  /** "7:15 PM ET" — already localized; the model must not do timezone math. */
  startEt: string;
  /** True once the scheduled start has passed (the game is under way or final). */
  started: boolean;
  awayMoneylineAmerican: number | null;
  homeMoneylineAmerican: number | null;
};

export type LeagueSlate = {
  league: ScheduleLeague;
  gameCount: number;
  games: SlateGame[];
  /** "6:43 PM ET on September 12", or null when the file carries no timestamp. */
  linesRefreshedEt: string | null;
  /** For a DARK league: the next date this league appears on the board. */
  nextSlateDateEt: string | null;
  /** Honest one-liner the desk can read aloud verbatim. */
  note: string;
};

export type TodaySlate = {
  /** "Saturday, September 12, 2026" */
  dateEt: string;
  /** "2026-09-12" — the day key the filter used. */
  dayKeyEt: string;
  /** "7:02 PM ET" — when this read was taken. */
  nowEt: string;
  gameCount: number;
  leagues: LeagueSlate[];
  note: string;
};

export type SlateDeps = {
  odds?: (league: AgentLeague) => { fetchedAt: string | null; events: GameOdds[] };
  now?: Date;
};

// Games in `events` whose START falls on `dayKey` (America/New_York), in start
// order. A bad/absent commence_time drops the row rather than defaulting it into
// today — a game we cannot date is a game we must not claim is on tonight.
function gamesOnDay(events: GameOdds[], dayKey: string, now: Date): SlateGame[] {
  const out: Array<{ at: number; game: SlateGame }> = [];
  for (const ev of events) {
    const start = parseIso(ev.commenceTime);
    if (!start) continue;
    if (etDayKey(start) !== dayKey) continue;
    out.push({
      at: start.getTime(),
      game: {
        matchup: `${ev.awayTeam} @ ${ev.homeTeam}`,
        awayTeam: ev.awayTeam,
        homeTeam: ev.homeTeam,
        startEt: etClock(start),
        started: start.getTime() <= now.getTime(),
        awayMoneylineAmerican: ev.consensus.away?.american ?? null,
        homeMoneylineAmerican: ev.consensus.home?.american ?? null,
      },
    });
  }
  out.sort((a, b) => a.at - b.at);
  return out.map((r) => r.game);
}

// The next calendar day (ET) on which this league has a game, strictly after
// today. Used to tell a user "the NBA board opens October 20" instead of the
// desk going quiet.
function nextSlateDate(events: GameOdds[], dayKey: string): string | null {
  let best: Date | null = null;
  for (const ev of events) {
    const start = parseIso(ev.commenceTime);
    if (!start) continue;
    if (etDayKey(start) <= dayKey) continue;
    if (!best || start.getTime() < best.getTime()) best = start;
  }
  return best ? etShortDate(best) : null;
}

/**
 * Build the desk's read of TODAY'S board across every league it covers.
 *
 * Deterministic: same snapshots + same `now` → same brief. No model, no network.
 */
export function buildTodaySlate(deps: SlateDeps = {}): TodaySlate {
  const now = deps.now ?? new Date();
  const oddsFn = deps.odds ?? getOdds;
  const dayKeyEt = etDayKey(now);

  const leagues: LeagueSlate[] = [];
  for (const league of SCHEDULE_LEAGUES) {
    let fetchedAt: string | null = null;
    let events: GameOdds[] = [];
    try {
      const res = oddsFn(league);
      fetchedAt = res.fetchedAt;
      events = res.events;
    } catch (err) {
      // A single unreadable league feed must not take the whole schedule down;
      // it reports as dark WITH a note saying the board is unreadable, which is
      // the honest thing to say.
      console.error(`[chat/slate] odds read failed for ${league}:`, err);
      leagues.push({
        league,
        gameCount: 0,
        games: [],
        linesRefreshedEt: null,
        nextSlateDateEt: null,
        note: `${league}: the board is not readable right now, so I can't tell you what's on.`,
      });
      continue;
    }

    const games = gamesOnDay(events, dayKeyEt, now);
    const refreshed = parseIso(fetchedAt);
    const linesRefreshedEt = refreshed
      ? `${etClock(refreshed)} on ${etShortDate(refreshed)}`
      : null;
    const nextSlateDateEt = games.length === 0 ? nextSlateDate(events, dayKeyEt) : null;

    let note: string;
    if (games.length > 0) {
      note =
        `${league}: ${games.length} game${games.length === 1 ? "" : "s"} on the board today` +
        (linesRefreshedEt ? `, lines last refreshed ${linesRefreshedEt}.` : ".");
    } else if (nextSlateDateEt) {
      note = `${league}: nothing today — the next ${league} game on the board is ${nextSlateDateEt}.`;
    } else {
      note = `${league}: nothing on the board today, and no upcoming ${league} game in the snapshot.`;
    }

    leagues.push({
      league,
      gameCount: games.length,
      games,
      linesRefreshedEt,
      nextSlateDateEt,
      note,
    });
  }

  const gameCount = leagues.reduce((sum, l) => sum + l.gameCount, 0);
  const live = leagues.filter((l) => l.gameCount > 0).map((l) => l.league);
  const dark = leagues.filter((l) => l.gameCount === 0).map((l) => l.league);

  const note =
    gameCount === 0
      ? `Nothing on the board anywhere today (${etLongDate(now)} ET). Dark: ${dark.join(", ")}.`
      : `Today is ${etLongDate(now)} ET. On the board: ${live.join(", ")}.` +
        (dark.length > 0 ? ` Dark today: ${dark.join(", ")}.` : "") +
        " NFL rows here are SCHEDULE ONLY — the desk's NFL read lives on the published /nfl board, not this lane.";

  return {
    dateEt: etLongDate(now),
    dayKeyEt,
    nowEt: etClock(now),
    gameCount,
    leagues,
    note,
  };
}

/**
 * Games-today count per league, keyed the way the router wants it. This is the
 * ONLY honest answer to "which leagues have games tonight" — the slate-entity
 * index counts every event in the file, including an October NBA preseason game
 * and next week's WNBA slate, and routing a "what's on tonight" question off
 * that count is how a September question landed on an empty NBA board.
 */
export function gamesTodayByLeague(deps: SlateDeps = {}): Map<ScheduleLeague, number> {
  const slate = buildTodaySlate(deps);
  const out = new Map<ScheduleLeague, number>();
  for (const l of slate.leagues) out.set(l.league, l.gameCount);
  return out;
}
