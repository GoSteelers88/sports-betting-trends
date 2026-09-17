// today-list.ts — the pure rules behind the front page's "today" list.
//
// What qualifies as a live action, what state a row is in, how rows order,
// which published board is the latest, whether the odds snapshot behind
// "tonight" is honest, and what the "Next" line says. No fs, no clock except
// the injected `nowMs`, so every rule tests without mocks and the page owns
// "now" (render time under ISR, so ±5 min).
//
// The three states the page must tell apart, honestly:
//   (a) live actions exist;
//   (b) nothing qualifies today — say it once, say what is next;
//   (c) the snapshot is STALE — no game in the odds snapshot falls on today
//       in America/New_York, or the snapshot's fetchedAt is older than 36h —
//       then the page prints the refresh time plainly instead of presenting
//       an old slate as tonight. Measured 2026-09-12: the committed MLB
//       snapshot was Sept 8–9's slate, three days old, and the site said
//       nothing about it.

/** A game's length plus slack: a row stays "in play" this long after start. */
export const LIVE_WINDOW_MS = 4 * 3_600_000;
/** Older than this and the odds snapshot is not "today's". */
export const STALE_AFTER_HOURS = 36;
/** A last agent run older than this prints in the hold tone. */
export const RUN_HOLD_AFTER_HOURS = 26;

export type RowState = "upcoming" | "in play" | "pending";

/** The slice of an agent pick these rules read. */
export interface AgentPickLike {
  id: number;
  edge: number;
  gameDate: string | null;
  outcome: unknown | null;
}

/** A PLAY leg from the latest published board, projected to plain fields the
 *  client list can render. Model %, market % and the gap come from
 *  receipts-view's gameRows — the same helpers /nfl renders with. Never a
 *  stake, unit, ROI or CLV (pre-registration Amendment 1). */
export interface NflLiveLeg {
  legId: string;
  season: number;
  week: number;
  publishedAt: string;
  matchup: string;
  awayAbbr: string;
  homeAbbr: string;
  selectedAbbr: string;
  opponentAbbr: string;
  selectedIsAway: boolean;
  kickoffUtc: string;
  modelPct: number | null;
  marketPct: number | null;
  gapPp: number | null;
  entryPriceAmerican: number | null;
  book: string | null;
  snapshotFetchedAt: string | null;
  clvEligible: boolean;
}

export type TodayRow<P extends AgentPickLike = AgentPickLike> =
  | { kind: "game" | "prop"; startIso: string | null; startMs: number | null; state: RowState; pick: P }
  | { kind: "nfl"; startIso: string; startMs: number; state: RowState; leg: NflLiveLeg };

export function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export function rowState(startMs: number | null, nowMs: number): RowState {
  if (startMs === null) return "pending";
  return startMs > nowMs ? "upcoming" : "in play";
}

/** An agent pick is live while it is ungraded and its game has not been over
 *  for more than the window. A pick with no start time is live until graded. */
export function isLiveAgentPick(p: AgentPickLike, nowMs: number): boolean {
  if (p.outcome !== null && p.outcome !== undefined) return false;
  const start = parseMs(p.gameDate);
  return start === null || start + LIVE_WINDOW_MS > nowMs;
}

export function isInsideLiveWindow(kickoffUtc: string, nowMs: number): boolean {
  const ms = parseMs(kickoffUtc);
  return ms !== null && ms + LIVE_WINDOW_MS > nowMs;
}

const KIND_ORDER: Record<TodayRow["kind"], number> = { game: 0, prop: 1, nfl: 2 };

function edgeOf(row: TodayRow): number {
  return row.kind === "nfl" ? row.leg.gapPp ?? 0 : row.pick.edge;
}

/** The unified list: start time ascending across all kinds; rows with no
 *  start time go last, ordered by edge descending (the old TonightsPlay
 *  convention). PASS and CONTROL legs never reach this function — the loader
 *  hands over PLAY legs only. */
export function buildTodayRows<P extends AgentPickLike>(
  games: P[],
  props: P[],
  legs: NflLiveLeg[],
  nowMs: number,
): TodayRow<P>[] {
  const rows: TodayRow<P>[] = [];
  const agent = (kind: "game" | "prop", list: P[]) => {
    for (const p of list) {
      if (!isLiveAgentPick(p, nowMs)) continue;
      const startMs = parseMs(p.gameDate);
      rows.push({ kind, startIso: startMs === null ? null : p.gameDate, startMs, state: rowState(startMs, nowMs), pick: p });
    }
  };
  agent("game", games);
  agent("prop", props);
  for (const leg of legs) {
    const startMs = parseMs(leg.kickoffUtc);
    if (startMs === null || startMs + LIVE_WINDOW_MS <= nowMs) continue;
    rows.push({ kind: "nfl", startIso: leg.kickoffUtc, startMs, state: rowState(startMs, nowMs), leg });
  }
  rows.sort((a, b) => {
    if (a.startMs !== null && b.startMs !== null) {
      return a.startMs - b.startMs || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || labelOf(a).localeCompare(labelOf(b));
    }
    if (a.startMs !== null) return -1;
    if (b.startMs !== null) return 1;
    return edgeOf(b) - edgeOf(a);
  });
  return rows;
}

