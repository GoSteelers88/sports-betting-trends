// ledger.ts — the append-only-in-spirit, upsert-in-mechanism CLV ledger for
// the /nfl receipts page (threats T7 + T8).
//
// Everything here is keyed by legId. Re-running capture or grading can only
// ever converge a row toward more information — never duplicate it, never
// silently shrink a denominator. A leg that SHOULD have a close but doesn't
// registers as status "no_close"; it is visible in coverage, not absent.
//
// The ledger also carries the notary records: for every published board, the
// SHA256 of the exact bytes at publish time plus the errata list (boards are
// immutable; corrections live here).

import * as fs from "node:fs";
import * as path from "node:path";
import {
  clvVerdict,
  benchmarkTier,
  type ClvVerdict,
} from "../nfl-clv-metric";
import type { BoardMarket, LegRole, LegSide, PublishedBoard, PublishedLeg } from "./board";

export type LegStatus =
  | "pending" // published, game not yet graded
  | "graded" // sharp-benchmark verdict recorded
  | "no_entry_price" // board leg had no real price at publish — never CLV-eligible
  | "no_close" // no benchmark close captured before kickoff — permanent gap, visible
  | "non_sharp_close" // only soft-book closes captured — excluded, visible
  | "void"; // game cancelled/postponed out of the week

export interface CapturedClose {
  book: string;
  tier: 1 | 2;
  sideAmerican: number;
  otherAmerican: number;
  capturedAt: string;
  minutesBeforeKickoff: number;
  /** dated snapshot file the close was read from — recompute path for readers */
  sourceFile: string;
}

export interface LedgerRow {
  legId: string;
  role: LegRole;
  pairId?: string;
  season: number;
  week: number;
  boardFile: string;
  gameId: string;
  matchup: string;
  kickoffUtc: string;
  market: BoardMarket;
  selection: string;
  side: LegSide;
  point: number | null;
  entryPriceAmerican: number | null;
  entryOtherSideAmerican: number | null;
  status: LegStatus;
  close?: CapturedClose;
  verdict?: ClvVerdict;
  gradedAt?: string;
  /** GitHub Actions run id of the grading run — third-party observation time. */
  actionsRunId?: string;
}

export interface BoardRecord {
  file: string;
  sha256: string;
  publishedAt: string;
  season: number;
  week: number;
  /** Actions run id if the board was committed via CI, else "local". */
  publishRunId: string;
  errata: Array<{ at: string; note: string }>;
}

export interface Ledger {
  schemaVersion: 1;
  boards: BoardRecord[];
  rows: LedgerRow[];
}

export function emptyLedger(): Ledger {
  return { schemaVersion: 1, boards: [], rows: [] };
}

export function defaultLedgerPath(root = process.cwd()): string {
  return path.join(root, "data", "processed", "nfl-live", "ledger.json");
}

export function loadLedger(p = defaultLedgerPath()): Ledger {
  if (!fs.existsSync(p)) return emptyLedger();
  const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as Ledger;
  if (parsed.schemaVersion !== 1)
    throw new Error(`ledger schemaVersion ${parsed.schemaVersion} unsupported`);
  return parsed;
}

export function saveLedger(ledger: Ledger, p = defaultLedgerPath()): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  ledger.rows.sort(
    (a, b) =>
      a.season - b.season ||
      a.week - b.week ||
      a.gameId.localeCompare(b.gameId) ||
      a.legId.localeCompare(b.legId),
  );
  fs.writeFileSync(p, JSON.stringify(ledger, null, 2) + "\n");
}

/** Idempotent by construction: the row for a legId is replaced wholesale by
 *  merge(existing, patch). Calling twice with the same patch is a no-op. */
export function upsertRow(
  ledger: Ledger,
  legIdKey: string,
  patch: Partial<LedgerRow> & Pick<LedgerRow, "legId">,
): LedgerRow {
  if (patch.legId !== legIdKey)
    throw new Error(`upsertRow key mismatch: ${legIdKey} vs ${patch.legId}`);
  const idx = ledger.rows.findIndex((r) => r.legId === legIdKey);
  if (idx === -1) {
    const row = patch as LedgerRow;
    ledger.rows.push(row);
    return row;
  }
  const merged = { ...ledger.rows[idx], ...patch };
  ledger.rows[idx] = merged;
  return merged;
}

export function registerBoard(
  ledger: Ledger,
  rec: BoardRecord,
): void {
  const existing = ledger.boards.find((b) => b.file === rec.file);
  if (existing) {
    if (existing.sha256 !== rec.sha256)
      throw new Error(
        `board ${rec.file} already registered with different sha256 — boards are immutable; ` +
          `if this is a genuine correction it belongs in errata, not a re-publish`,
      );
    return; // same board, same bytes — idempotent
  }
  ledger.boards.push(rec);
}

