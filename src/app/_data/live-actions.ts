// live-actions.ts — the file-backed half of the front page's "today" list.
//
// Reads, read-only, three things under data/processed:
//   nfl-live/board-*.json — the latest published board (highest season, then
//                           week); its PLAY legs inside the 4h live window
//                           become NFL rows. PASS and CONTROL never leave here.
//   nfl-slate.json        — the sharp week board, for the "next board" line.
//   latest-odds-api-*.json (NBA · MLB · WNBA) — only their fetchedAt and
//                           commence_time fields, to say honestly whether the
//                           slate behind "tonight" is today's.
//
// Server only (node:fs). Imported by src/app/page.tsx and nothing else — a
// client component must never import this module.
//
// EVERY file read here must be covered by next.config.ts
// outputFileTracingIncludes["/"]. The paths are built at runtime, the tracer
// cannot follow them, and a missing entry ships an EMPTY LIST over perfectly
// good committed data — silently, with a green build. It has happened on /nfl.

import fs from "node:fs";
import path from "node:path";
import type { PublishedBoard } from "@/lib/nfl-receipts/board";
import { gameRows } from "@/lib/nfl-receipts/receipts-view";
import type { NflSlate } from "@/lib/nfl-receipts/site-slate";
import { MLB_ODDS_FILE } from "@/lib/mlb-prop-plays-loader";
import {
  LIVE_WINDOW_MS,
  latestBoardFile,
  nextBoardLine,
  parseMs,
  slateFreshness,
  type NflLiveLeg,
  type SlateFreshness,
} from "@/lib/today-list";

const PROCESSED_DIR = path.join(process.cwd(), "data", "processed");
const NFL_DIR = path.join(PROCESSED_DIR, "nfl-live");

/** The agent's leagues. NFL is deliberately absent: its rows come from the
 *  published board, not from an odds snapshot. */
const AGENT_ODDS_FILES = [
  "latest-odds-api-basketball_nba.json",
  MLB_ODDS_FILE,
  "latest-odds-api-basketball_wnba.json",
] as const;

type OddsSnapshotHead = {
  fetchedAt?: unknown;
  events?: Array<{ commence_time?: unknown }>;
};

/** Absent → null (the section degrades to its empty copy). Present but
 *  unparseable → null AND a log line, because "the file is malformed" must
 *  not render identically to "there is nothing today". */
function readJsonFile<T>(abs: string): T | null {
  if (!fs.existsSync(abs)) return null;
  try {
    return JSON.parse(fs.readFileSync(abs, "utf-8")) as T;
  } catch (err) {
    console.error(`[live-actions] ${path.basename(abs)} present but unparseable`, err);
    return null;
  }
}

export interface LiveActions {
  /** PLAY legs from the latest board still inside their live window. */
  nflLegs: NflLiveLeg[];
  board: { season: number; week: number } | null;
  /** Board files on disk. Zero in prod is either pre-season or a tracing
   *  miss; the page states the absence either way rather than hiding it. */
  boardsFound: number;
  /** The board half of the "Next" line, ready to print. */
  nextBoard: string;
  freshness: SlateFreshness;
}

export function loadLiveActions(nowMs: number = Date.now()): LiveActions {
  // 1. The latest published board.
  let board: PublishedBoard | null = null;
  let boardsFound = 0;
  if (fs.existsSync(NFL_DIR)) {
    const names = fs.readdirSync(NFL_DIR).filter((f) => /^board-\d{4}-wk\d{2}\.json$/.test(f));
    boardsFound = names.length;
    const name = latestBoardFile(names);
    if (name) board = readJsonFile<PublishedBoard>(path.join(NFL_DIR, name));
  }
  if (board && !Array.isArray(board.legs)) board = null;

  const nflLegs: NflLiveLeg[] = [];
  let lastKickoffUtc: string | null = null;
  if (board) {
    for (const leg of board.legs) {
      const ms = parseMs(leg.kickoffUtc);
      if (ms !== null && (lastKickoffUtc === null || ms > (parseMs(lastKickoffUtc) ?? 0))) {
        lastKickoffUtc = leg.kickoffUtc;
      }
    }
    for (const row of gameRows(board)) {
      if (row.verdict !== "PLAY") continue;
      const ms = parseMs(row.kickoffUtc);
      if (ms === null || ms + LIVE_WINDOW_MS <= nowMs) continue;
      nflLegs.push({
        legId: row.legId,
        season: board.season,
        week: board.week,
        publishedAt: board.publishedAt,
        matchup: row.matchup,
        awayAbbr: row.awayAbbr,
        homeAbbr: row.homeAbbr,
        selectedAbbr: row.selectedAbbr,
        opponentAbbr: row.opponentAbbr,
        selectedIsAway: row.selectedIsAway,
        kickoffUtc: row.kickoffUtc,
        modelPct: row.modelPct,
        marketPct: row.marketPct,
        gapPp: row.gapPp,
        entryPriceAmerican: row.entryPriceAmerican,
        book: row.book,
        snapshotFetchedAt: row.snapshotFetchedAt,
        clvEligible: row.clvEligible,
      });
    }
  }

  // 2. The sharp slate, for the next-board line.
  const slate = readJsonFile<NflSlate>(path.join(PROCESSED_DIR, "nfl-slate.json"));
  const slateKickoffs =
    slate && Array.isArray(slate.games)
      ? slate.games.map((g) => g.kickoffUtc).filter((k): k is string => typeof k === "string")
      : [];
  const nextBoard =
    boardsFound === 0
      ? `NFL: no board on file — ${nextBoardLine({ latestBoard: null, slateKickoffs }, nowMs)}`
      : nextBoardLine(
          {
            latestBoard: board ? { season: board.season, week: board.week, lastKickoffUtc } : null,
            slateKickoffs,
          },
          nowMs,
        );

  // 3. Is the slate behind "tonight" today's? Newest fetchedAt across the
  //    agent leagues; every commence_time, judged against today in ET.
  let fetchedAt: string | null = null;
  const commenceTimes: string[] = [];
  for (const file of AGENT_ODDS_FILES) {
    const head = readJsonFile<OddsSnapshotHead>(path.join(PROCESSED_DIR, file));
    if (!head) continue;
    if (typeof head.fetchedAt === "string" && parseMs(head.fetchedAt) !== null) {
      if (fetchedAt === null || (parseMs(head.fetchedAt) ?? 0) > (parseMs(fetchedAt) ?? 0)) {
        fetchedAt = head.fetchedAt;
      }
    }
    for (const e of head.events ?? []) {
      if (typeof e?.commence_time === "string") commenceTimes.push(e.commence_time);
    }
  }
  const freshness = slateFreshness({ fetchedAt, commenceTimes }, nowMs);

  return {
    nflLegs,
    board: board ? { season: board.season, week: board.week } : null,
    boardsFound,
    nextBoard,
    freshness,
  };
}
