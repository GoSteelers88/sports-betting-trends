// leg-id.ts — durable identity for every published leg, and the content
// hashes the notary runs on (threats T7 + T8).
//
// legId is a pure function of WHAT was published, not when or by whom:
//   sha256(boardFile|gameId|market|selection|point) — first 16 hex chars.
// Re-running the grader can therefore only ever UPSERT the same row; a leg
// can never be double-counted (the old metric had a test asserting duplicates
// count — that behavior is the bug this module retires).

import { createHash } from "node:crypto";
import * as fs from "node:fs";

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Content hash of a board file — the notary's ground truth. Hash the exact
 *  bytes on disk, not a re-serialization (key order or whitespace drift would
 *  make honest boards look forged). */
export function sha256OfFile(path: string): string {
  return sha256Hex(fs.readFileSync(path));
}

export interface LegIdentity {
  boardFile: string; // basename, e.g. "board-2026-wk01.json"
  gameId: string;
  market: string;
  selection: string;
  point: number | null;
}

export function legId(id: LegIdentity): string {
  const pt = id.point == null ? "" : String(id.point);
  return sha256Hex(
    `${id.boardFile}|${id.gameId}|${id.market}|${id.selection}|${pt}`,
  ).slice(0, 16);
}
