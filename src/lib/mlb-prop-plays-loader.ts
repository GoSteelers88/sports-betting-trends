// mlb-prop-plays-loader.ts — the DISK SHELL for the MLB model prop-plays board.
//
// This is the shared, testable loader that BOTH the server-rendered dashboard
// ("MLB Prop Plays") and the chat desk's get_model_prop_board tool call. Before
// this module existed, the disk-reading shell lived as a private function in
// src/app/_data/dashboard.ts — so the dashboard showed a full model HR board
// while the chat desk (which only had the MARKET +EV prop tools) truthfully but
// uselessly said "no HR props." Extracting the shell here gives the desk a window
// onto the exact same board the dashboard renders.
//
// Pattern (mirrors the getPropsBoard fix, commit 3861586): a PURE core
// (buildMlbPropPlays in mlb-prop-plays.ts — no fs) plus this thin, INJECTABLE
// disk shell. The shell reads the JSON snapshots, applies the sharp/soft
// FRESHNESS gate (a stale market overlay is dropped, model-only ladders kept),
// computes tonight's slate teams from the odds feed, and delegates to the pure
// core. `dir` is parameterized so tests can point at a fixture directory, and
// `nowMs` is injectable so freshness math is deterministic.

import fs from "node:fs";
import path from "node:path";
import {
  buildMlbPropPlays,
  type MlbPropPlaysBoard,
  type SharpPropRow,
  type SoftQuoteRow,
} from "./mlb-prop-plays";
import type { MlbGameLogFile } from "./mlb-prop-distributions";
import {
  slateTeamsFromEvents,
  isTeamOnSlate,
  mlbSlateEvents,
  easternDateOf,
} from "./injuries-scope";
import { assessFreshness, MAX_AGE_HOURS } from "./data-freshness";

// The default snapshot directory (production path). Tests override via opts.dir.
const DEFAULT_PROCESSED = path.resolve(process.cwd(), "data", "processed");

// The MLB odds snapshot filename — the SINGLE SOURCE for this string. dashboard.ts
// references it as ODDS_FILE.MLB (imports it from here) so a future feed rename
// can't silently diverge the two sides (readJsonFrom fail-softs with no log, so a
// mismatched name would quietly empty/mis-scope the board). Loader → dashboard is
// a one-way import (dashboard already imports loadMlbPropPlays from here), so no
// cycle is introduced.
export const MLB_ODDS_FILE = "latest-odds-api-baseball_mlb.json";

// ─── minimal file shapes (subset of each snapshot we read) ───────────────────

type RawOddsEvent = { commence_time?: string; home_team?: string; away_team?: string };
type RawOddsFile = { fetchedAt?: string; events?: RawOddsEvent[] };

type SharpPropsFileShape = { fetchedAt?: string; props?: SharpPropRow[] };
type SoftPropsFileShape = { fetchedAt?: string; quotes?: SoftQuoteRow[] };

// Tonight's probable starting pitchers, from the MLB Stats API ingest. Shape:
// { games: [{ homePitcher: { name }, awayPitcher: { name } }] }. Used to gate
// pitcher prop ladders so non-starters can't surface phantom K/ER plays.
type PitchersTodayFile = {
  games?: Array<{
    homePitcher?: { name?: string } | null;
    awayPitcher?: { name?: string } | null;
  }>;
};

// ─── injectable disk reader ──────────────────────────────────────────────────

// Read a data/processed JSON file from `dir` synchronously. Returns the caller's
// fallback on any read/parse error (mirrors dashboard.ts's local readJson) — a
// missing/corrupt file degrades to an empty board, never throws.
function readJsonFrom<T>(dir: string, file: string, fallback: T): T {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    // A file body of literal `null` (or any non-object primitive) parses fine but
    // is NOT a usable envelope — a later `.events`/`.props`/`.fetchedAt` access
    // would throw, falsifying getModelPropBoard's "Never throws" contract. Only
    // objects and arrays are valid shapes here (RawOddsFile, prop files, gamelog,
    // pitchers-today, and the null-gamelog fallback are all objects/arrays), so a
    // bare-null/primitive body degrades to the caller's fallback like any error.
    // NOTE: fallback may itself be `null` (the gamelog default) — that is passed
    // deliberately by the caller and buildMlbPropPlays handles a null gamelog.
    if (parsed === null || typeof parsed !== "object") {
      return fallback;
    }
    return parsed as T;
  } catch {
    return fallback;
  }
}

