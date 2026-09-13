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
import { friendlyFile } from "./fallback";

export const ET_ZONE = "America/New_York";

// The leagues a schedule answer covers. NBA/MLB/WNBA are the bets lane. NFL is
// carried for the SCHEDULE ONLY — the desk's NFL read lives on the receipts lane
// (/nfl), and the schedule prompt says so — because "what's on today" is a
// calendar question and answering it with three of the four leagues is a lie of
// omission on a Saturday in September.
export const SCHEDULE_LEAGUES = ["MLB", "NFL", "NBA", "WNBA"] as const;
export type ScheduleLeague = (typeof SCHEDULE_LEAGUES)[number];

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

// ─── Which DAY the reader asked about ────────────────────────────────────────
//
// MEASURED 2026-09-12 21:23 ET: "what games are on tomorrow?" routed to a
// today-only tool, and the desk answered "'Tomorrow' is Sunday, September 13,
// and that board isn't live yet" — while the MLB snapshot held 9 rows dated
// 2026-09-13 ET and the NFL snapshot held 13, every one of them priced. The
// desk denied a board it was holding.
//
// The snapshots already carry those rows, so the fix is a filter argument, not
// a feed. Resolution happens HERE, in code, from the server clock — a model
// that is bad at date arithmetic (it read today's date off a stale file once
// already) must never compute "which day is Sunday".
export type SlateDayRequest = string | undefined;

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const;

const WEEKDAY_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: ET_ZONE,
  weekday: "long",
});

/** The ET weekday index (0 = Sunday) of an instant. */
function etWeekdayIndex(d: Date): number {
  const name = WEEKDAY_FMT.format(d).toLowerCase();
  const i = WEEKDAYS.indexOf(name as (typeof WEEKDAYS)[number]);
  return i < 0 ? 0 : i;
}

export type ResolvedDay = {
  /** The ET calendar day the rows are filtered to. */
  dayKeyEt: string;
  /** Whole ET days ahead of today (0 = today). */
  offsetDays: number;
  /** How the reader named it, normalized: "today" | "tomorrow" | "Sunday". */
  label: string;
};

/**
 * Resolve a caller's day word to an ET calendar day. Pure over `now`.
 *
 * Accepts "today" (or nothing), "tomorrow", and a weekday name — the NEXT
 * occurrence, with today counting as itself (asked "Saturday" on a Saturday,
 * you mean today). Anything unrecognised resolves to TODAY rather than
 * guessing: an unparsed day word must degrade to the safe read, never to a
 * silently different date.
 */
export function resolveSlateDay(now: Date, day: SlateDayRequest): ResolvedDay {
  const raw = (day ?? "").trim().toLowerCase().replace(/^(?:on|this|next)\s+/, "");
  let offsetDays = 0;
  if (raw === "tomorrow") {
    offsetDays = 1;
  } else if (raw && raw !== "today" && raw !== "tonight") {
    // The WHOLE word must be a prefix of the weekday — not just its first three
    // letters. Matching on a 3-char slice made "next month" resolve to MONDAY
    // (caught by the unrecognised-input control below), which is exactly the
    // class of silent wrong-date this function exists to prevent.
    const target = raw.length >= 3 ? WEEKDAYS.findIndex((w) => w.startsWith(raw)) : -1;
    if (target >= 0) {
      offsetDays = (target - etWeekdayIndex(now) + 7) % 7;
    }
  }
  const at = new Date(now.getTime() + offsetDays * 86_400_000);
  return {
    dayKeyEt: etDayKey(at),
    offsetDays,
    label:
      offsetDays === 0
        ? "today"
        : offsetDays === 1
          ? "tomorrow"
          : WEEKDAY_FMT.format(at),
  };
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
  /**
   * "ok" = the desk can SEE this league's board. "warned" = the snapshot is
   * missing, malformed, stale, or of unknown age, so `gameCount: 0` means
   * "I cannot tell you", NOT "nothing is on".
   *
   * THE BUG THIS EXISTS FOR: `getOdds` never throws for a missing/malformed/
   * stale file — the loader returns `{events: []}` with a status and attaches a
   * `dataWarning` (tools/index.ts:81,104). Round 1 of this module read only
   * `fetchedAt` and `events`, so a failed odds refresh produced a payload that
   * said "nothing on the board today, and no upcoming MLB game in the
   * snapshot" — on a 15-game Saturday — and the schedule prompt tells the model
   * that note is safe to read aloud verbatim. A data outage became a confident
   * lie, with no per-turn log line (the loader's warning is de-duplicated once
   * per process) and nothing in `[chat/turn]` telling dark from unreadable.
   */
  feedStatus: "ok" | "warned";
  /**
   * The warning in the desk's own voice, with the filename stripped: "the MLB
   * odds snapshot hasn't refreshed in 94.2 hours". Null when feedStatus is
   * "ok". The AGE is quotable because collectAgeRaws exempts age phrases in the
   * reply — see grounding.ts.
   */
  feedWarning: string | null;
  /** Honest one-liner the desk can read aloud verbatim. */
  note: string;
};