function labelOf(row: TodayRow): string {
  return row.kind === "nfl" ? row.leg.matchup : String(row.pick.id);
}

// ─── The latest published board ─────────────────────────────────────────────

const BOARD_FILE = /^board-(\d{4})-wk(\d{2})\.json$/;

/** Highest season, then highest week — never a lexical sort of filenames. */
export function latestBoardFile(names: readonly string[]): string | null {
  let best: { name: string; season: number; week: number } | null = null;
  for (const name of names) {
    const m = BOARD_FILE.exec(name);
    if (!m) continue;
    const season = Number(m[1]);
    const week = Number(m[2]);
    if (!best || season > best.season || (season === best.season && week > best.week)) {
      best = { name, season, week };
    }
  }
  return best?.name ?? null;
}

// ─── ET calendar furniture ──────────────────────────────────────────────────

const ET_DATE_KEY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const ET_DAY_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** "2026-09-12" — the calendar day in New York for an instant. */
export function etDateKey(ms: number): string {
  return ET_DATE_KEY.format(new Date(ms));
}

/** "Tue Sep 9, 8:35 PM ET" — a refresh or kickoff instant, in the
 *  schedule's own timezone, stated as such. */
export function fmtEtDayTime(iso: string): string {
  const ms = parseMs(iso);
  if (ms === null) return "—";
  return `${ET_DAY_TIME.format(new Date(ms))} ET`;
}

// ─── Snapshot freshness ─────────────────────────────────────────────────────

export type StaleReason = "no-snapshot" | "old" | "no-game-today";

export interface SlateFreshness {
  fetchedAt: string | null;
  ageHours: number | null;
  gamesToday: number;
  stale: boolean;
  reason: StaleReason | null;
}

/** Is the odds snapshot behind "tonight" honest as tonight? Stale when it
 *  is older than STALE_AFTER_HOURS, or when no game in it falls on today
 *  (America/New_York). A missing or unparseable timestamp is stale: a file
 *  with no provenance cannot be trusted as live. */
export function slateFreshness(
  input: { fetchedAt: string | null; commenceTimes: readonly string[] },
  nowMs: number,
): SlateFreshness {
  const t = parseMs(input.fetchedAt);
  if (t === null) {
    return { fetchedAt: null, ageHours: null, gamesToday: 0, stale: true, reason: "no-snapshot" };
  }
  const ageHours = +Math.max(0, (nowMs - t) / 3_600_000).toFixed(2);
  const today = etDateKey(nowMs);
  let gamesToday = 0;
  for (const c of input.commenceTimes) {
    const ms = parseMs(c);
    if (ms !== null && etDateKey(ms) === today) gamesToday += 1;
  }
  const base = { fetchedAt: input.fetchedAt, ageHours, gamesToday };
  if (ageHours > STALE_AFTER_HOURS) return { ...base, stale: true, reason: "old" };
  if (gamesToday === 0) return { ...base, stale: true, reason: "no-game-today" };
  return { ...base, stale: false, reason: null };
}

/** "3 days" / "5 hours" / "40 minutes" — for the refresh line. */
export function fmtAgeHours(ageHours: number): string {
  if (ageHours >= 48) return `${Math.floor(ageHours / 24)} days`;
  if (ageHours >= 24) return "1 day";
  if (ageHours >= 2) return `${Math.floor(ageHours)} hours`;
  if (ageHours >= 1) return "1 hour";
  return `${Math.max(1, Math.round(ageHours * 60))} minutes`;
}

/** Whether the last agent run is old enough to print in the hold tone. */
export function runIsStale(lastAgentRunAt: string | null, nowMs: number): boolean {
  const t = parseMs(lastAgentRunAt);
  return t === null || nowMs - t > RUN_HOLD_AFTER_HOURS * 3_600_000;
}

// ─── The "Next" line's board half ───────────────────────────────────────────

export interface NextBoardInput {
  latestBoard: { season: number; week: number; lastKickoffUtc: string | null } | null;
  slateKickoffs: readonly string[];
}

/** The next board sentence, from the data as given. No cron publishes
 *  boards, so this is never a timestamp: it is "at least 12h before" the
 *  first kickoff after the current board's week, when the sharp slate
 *  already carries one; otherwise it says the slate has not rolled yet.
 *  With no board ever published: the week-1 copy already on /nfl. */
export function nextBoardLine(input: NextBoardInput, nowMs: number): string {
  if (!input.latestBoard) {
    return "NFL week 1 board publishes at least 12h before the Thursday kickoff";
  }
  const nextWeek = input.latestBoard.week + 1;
  const floor = Math.max(parseMs(input.latestBoard.lastKickoffUtc) ?? nowMs, nowMs);
  let first: number | null = null;
  for (const k of input.slateKickoffs) {
    const ms = parseMs(k);
    if (ms !== null && ms > floor && (first === null || ms < first)) first = ms;
  }
  if (first !== null) {
    return `NFL week ${nextWeek} board publishes at least 12h before ${fmtEtDayTime(new Date(first).toISOString())}`;
  }
  return `NFL week ${nextWeek} board publishes at least 12h before its first kickoff; the sharp slate has not rolled to week ${nextWeek} yet`;
}
