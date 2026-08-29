/**
 * nfl-grade-clv.ts — grade every gradable ledger leg: devigged entry vs the
 * captured sharp close, then print the pre-registered headline.
 *
 *   npx tsx scripts/nfl-grade-clv.ts [--skip-notary]
 *
 * Refuses to grade unless the notary passes (threat T7/T14): every board's
 * bytes must hash to the SHA256 recorded at publish, and in CI every board
 * must be reachable from origin/master with identical content — a leg whose
 * board never made it to the public branch has no receipt and must not enter
 * the metric.
 *
 * Legs past kickoff with no captured close become status "no_close" — the
 * denominator registers the gap instead of silently shrinking (threat T8).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  defaultLedgerPath,
  gradeRows,
  headline,
  loadLedger,
  reconcileWithBoard,
  saveLedger,
  strayRows,
} from "../src/lib/nfl-receipts/ledger";
import { verifyNotary } from "../src/lib/nfl-receipts/notary";
import type { PublishedBoard } from "../src/lib/nfl-receipts/board";

function pct(x: number | null): string {
  return x == null ? "—" : `${(x * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const skipNotary = process.argv.includes("--skip-notary");
  const inCi = process.env.GITHUB_ACTIONS === "true";

  if (!skipNotary) {
    const result = verifyNotary({
      requireRemote: inCi, // local pre-push runs may predate the board's push
      execGit: (args) => execFileSync("git", args, { encoding: "utf8" }),
    });
    for (const line of result.log) console.log(`notary: ${line}`);
    if (!result.ok) {
      console.error("NOTARY FAILED — refusing to grade. Boards are immutable receipts; fix the mismatch, never the grader.");
      process.exit(1);
    }
  } else {
    console.warn("--skip-notary passed — grading without receipt verification (dev only)");
  }

  const ledger = loadLedger(defaultLedgerPath());

  // The notary verifies board FILES; the grader reads ledger ROWS. Re-derive
  // every row's immutable identity fields from the notarized board bytes so a
  // hand-edited ledger row (slipped into any routine bot commit) can never
  // grade a forged price. Orphan rows claiming a registered board = tampering.
  for (const rec of ledger.boards) {
    const boardPath = path.join(
      process.cwd(),
      "data",
      "processed",
      "nfl-live",
      rec.file,
    );
    const board = JSON.parse(fs.readFileSync(boardPath, "utf8")) as PublishedBoard;
    const { repaired, orphans } = reconcileWithBoard(ledger, board);
    if (orphans.length > 0) {
      console.error(
        `TAMPER CHECK FAILED: ${rec.file} — ledger rows not on the published board: ${orphans.join(", ")}`,
      );
      process.exit(1);
    }
    if (repaired > 0)
      console.warn(`reconcile ${rec.file}: ${repaired} row(s) re-derived from board bytes`);
  }

  // A fabricated row can also dodge reconciliation entirely by naming a board
  // that was never registered (round-2 review finding 1, proven) — every row
  // must confess to a notarized board or grading refuses to run.
  const strays = strayRows(ledger);
  if (strays.length > 0) {
    console.error(
      `TAMPER CHECK FAILED: ledger rows reference unregistered boards: ${strays
        .map((r) => `${r.legId} (${r.boardFile})`)
        .join(", ")}`,
    );
    process.exit(1);
  }

  const before = ledger.rows.filter((r) => r.status === "graded").length;
  const { graded, noClose } = gradeRows(
    ledger,
    Date.now(),
    process.env.GITHUB_RUN_ID,
  );
  saveLedger(ledger);

  const h = headline(ledger);
  console.log(`\ngraded this run: ${graded} (total ${before} → ${before + graded}) · newly no_close: ${noClose}`);
  console.log(`\nPLAY arm:    ${h.play.graded}/${h.play.eligible} graded (coverage ${pct(h.play.coverage)}) · beat rate ${pct(h.play.beatRate)} · avg devig CLV ${h.play.avgDevigClvPp?.toFixed(2) ?? "—"}pp · tier-2 benchmarked ${h.play.tier2Benchmarked}`);
  console.log(`CONTROL arm: ${h.control.graded}/${h.control.eligible} graded (coverage ${pct(h.control.coverage)}) · beat rate ${pct(h.control.beatRate)}`);
  console.log(`PAIRED differential (the verdict metric): ${h.pairedDifferentialPp == null ? "—" : h.pairedDifferentialPp.toFixed(1) + "pp"} over ${h.pairedN} pairs`);
  if (h.insufficientN)
    console.log(`INSUFFICIENT_N: ${h.play.graded} < ${h.minN} — no verdict is issued at this sample size (pre-registered)`);
}

main().catch((err) => {
  console.error("GRADE FAILED:", err);
  process.exit(1);
});
