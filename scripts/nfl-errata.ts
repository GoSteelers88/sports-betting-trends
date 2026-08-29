/**
 * nfl-errata.ts — the ONLY sanctioned way to correct the receipts ledger
 * (review finding 10: without an operator tool, honest corrections would mean
 * hand-editing ledger.json — the exact motion the tamper check exists to
 * catch).
 *
 *   npx tsx scripts/nfl-errata.ts void <legId> "<note>"
 *     Marks a leg void (postponed/cancelled game) and records an erratum on
 *     its board. Void legs leave every denominator.
 *
 *   npx tsx scripts/nfl-errata.ts note <boardFile> "<note>"
 *     Appends a free-text erratum to a board record (rendered on /nfl).
 *
 * Boards themselves are never touched. Every action stamps an ISO time.
 */
import {
  defaultLedgerPath,
  loadLedger,
  saveLedger,
} from "../src/lib/nfl-receipts/ledger";

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function main(): void {
  const [cmd, target, ...noteParts] = process.argv.slice(2);
  const note = noteParts.join(" ").trim();
  if (!cmd || !target || !note)
    fail('usage: nfl-errata.ts void <legId> "<note>" | note <boardFile> "<note>"');

  const ledger = loadLedger(defaultLedgerPath());
  const at = new Date().toISOString();

  if (cmd === "void") {
    const row = ledger.rows.find((r) => r.legId === target);
    if (!row) fail(`unknown legId ${target}`);
    if (row.status === "graded")
      fail(
        `leg ${target} is already graded — voiding a graded leg rewrites history; ` +
          `if the grade itself is wrong, that is a method breakage: record a note erratum and restart per pre-registration`,
      );
    row.status = "void";
    const rec = ledger.boards.find((b) => b.file === row.boardFile);
    if (!rec) fail(`row references unregistered board ${row.boardFile}`);
    rec.errata.push({ at, note: `VOID ${row.selection} [${row.market}] (${row.legId}): ${note}` });
    saveLedger(ledger);
    console.log(`voided ${target} on ${row.boardFile}; erratum recorded`);
    return;
  }

  if (cmd === "note") {
    const rec = ledger.boards.find((b) => b.file === target);
    if (!rec) fail(`unknown board ${target} (registered: ${ledger.boards.map((b) => b.file).join(", ") || "none"})`);
    rec.errata.push({ at, note });
    saveLedger(ledger);
    console.log(`erratum recorded on ${target}`);
    return;
  }

  fail(`unknown command "${cmd}"`);
}

main();
