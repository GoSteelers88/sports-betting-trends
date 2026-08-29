// notary.ts — content-addressed receipt verification (threat T7).
//
// The git commit SHA alone is a forgeable notary: author dates are settable
// (GIT_AUTHOR_DATE) and every cron bot in this repo runs `git pull --rebase`,
// which rewrites commit SHAs wholesale. What cannot be quietly rewritten:
//   1. the SHA256 of the board bytes, recorded in ledger.json at publish;
//   2. the board's presence ON origin/master with those exact bytes;
//   3. GitHub's third-party observation times (Actions run ids on rows).
// This module checks 1 and 2. Force-push protection (the remaining hole) is
// asserted by scripts/verify-notary.ts when a GH token with admin read is
// available, and belongs in branch settings regardless.

import * as fs from "node:fs";
import * as path from "node:path";
import { sha256Hex, sha256OfFile } from "./leg-id";
import { defaultLedgerPath, loadLedger } from "./ledger";

export interface NotaryResult {
  ok: boolean;
  log: string[];
}

export interface NotaryOptions {
  /** When true, a board missing from origin/master (or differing there) is a
   *  failure. CI always requires remote; a local publish that hasn't been
   *  pushed yet legitimately can't pass it. */
  requireRemote: boolean;
  /** Injected so tests can fake git. Must throw on nonzero exit. */
  execGit: (args: string[]) => string;
  ledgerPath?: string;
  root?: string;
}

export function verifyNotary(opts: NotaryOptions): NotaryResult {
  const root = opts.root ?? process.cwd();
  const ledgerPath = opts.ledgerPath ?? defaultLedgerPath(root);
  const log: string[] = [];
  let ok = true;

  const ledger = loadLedger(ledgerPath);
  if (ledger.boards.length === 0) {
    log.push("no boards registered yet — vacuously ok");
    return { ok, log };
  }

  for (const rec of ledger.boards) {
    const rel = path.posix.join("data", "processed", "nfl-live", rec.file);
    const abs = path.join(root, "data", "processed", "nfl-live", rec.file);

    // 1. local bytes match the sha recorded at publish
    if (!fs.existsSync(abs)) {
      ok = false;
      log.push(`FAIL ${rec.file}: missing from working tree`);
      continue;
    }
    // A Windows autocrlf re-checkout can rewrite LF→CRLF without changing
    // content; that must not read as forgery. Normalized-hash fallback only.
    const raw = fs.readFileSync(abs);
    const localSha = sha256OfFile(abs);
    const localShaNorm = sha256Hex(raw.toString("utf8").replace(/\r\n/g, "\n"));
    if (localSha !== rec.sha256 && localShaNorm !== rec.sha256) {
      ok = false;
      log.push(
        `FAIL ${rec.file}: local sha256 ${localSha.slice(0, 12)}… != published ${rec.sha256.slice(0, 12)}… — the board was EDITED after publish`,
      );
      continue;
    }

    // 2. the same bytes are reachable from origin/master
    let remoteBytes: string | null = null;
    try {
      remoteBytes = opts.execGit(["cat-file", "-p", `origin/master:${rel}`]);
    } catch {
      remoteBytes = null;
    }
    if (remoteBytes == null) {
      if (opts.requireRemote) {
        ok = false;
        log.push(`FAIL ${rec.file}: not reachable from origin/master — an unpushed board has no public receipt`);
      } else {
        log.push(`warn ${rec.file}: not on origin/master yet (ok locally, push before kickoff)`);
      }
      continue;
    }
    // git cat-file emits the blob verbatim; hash what the remote actually holds
    const remoteSha = sha256Hex(remoteBytes);
    const remoteShaNorm = sha256Hex(remoteBytes.replace(/\r\n/g, "\n"));
    if (remoteSha !== rec.sha256 && remoteShaNorm !== rec.sha256) {
      ok = false;
      log.push(
        `FAIL ${rec.file}: origin/master content ${remoteSha.slice(0, 12)}… != published ${rec.sha256.slice(0, 12)}… — the public branch diverged from the receipt`,
      );
      continue;
    }
    log.push(`ok ${rec.file}: ${rec.sha256.slice(0, 12)}… (local + origin/master)`);
  }
  return { ok, log };
}