// The feed's own primary slate date = the MOST COMMON US-Eastern game-date among
// the (already MLB-filtered) events. Returns null when there are no dated events.
// We scope the prop board to this — derived from the data, never the wall clock —
// so the board reflects "the games in this feed" regardless of when it renders.
// (Moved verbatim from dashboard.ts so the loader is self-contained.)
export function primaryEasternSlateDate(
  events: Array<{ commence_time?: string }>,
): string | null {
  const counts = new Map<string, number>();
  for (const e of events) {
    const d = easternDateOf(e.commence_time);
    if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [d, n] of counts) {
    // Tie-break toward the EARLIER date (the sooner slate is "today's").
    if (n > bestN || (n === bestN && best !== null && d < best)) {
      best = d;
      bestN = n;
    }
  }
  return best;
}

// ─── the shell ───────────────────────────────────────────────────────────────

/**
 * Build the by-stat MLB ladder board from the gamelog distribution model, scoped
 * to tonight's MLB slate teams, with a FRESH-only sharp/soft market overlay.
 * Pure read — any missing file degrades to an empty board (the dashboard section
 * hides; the chat tool reports available:false).
 *
 * @param opts.dir   snapshot directory (defaults to <cwd>/data/processed).
 * @param opts.nowMs "now" in ms for the freshness gates + window-age math
 *                   (defaults to Date.now()); injectable for deterministic tests.
 *
 * This is byte-for-byte the logic that used to live as the private
 * loadMlbPropPlays() in src/app/_data/dashboard.ts.
 */
export function loadMlbPropPlays(
  opts: { dir?: string; nowMs?: number } = {},
): MlbPropPlaysBoard {
  const dir = opts.dir ?? DEFAULT_PROCESSED;
  const nowMs = opts.nowMs ?? Date.now();

  const gamelog = readJsonFrom<MlbGameLogFile | null>(dir, "player-gamelogs-mlb.json", null);
  const odds = readJsonFrom<RawOddsFile>(dir, MLB_ODDS_FILE, { events: [] });
  const sharpFile = readJsonFrom<SharpPropsFileShape>(dir, "latest-sharp-props-mlb.json", {});
  const softFile = readJsonFrom<SoftPropsFileShape>(dir, "latest-soft-props-mlb.json", {});
  const pitchersToday = readJsonFrom<PitchersTodayFile>(dir, "mlb-pitchers-today.json", {});

  // Market overlay must be FRESH or it's dropped. A stale sharp/soft prop file
  // would overlay yesterday's lines/prices on today's model ladders — a quieter
  // version of the same disease. When a market file is past its freshness budget
  // we pass NO rows for that side, so the board falls back to model-only ladders
  // (honest) instead of showing month-old edges as live. (The gamelog's own
  // staleness is gated inside buildMlbPropPlays, which empties the whole board.)
  const sharpFresh = assessFreshness(sharpFile.fetchedAt ?? null, MAX_AGE_HOURS.PROPS_QUOTE, nowMs).isFresh;
  const softFresh = assessFreshness(softFile.fetchedAt ?? null, MAX_AGE_HOURS.PROPS_QUOTE, nowMs).isFresh;
  const sharp: SharpPropsFileShape = sharpFresh ? sharpFile : {};
  const soft: SoftPropsFileShape = softFresh ? softFile : {};

  // Present file (even with no games) → gate; missing file (default {}, no
  // `games` array) → undefined → gate disabled so a read failure can't silently
  // empty the whole pitcher board.
  const probableStarters = Array.isArray(pitchersToday.games)
    ? pitchersToday.games
        .flatMap(g => [g.homePitcher?.name, g.awayPitcher?.name])
        .filter((n): n is string => typeof n === "string" && n.length > 0)
    : undefined;

  // Slate teams = the real MLB teams on THIS feed's slate. The baseball_mlb
  // endpoint carries NPB/KBO/CPBL/NCAA games AND (via Bovada's preMatchOnly
  // board) can span multiple days, so:
  //  1. mlbSlateEvents strips everything that isn't one of the 30 MLB franchises
  //     (both sides must be MLB) — kills the foreign/college pollution.
  //  2. We then scope to the feed's OWN primary slate date (the modal US-Eastern
  //     game-date among the MLB events), NOT the wall clock. Deriving the date
  //     from the data — not from easternToday() — is critical: the odds snapshot
  //     is static (bundled at build / last ingest), so comparing it to the live
  //     clock would EMPTY the board every night at midnight ET once "today" rolls
  //     past the snapshot's date. Scoping to the feed's own date shows "the games
  //     in the current feed" and never vanishes from clock drift, while still
  //     dropping a stray next-day game on a sparse/multi-day board.
  const mlbTeamEvents = mlbSlateEvents(odds.events ?? []); // MLB-only, no date filter
  const slateDate = primaryEasternSlateDate(mlbTeamEvents);
  const mlbEvents = slateDate
    ? mlbTeamEvents.filter((e) => easternDateOf(e.commence_time) === slateDate)
    : mlbTeamEvents;
  const slateTeams = slateTeamsFromEvents(mlbEvents);
  const isSlateTeam = (team: string | null): boolean =>
    !!team && isTeamOnSlate(team, slateTeams);

  return buildMlbPropPlays({
    gamelog,
    isSlateTeam,
    sharp: sharp.props ?? [],
    soft: soft.quotes ?? [],
    nowMs,
    probableStarters,
  });
}

