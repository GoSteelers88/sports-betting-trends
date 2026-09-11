// nfl-model-from-board.ts — nfl-model.json, derived from the PUBLISHED /nfl
// doctrine board. This is the analyst pipeline's `get_model_probabilities(NFL)`
// feed, in the same envelope NBA / WNBA / NHL use (outer { generatedAt, data:
// { results } }), so tools/index.ts, health.ts and the dashboard read it through
// the path they already have.
//
// WHY THE BOARD, NOT A SECOND MODEL. The repo already carries one NFL model —
// the Experiment No. 5 loop (LLM blind pick → beta calibration fitted on the
// walk's graded record → ¼-Kelly in code → 2026 doctrine post-pass). Its output
// is the committed, immutable, notarized board at data/processed/nfl-live/.
// Building a second NFL model for the account would put two NFL opinions in
// one repo; this file makes the account's NFL picks a strict SUBSET of what the
// doctrine board plays.
//
// THE RULE THAT MAKES THAT TRUE: a PASS game is pinned to the de-vigged market.
//   • PLAY leg  → the calibrated probability of the played side (what the
//                 stake was sized on) and 1 − p for the other side.
//   • PASS leg  → fair probability of the leg's side under the POWER devig of
//                 the leg's own two-sided entry price — i.e. ZERO edge by
//                 construction. The analyst still sees the whole slate (health
//                 checks compare model count to odds count) but can only find
//                 an edge where the doctrine found one. Its pass reason travels
//                 in `notes` so the analyst can cite why it is not a play.
//   • control legs (the placebo arm) are never a model read — skipped.
//   • legs whose kickoff has passed are dropped: a probability for a game that
//     is over is not a forecast, and the odds feed will not carry it anyway.
//
// Pure over its inputs (board + clock); the script wraps it with fs.

import { devigTwoWay } from "./nfl-devig";
import { FRANCHISES, franchiseKey } from "./nfl-receipts/teams";
import type { PublishedBoard, PublishedLeg } from "./nfl-receipts/board";

export type NflModelGame = {
  /** Odds API event id from the leg's price provenance (audit trail only —
   *  every consumer joins on team names, never on this id). */
  eventId: string;
  homeTeam: string; // full Odds API display name, e.g. "Seattle Seahawks"
  awayTeam: string;
  homeWinProb: number;
  awayWinProb: number;
  expectedMargin: null;
  calibrated: true;
  startTime: string; // kickoffUtc
  verdict: "PLAY" | "PASS";
  notes: string[];
};

export type NflModelOutput = {
  generatedAt: string;
  source: "nfl-live-board";
  status: "ok" | "no-games";
  freshnessMins: number;
  recordCount: number;
  errors: string[];
  boardFile: string | null;
  boardPublishedAt: string | null;
  season: number | null;
  week: number | null;
  data: {
    generatedAt: string;
    gameCount: number;
    results: NflModelGame[];
  };
};

/** Games whose kickoff is older than this are over and are not a forecast. */
const PAST_KICKOFF_GRACE_MS = 6 * 60 * 60 * 1000;

const FULL_NAME_BY_KEY = new Map(FRANCHISES.map((f) => [f.key, f.fullName]));

/** "NE" / "GB" / "Green Bay Packers" → "Green Bay Packers"; null when the
 *  spelling is not one this pipeline knows (never fuzzy-matched — a wrong
 *  join lands a probability on the wrong game). */
export function fullTeamName(name: string): string | null {
  const key = franchiseKey(name);
  return key ? (FULL_NAME_BY_KEY.get(key) ?? null) : null;
}

function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

export function emptyNflModel(nowIso: string, reason: string): NflModelOutput {
  return {
    generatedAt: nowIso,
    source: "nfl-live-board",
    status: "no-games",
    freshnessMins: 0,
    recordCount: 0,
    errors: [reason],
    boardFile: null,
    boardPublishedAt: null,
    season: null,
    week: null,
    data: { generatedAt: nowIso, gameCount: 0, results: [] },
  };
}

function isModelLeg(l: PublishedLeg): boolean {
  return l.market === "moneyline" && l.role !== "control";
}

/** Build the model envelope from one published board. `nowMs` is injected so
 *  the past-kickoff filter is testable without a clock. */