/** Seed ledger rows for a freshly published board. Rows without a real entry
 *  price are born no_entry_price (permanently CLV-ineligible, ruling 4);
 *  everything else is pending. */
export function seedRowsFromBoard(ledger: Ledger, board: PublishedBoard): void {
  for (const leg of board.legs) {
    upsertRow(ledger, leg.legId, {
      legId: leg.legId,
      role: leg.role,
      pairId: leg.pairId,
      season: board.season,
      week: board.week,
      boardFile: boardFileNameOf(board),
      gameId: leg.gameId,
      matchup: leg.matchup,
      kickoffUtc: leg.kickoffUtc,
      market: leg.market,
      selection: leg.selection,
      side: leg.side,
      point: leg.point,
      entryPriceAmerican: leg.entryPriceAmerican,
      entryOtherSideAmerican: leg.entryOtherSideAmerican,
      status: leg.clvEligible ? "pending" : "no_entry_price",
    });
  }
}

function boardFileNameOf(board: PublishedBoard): string {
  return `board-${board.season}-wk${String(board.week).padStart(2, "0")}.json`;
}

/** Re-derive every immutable identity field of a board's rows from the board
 *  bytes themselves (review finding 2: the notary verifies board FILES, but
 *  grading reads ledger ROWS — without this, a hand-edited entryPrice inside
 *  a routine ledger commit would grade a forged price). Called by the grader
 *  AFTER the notary blesses the board. Mutable state (status/close/verdict)
 *  is preserved; rows for this board whose legId does not exist on the board
 *  are returned as orphans — the caller must treat any orphan as tampering. */
export function reconcileWithBoard(
  ledger: Ledger,
  board: PublishedBoard,
): { repaired: number; orphans: string[] } {
  const file = boardFileNameOf(board);
  const legById = new Map(board.legs.map((l) => [l.legId, l]));
  let repaired = 0;
  const orphans: string[] = [];
  for (const row of ledger.rows) {
    if (row.boardFile !== file) continue;
    const leg = legById.get(row.legId);
    if (!leg) {
      orphans.push(row.legId);
      continue;
    }
    const truth: Partial<LedgerRow> = {
      role: leg.role,
      pairId: leg.pairId,
      gameId: leg.gameId,
      matchup: leg.matchup,
      kickoffUtc: leg.kickoffUtc,
      market: leg.market,
      selection: leg.selection,
      side: leg.side,
      point: leg.point,
      entryPriceAmerican: leg.entryPriceAmerican,
      entryOtherSideAmerican: leg.entryOtherSideAmerican,
    };
    let changed = false;
    for (const [k, v] of Object.entries(truth)) {
      if ((row as unknown as Record<string, unknown>)[k] !== v) {
        (row as unknown as Record<string, unknown>)[k] = v;
        changed = true;
      }
    }
    // no_entry_price is derivable from the board and must not be washed away
    // (or introduced) by row edits — in EITHER direction: demoting an
    // eligible row to no_entry_price would silently shrink the denominator
    // (round-2 review finding 2). void stays operator-owned via nfl-errata.
    const derivedIneligible = !leg.clvEligible;
    if (derivedIneligible && row.status !== "no_entry_price" && row.status !== "void") {
      row.status = "no_entry_price";
      changed = true;
    } else if (!derivedIneligible && row.status === "no_entry_price") {
      row.status = "pending";
      changed = true;
    }
    if (changed) repaired++;
  }
  // Board legs missing from the ledger entirely (deleted rows) are re-seeded.
  for (const leg of board.legs) {
    if (!ledger.rows.some((r) => r.legId === leg.legId)) {
      seedRowsFromBoard(ledger, { ...board, legs: [leg] });
      repaired++;
    }
  }
  return { repaired, orphans };
}

/** Record a captured close on a row. A higher-tier (lower number) close always
 *  replaces a lower-tier one; same tier → the LATER capture wins (closest to
 *  kickoff = the close). Never downgrades tier. */
export function recordClose(
  ledger: Ledger,
  legIdKey: string,
  close: CapturedClose,
): LedgerRow {
  const row = ledger.rows.find((r) => r.legId === legIdKey);
  if (!row) throw new Error(`recordClose: unknown legId ${legIdKey}`);
  if (row.status === "no_entry_price" || row.status === "void") return row;
  const cur = row.close;
  const replace =
    !cur ||
    close.tier < cur.tier ||
    (close.tier === cur.tier && close.capturedAt >= cur.capturedAt);
  if (replace) row.close = close;
  return row;
}

/** Grade every gradable row: entry devigged against its captured sharp close.
 *  Rows past kickoff with no captured close become no_close — the denominator
 *  never silently shrinks (threat T8). Idempotent: re-grading recomputes the
 *  same verdicts from the same stored closes. */