// ─── CHAT-ONLY slate-status gate ──────────────────────────────────────────────
//
// The DASHBOARD scopes its board to the feed's OWN primary slate date (derived
// from the data, never the wall clock) so it never vanishes at midnight ET — it
// is a "here are the games in the current feed" board, and showing last night's
// slate there is acceptable (it's clearly a static snapshot on a page).
//
// The CHAT desk is different: a conversational "what does the model project
// TONIGHT?" answer must NOT present a finished/started slate as tonight's. So the
// chat shell (getModelPropBoard) calls THIS helper — which reads the SAME odds
// snapshot but judges it against the wall clock — to decide whether the board is
// honestly "tonight's": the odds snapshot must be FRESH (≤ ODDS_SNAPSHOT budget)
// AND at least one MLB game on the feed's slate must still be upcoming
// (commence > now). This mirrors the spirit of getPropsBoard's post-3861586
// commence + freshness gates without touching the dashboard's byte-for-byte
// board build.
//
// Deterministic in (dir, nowMs); pure read, never throws (missing/corrupt odds
// → oddsFresh:false, newestCommenceMs:-Infinity → the caller returns
// available:false honestly).
export type MlbPropSlateStatus = {
  /** The odds snapshot's fetchedAt is within the ODDS_SNAPSHOT budget. */
  oddsFresh: boolean;
  /** ms of the LATEST MLB-slate game commence; -Infinity when none/unparseable. */
  newestCommenceMs: number;
  /** true when at least one MLB-slate game is still upcoming (commence > now). */
  hasUpcomingGame: boolean;
};

export function loadMlbPropSlateStatus(
  opts: { dir?: string; nowMs?: number } = {},
): MlbPropSlateStatus {
  const dir = opts.dir ?? DEFAULT_PROCESSED;
  const nowMs = opts.nowMs ?? Date.now();

  const odds = readJsonFrom<RawOddsFile>(dir, MLB_ODDS_FILE, { events: [] });
  const oddsFresh = assessFreshness(
    odds.fetchedAt ?? null,
    MAX_AGE_HOURS.ODDS_SNAPSHOT,
    nowMs,
  ).isFresh;

  // Scope to real MLB franchises on THIS feed's primary slate date (same scoping
  // the board build uses), then take the newest commence among them.
  const mlbTeamEvents = mlbSlateEvents(odds.events ?? []);
  const slateDate = primaryEasternSlateDate(mlbTeamEvents);
  const mlbEvents = slateDate
    ? mlbTeamEvents.filter((e) => easternDateOf(e.commence_time) === slateDate)
    : mlbTeamEvents;

  let newestCommenceMs = -Infinity;
  for (const e of mlbEvents) {
    const t = new Date(e.commence_time ?? "").getTime();
    if (Number.isFinite(t) && t > newestCommenceMs) newestCommenceMs = t;
  }

  return {
    oddsFresh,
    newestCommenceMs,
    hasUpcomingGame: newestCommenceMs > nowMs,
  };
}
