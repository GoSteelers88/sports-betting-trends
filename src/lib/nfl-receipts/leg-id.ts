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

/** Content hashes of a set of bytes: the raw hash, and the hash after
 *  CRLF→LF normalization.
 *
 *  Both exist for one reason. `git config core.autocrlf` defaults to true on
 *  Windows, so a fresh clone can rewrite every LF in a committed board to
 *  CRLF without changing one byte of content. The raw hash then differs from
 *  the sha256 recorded in ledger.json at publish, and an honest board reads
 *  as forged. Normalizing is a FALLBACK, never the primary: a real edit
 *  changes both hashes.
 *
 *  This lives here, beside sha256Hex, so notary.ts and the /nfl page share
 *  ONE implementation — the same discipline that keeps devigTwoWay the only
 *  devig on the receipts path. */
export interface ContentHashes {
  /** sha256 of the exact bytes. This is what gets printed. */
  raw: string;
  /** sha256 after CRLF→LF. Only ever used to forgive a checkout. */
  lfNormalized: string;
}

const CRLF = /\r\n/g;

export function contentHashes(bytes: string | Buffer): ContentHashes {
  const text = typeof bytes === "string" ? bytes : bytes.toString("utf8");
  return {
    raw: sha256Hex(bytes),
    lfNormalized: sha256Hex(text.replace(CRLF, "\n")),
  };
}

export function contentHashesOfFile(path: string): ContentHashes {
  return contentHashes(fs.readFileSync(path));
}

/** True when these bytes are the bytes that were notarized at publish —
 *  raw match, or a line-ending-only difference. */
export function matchesRecordedHash(
  hashes: ContentHashes,
  recordedSha256: string,
): boolean {
  return (
    hashes.raw === recordedSha256 || hashes.lfNormalized === recordedSha256
  );
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
