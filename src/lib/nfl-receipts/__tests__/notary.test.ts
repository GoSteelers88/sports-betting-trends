import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../leg-id";
import { verifyNotary } from "../notary";

let root: string;
const BOARD_REL = path.join("data", "processed", "nfl-live", "board-2026-wk01.json");
const BOARD_CONTENT = JSON.stringify({ schemaVersion: 1, season: 2026, week: 1 }, null, 2);

function writeLedger(sha: string): string {
  const ledgerPath = path.join(root, "data", "processed", "nfl-live", "ledger.json");
  fs.writeFileSync(
    ledgerPath,
    JSON.stringify({
      schemaVersion: 1,
      boards: [
        {
          file: "board-2026-wk01.json",
          sha256: sha,
          publishedAt: "2026-09-08T12:00:00Z",
          season: 2026,
          week: 1,
          publishRunId: "local",
          errata: [],
        },
      ],
      rows: [],
    }),
  );
  return ledgerPath;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "notary-test-"));
  fs.mkdirSync(path.join(root, "data", "processed", "nfl-live"), { recursive: true });
  fs.writeFileSync(path.join(root, BOARD_REL), BOARD_CONTENT);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("verifyNotary (threat T7)", () => {
  it("passes when local + remote bytes match the published sha", () => {
    const ledgerPath = writeLedger(sha256Hex(BOARD_CONTENT));
    const r = verifyNotary({
      requireRemote: true,
      execGit: () => BOARD_CONTENT,
      ledgerPath,
      root,
    });
    expect(r.ok).toBe(true);
  });

  it("fails when the local board was edited after publish", () => {
    const ledgerPath = writeLedger(sha256Hex(BOARD_CONTENT));
    fs.writeFileSync(path.join(root, BOARD_REL), BOARD_CONTENT + " ");
    const r = verifyNotary({
      requireRemote: false,
      execGit: () => BOARD_CONTENT,
      ledgerPath,
      root,
    });
    expect(r.ok).toBe(false);
    expect(r.log.join("\n")).toMatch(/EDITED after publish/);
  });

  it("fails when origin/master holds different bytes", () => {
    const ledgerPath = writeLedger(sha256Hex(BOARD_CONTENT));
    const r = verifyNotary({
      requireRemote: true,
      execGit: () => JSON.stringify({ forged: true }),
      ledgerPath,
      root,
    });
    expect(r.ok).toBe(false);
    expect(r.log.join("\n")).toMatch(/diverged/);
  });

  it("unpushed board: warns locally, fails when remote is required (CI)", () => {
    const ledgerPath = writeLedger(sha256Hex(BOARD_CONTENT));
    const execGit = () => {
      throw new Error("fatal: path not in origin/master");
    };
    expect(verifyNotary({ requireRemote: false, execGit, ledgerPath, root }).ok).toBe(true);
    expect(verifyNotary({ requireRemote: true, execGit, ledgerPath, root }).ok).toBe(false);
  });

  it("tolerates an autocrlf rewrite (CRLF board still verifies)", () => {
    const ledgerPath = writeLedger(sha256Hex(BOARD_CONTENT));
    fs.writeFileSync(path.join(root, BOARD_REL), BOARD_CONTENT.replace(/\n/g, "\r\n"));
    const r = verifyNotary({
      requireRemote: false,
      execGit: () => BOARD_CONTENT,
      ledgerPath,
      root,
    });
    expect(r.ok).toBe(true);
  });
});