export function gradeRows(
  ledger: Ledger,
  nowMs: number,
  actionsRunId?: string,
): { graded: number; noClose: number } {
  let graded = 0;
  let noClose = 0;
  for (const row of ledger.rows) {
    if (row.status === "no_entry_price" || row.status === "void") continue;
    const kickoffPassed =
      Number.isFinite(Date.parse(row.kickoffUtc)) &&
      Date.parse(row.kickoffUtc) < nowMs;
    // Never grade before kickoff: a T−80 capture graded early would freeze a
    // non-close as "the close" (capture skips non-pending rows) and bias the
    // headline. The close is the LAST pre-kickoff capture, enforced here, not
    // by cron scheduling convention. (Review finding 4.)
    if (row.close && row.entryPriceAmerican != null && kickoffPassed) {
      const tier = benchmarkTier(row.close.book);
      if (tier == null) {
        row.status = "non_sharp_close";
        continue;
      }
      row.verdict = clvVerdict(row.entryPriceAmerican, {
        book: row.close.book,
        sideAmerican: row.close.sideAmerican,
        otherAmerican: row.close.otherAmerican,
      });
      row.status = "graded";
      row.gradedAt = new Date(nowMs).toISOString();
      if (actionsRunId) row.actionsRunId = actionsRunId;
      graded++;
    } else if (kickoffPassed) {
      row.status = "no_close";
      noClose++;
    }
  }
  return { graded, noClose };
}

/** Rows whose boardFile names no registered board — a fabricated row can
 *  dodge reconcileWithBoard entirely by confessing to a board that does not
 *  exist (round-2 review finding 1). The grader hard-fails on any of these. */
export function strayRows(ledger: Ledger): LedgerRow[] {
  const known = new Set(ledger.boards.map((b) => b.file));
  return ledger.rows.filter((r) => !known.has(r.boardFile));
}

// ─── The pre-registered headline ─────────────────────────────────────────────

export interface ArmSummary {
  eligible: number; // rows that could ever grade (entry price present, not void)
  graded: number;
  coverage: number; // graded / eligible — rendered NEXT TO the beat rate
  beats: number;
  beatRate: number | null;
  avgDevigClvPp: number | null;
  tier2Benchmarked: number;
  byStatus: Record<LegStatus, number>;
}

export interface Headline {
  play: ArmSummary;
  control: ArmSummary;
  /** THE verdict metric (threat T9): PLAY beat rate MINUS control beat rate,
   *  computed only over pairs where BOTH arms graded. Null until any pair
   *  grades. Positive = skill beyond structural timing edge. */
  pairedDifferentialPp: number | null;
  pairedN: number;
  /** Frozen: below this n the page prints INSUFFICIENT_N and no verdict is
   *  ever issued for the season (pre-registered 2026-08-29). */
  minN: number;
  insufficientN: boolean;
}

export const VERDICT_MIN_N = 150;

function summarizeArm(rows: LedgerRow[]): ArmSummary {
  const byStatus = {
    pending: 0,
    graded: 0,
    no_entry_price: 0,
    no_close: 0,
    non_sharp_close: 0,
    void: 0,
  } as Record<LegStatus, number>;
  for (const r of rows) byStatus[r.status]++;
  const eligible = rows.filter(
    (r) => r.status !== "no_entry_price" && r.status !== "void",
  ).length;
  const graded = rows.filter((r) => r.status === "graded");
  const beats = graded.filter((r) => r.verdict?.beatClose).length;
  return {
    eligible,
    graded: graded.length,
    coverage: eligible > 0 ? graded.length / eligible : 0,
    beats,
    beatRate: graded.length > 0 ? beats / graded.length : null,
    avgDevigClvPp:
      graded.length > 0
        ? graded.reduce((s, r) => s + (r.verdict?.devigClvPp ?? 0), 0) /
          graded.length
        : null,
    tier2Benchmarked: graded.filter((r) => r.verdict?.benchmarkTier === 2)
      .length,
    byStatus,
  };
}

export function headline(ledger: Ledger): Headline {
  const playRows = ledger.rows.filter((r) => r.role === "play");
  const controlRows = ledger.rows.filter((r) => r.role === "control");
  const play = summarizeArm(playRows);
  const control = summarizeArm(controlRows);

  const controlById = new Map(controlRows.map((r) => [r.legId, r]));
  let pairedN = 0;
  let playBeats = 0;
  let controlBeats = 0;
  for (const p of playRows) {
    if (p.status !== "graded" || !p.pairId) continue;
    const c = controlById.get(p.pairId);
    if (!c || c.status !== "graded") continue;
    pairedN++;
    if (p.verdict?.beatClose) playBeats++;
    if (c.verdict?.beatClose) controlBeats++;
  }
  return {
    play,
    control,
    pairedDifferentialPp:
      pairedN > 0 ? ((playBeats - controlBeats) / pairedN) * 100 : null,
    pairedN,
    minN: VERDICT_MIN_N,
    insufficientN: play.graded < VERDICT_MIN_N,
  };
}