export function buildNflModelFromBoard(
  board: PublishedBoard,
  boardFile: string,
  nowMs: number,
): NflModelOutput {
  const nowIso = new Date(nowMs).toISOString();
  const errors: string[] = [];
  const results: NflModelGame[] = [];

  for (const leg of board.legs.filter(isModelLeg)) {
    const kickoffMs = Date.parse(leg.kickoffUtc);
    if (!Number.isFinite(kickoffMs)) {
      errors.push(`${leg.matchup}: unparseable kickoff "${leg.kickoffUtc}" — skipped`);
      continue;
    }
    if (kickoffMs < nowMs - PAST_KICKOFF_GRACE_MS) continue; // game is over

    const [awayRaw, homeRaw] = leg.matchup.split("@").map((s) => s.trim());
    const homeTeam = homeRaw ? fullTeamName(homeRaw) : null;
    const awayTeam = awayRaw ? fullTeamName(awayRaw) : null;
    if (!homeTeam || !awayTeam) {
      errors.push(`${leg.matchup}: unrecognised team name — skipped (no fuzzy match)`);
      continue;
    }

    let sideProb: number;
    let verdict: "PLAY" | "PASS";
    const notes: string[] = [];

    if (leg.role === "play" && typeof leg.calibratedConfidence === "number") {
      sideProb = leg.calibratedConfidence;
      verdict = "PLAY";
      notes.push(
        `doctrine: PLAY ${leg.selection} — calibrated ${pct(sideProb)}` +
          (typeof leg.edge === "number" ? `, edge vs entry ${pct(leg.edge)}` : ""),
      );
    } else {
      // PASS (or a PLAY leg the board published without a calibrated read):
      // pin to the market so the analyst cannot manufacture an edge here.
      if (leg.entryPriceAmerican == null || leg.entryOtherSideAmerican == null) {
        errors.push(`${leg.matchup}: PASS leg with no two-sided entry price — skipped`);
        continue;
      }
      sideProb = devigTwoWay(leg.entryPriceAmerican, leg.entryOtherSideAmerican).byMethod.power;
      verdict = "PASS";
      notes.push(
        `doctrine: PASS ${leg.selection}` + (leg.passReason ? ` — ${leg.passReason}` : ""),
        "probability pinned to the de-vigged (power) entry market — no playable edge by doctrine; do not manufacture one",
      );
      if (typeof leg.calibratedConfidence === "number") {
        notes.push(`model read for reference only: calibrated ${pct(leg.calibratedConfidence)}`);
      }
    }
    for (const n of leg.doctrineNotes ?? []) notes.push(n);

    const homeWinProb = leg.side === "home" ? sideProb : 1 - sideProb;
    results.push({
      eventId: leg.priceProvenance?.oddsApiEventId ?? leg.gameId,
      homeTeam,
      awayTeam,
      homeWinProb: +homeWinProb.toFixed(4),
      awayWinProb: +(1 - homeWinProb).toFixed(4),
      expectedMargin: null,
      calibrated: true,
      startTime: leg.kickoffUtc,
      verdict,
      notes,
    });
  }

  results.sort(
    (a, b) => a.startTime.localeCompare(b.startTime) || a.homeTeam.localeCompare(b.homeTeam),
  );

  const publishedMs = Date.parse(board.publishedAt);
  return {
    generatedAt: nowIso,
    source: "nfl-live-board",
    status: results.length > 0 ? "ok" : "no-games",
    freshnessMins: Number.isFinite(publishedMs)
      ? Math.max(0, Math.round((nowMs - publishedMs) / 60_000))
      : 0,
    recordCount: results.length,
    errors,
    boardFile,
    boardPublishedAt: board.publishedAt,
    season: board.season,
    week: board.week,
    data: { generatedAt: nowIso, gameCount: results.length, results },
  };
}

/** The board to model = the latest (season, week) the ledger has registered.
 *  Boards are immutable and registered at publish, so the ledger is the index. */
export function latestBoardFile(
  boards: Array<{ file: string; season: number; week: number }>,
): string | null {
  let best: { file: string; season: number; week: number } | null = null;
  for (const b of boards) {
    if (!best || b.season > best.season || (b.season === best.season && b.week > best.week)) {
      best = b;
    }
  }
  return best?.file ?? null;
}
