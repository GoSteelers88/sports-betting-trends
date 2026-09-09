// content-hashes.test.ts — the one hashing rule both the notary and the /nfl
// page depend on: a line-ending-only difference is NOT forgery, and anything
// else is.
//
// This matters on this machine specifically. Measured 2026-09-09:
//   git config core.autocrlf  -> true
//   board-2026-wk01.json      -> 0 CRLF pairs, 1634 bare LF
// So there is no live discrepancy today, and Vercel builds from Linux. The
// risk is latent: a FRESH Windows clone is what autocrlf=true rewrites, and
// the page now compares its computed hash to the ledger's recorded one. Get
// this wrong and the page cries forgery at anyone who clones on Windows.

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  contentHashes,
  contentHashesOfFile,
  matchesRecordedHash,
  sha256Hex,
} from "../leg-id";

const BOARD = path.join(
  process.cwd(),
  "data",
  "processed",
  "nfl-live",
  "board-2026-wk01.json",
);
const LEDGER = path.join(
  process.cwd(),
  "data",
  "processed",
  "nfl-live",
  "ledger.json",
);

function recordedSha(): string {
  const l = JSON.parse(fs.readFileSync(LEDGER, "utf8")) as {
    boards: Array<{ file: string; sha256: string }>;
  };
  const rec = l.boards.find((b) => b.file === "board-2026-wk01.json");
  if (!rec) throw new Error("wk01 not registered in the ledger");
  return rec.sha256;
}

describe("contentHashes", () => {
  it("hashes the exact bytes as `raw`", () => {
    const bytes = fs.readFileSync(BOARD);
    expect(contentHashes(bytes).raw).toBe(sha256Hex(bytes));
  });

  it("agrees with the hash the ledger recorded at publish", () => {
    expect(matchesRecordedHash(contentHashesOfFile(BOARD), recordedSha())).toBe(
      true,
    );
  });

  it("forgives a CRLF checkout — raw differs, normalized still matches", () => {
    const asCloned = fs.readFileSync(BOARD, "utf8").replace(/\n/g, "\r\n");
    const h = contentHashes(asCloned);
    // The whole point: the raw hash DOES change...
    expect(h.raw).not.toBe(recordedSha());
    // ...and the file is still the notarized board.
    expect(matchesRecordedHash(h, recordedSha())).toBe(true);
  });

  it("is idempotent on a file that is already LF", () => {
    const h = contentHashesOfFile(BOARD);
    expect(h.raw).toBe(h.lfNormalized);
  });

  // NEGATIVE CONTROLS. A check that has never gone red proves nothing.
  it("does NOT forgive a one-token edit", () => {
    const edited = fs
      .readFileSync(BOARD, "utf8")
      .replace('"entryPriceAmerican": 106', '"entryPriceAmerican": 150');
    expect(edited).not.toBe(fs.readFileSync(BOARD, "utf8"));
    expect(matchesRecordedHash(contentHashes(edited), recordedSha())).toBe(false);
  });

  it("does NOT forgive an edit that also arrives CRLF-encoded", () => {
    const edited = fs
      .readFileSync(BOARD, "utf8")
      .replace('"entryPriceAmerican": 106', '"entryPriceAmerican": 150')
      .replace(/\n/g, "\r\n");
    expect(matchesRecordedHash(contentHashes(edited), recordedSha())).toBe(false);
  });

  it("does NOT forgive whitespace re-serialization", () => {
    const reserialized = JSON.stringify(
      JSON.parse(fs.readFileSync(BOARD, "utf8")),
      null,
      4,
    );
    expect(matchesRecordedHash(contentHashes(reserialized), recordedSha())).toBe(
      false,
    );
  });
});