export type TodaySlate = {
  /** How the reader named the day: "today" | "tomorrow" | "Sunday". */
  requestedDay: string;
  /** True when the read is for today (so `started` flags mean something). */
  isToday: boolean;
  /** "Saturday, September 12, 2026" — the RESOLVED day, not necessarily today. */
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
  // Mirrors getOdds EXACTLY, dataWarning included. Round 1 typed this without
  // dataWarning, which is how the field got dropped on the floor: the narrower
  // dep type made the omission invisible to the compiler.
  odds?: (league: AgentLeague) => {
    fetchedAt: string | null;
    events: GameOdds[];
    dataWarning?: string;
  };
  now?: Date;
  /** "today" (default) | "tomorrow" | a weekday name. Resolved by resolveSlateDay. */
  day?: SlateDayRequest;
};

// Turn a loader warning into the desk's voice, without the filename.
//   "DATA WARNING: mlb-model-output.json is 94.2h old (stale > 6h)…"
//     -> "the MLB model hasn't refreshed in 94.2 hours"
//   "DATA ERROR: latest-odds-api-baseball_mlb.json is missing…"
//     -> "the MLB odds snapshot isn't readable right now"
export function describeFeedWarning(warning: string): string {
  const fileMatch = /([A-Za-z0-9._-]+\.json)/.exec(warning);
  const what = fileMatch ? friendlyFile(fileMatch[1]!) : "the odds snapshot";
  const ageMatch = /is\s+(\d+(?:\.\d+)?)h old/.exec(warning);
  if (ageMatch) return `${what} hasn't refreshed in ${ageMatch[1]} hours`;
  if (/is missing/.test(warning)) return `${what} isn't readable right now`;
  if (/malformed/.test(warning)) return `${what} came back unreadable`;
  if (/no freshness metadata/.test(warning)) return `${what} has no readable timestamp`;
  return `${what} isn't clean right now`;
}

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
  const requested = resolveSlateDay(now, deps.day);
  const dayKeyEt = requested.dayKeyEt;
  const isToday = requested.offsetDays === 0;
  // The instant the resolved day is named from (for dateEt/etLongDate). For a
  // future day this is NOT `now`.
  const dayAt = new Date(now.getTime() + requested.offsetDays * 86_400_000);

  const leagues: LeagueSlate[] = [];
  for (const league of SCHEDULE_LEAGUES) {
    let fetchedAt: string | null = null;
    let events: GameOdds[] = [];
    // The loader's own warning, when the snapshot is missing / malformed /
    // stale / of unknown age. READ IT. This is the difference between "nothing
    // is on" and "I cannot see whether anything is on".
    let warning: string | null = null;
    try {
      const res = oddsFn(league);
      fetchedAt = res.fetchedAt;
      events = res.events;
      warning = res.dataWarning ?? null;
    } catch (err) {
      // getOdds does not currently throw for a bad file (it degrades with a
      // dataWarning), but a future reader might. Treat a throw as the hardest
      // possible warning.
      console.error(`[chat/slate] odds read THREW for ${league}:`, err);
      warning = `DATA ERROR: the ${league} board is missing.`;
      events = [];
    }

    const games = gamesOnDay(events, dayKeyEt, now);
    const refreshed = parseIso(fetchedAt);
    const linesRefreshedEt = refreshed
      ? `${etClock(refreshed)} on ${etShortDate(refreshed)}`
      : null;
    // A next-slate date read out of an unreadable file is not a fact. Only
    // offer one when the feed is clean.
    const nextSlateDateEt =
      games.length === 0 && !warning ? nextSlateDate(events, dayKeyEt) : null;
    const dayPhrase = isToday ? "today" : requested.label;

    const feedStatus: "ok" | "warned" = warning ? "warned" : "ok";
    const feedWarning = warning ? describeFeedWarning(warning) : null;

    if (warning) {
      // ONE line per turn, per league, so "why did the desk say nothing is on?"
      // is answerable at 3am by correlating with the turn's requestId. The
      // loader's own warning fires once per PROCESS (tools/index.ts:62,111), so
      // after cold start it is not in the log at all.
      console.warn(
        `[chat/slate] ${league} feed WARNED (gamesToday=${games.length}): ${warning}`
      );
    }

    let note: string;
    if (games.length > 0) {
      note =
        `${league}: ${games.length} game${games.length === 1 ? "" : "s"} on the board ${dayPhrase}` +
        (linesRefreshedEt ? `, lines last refreshed ${linesRefreshedEt}` : "") +
        (feedWarning ? `. Heads up: ${feedWarning}.` : ".");
    } else if (warning) {
      // THE INVARIANT: never assert an empty day off a feed we cannot read.
      note =
        `${league}: I can't see ${dayPhrase === "today" ? "today's" : `${dayPhrase}'s`} ${league} board — ${feedWarning}` +
        (linesRefreshedEt ? ` (last refreshed ${linesRefreshedEt})` : "") +
        `. I'm not going to tell you nothing is on when I can't confirm it.`;
    } else if (nextSlateDateEt) {
      note = `${league}: nothing ${dayPhrase} — the next ${league} game on the board is ${nextSlateDateEt}.`;
    } else {
      note = `${league}: nothing on the board ${dayPhrase}, and no upcoming ${league} game in the snapshot.`;
    }

    leagues.push({
      league,
      gameCount: games.length,
      games,
      linesRefreshedEt,
      nextSlateDateEt,
      feedStatus,
      feedWarning,
      note,
    });
  }

  const gameCount = leagues.reduce((sum, l) => sum + l.gameCount, 0);
  const live = leagues.filter((l) => l.gameCount > 0).map((l) => l.league);
  const dark = leagues.filter((l) => l.gameCount === 0 && l.feedStatus === "ok");
  const blind = leagues.filter((l) => l.feedStatus === "warned");

  const darkNames = dark.map((l) => l.league).join(", ");
  const blindClause =
    blind.length > 0
      ? ` I can't see the ${blind.map((l) => l.league).join(", ")} board${blind.length === 1 ? "" : "s"} right now — ${blind
          .map((l) => l.feedWarning)
          .filter(Boolean)
          .join("; ")}. Say so; do NOT report those leagues as having no games.`
      : "";

  // "Nothing is on anywhere" is only sayable when EVERY league's feed is clean.
  const note =
    gameCount === 0 && blind.length === 0
      ? `Nothing on the board anywhere ${isToday ? "today" : requested.label} (${etLongDate(dayAt)} ET). Dark: ${darkNames}.`
      : `${isToday ? "Today" : `That day (${requested.label})`} is ${etLongDate(dayAt)} ET.` +
        (live.length > 0 ? ` On the board: ${live.join(", ")}.` : "") +
        (darkNames ? ` Dark today: ${darkNames}.` : "") +
        blindClause +
        " NFL rows here are SCHEDULE ONLY — the desk's NFL read lives on the published /nfl board, not this lane.";

  return {
    requestedDay: requested.label,
    isToday,
    dateEt: etLongDate(dayAt),
    dayKeyEt,
    nowEt: etClock(now),
    gameCount,
    leagues,
    note,
  };
}
