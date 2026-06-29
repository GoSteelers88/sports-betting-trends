/**
 * nfl-parlay-backtest.ts — Experiment No. 5 (NFL backtest learning loop) PARLAY
 * layer. POST-HOC retrospective, like scripts/parlay-backtest.ts for MLB.
 *
 *   npm run nfl:parlay-backtest          # write the private book
 *   npm run nfl:parlay-backtest -- json  # also print the machine summary
 *
 * Reads the PRIVATE, gitignored NFL loop logs:
 *   data/private/nfl-loop/picks-log.jsonl        (GradedRow[]   — game picks)
 *   data/private/nfl-loop/prop-picks-log.jsonl   (GradedPropRow[] — prop picks)
 * forms 3-leg parlays under the DURABLE PARLAY DOCTRINE (nfl-parlay.ts), grades
 * them against the already-known leg results, and writes ONLY:
 *   data/private/nfl-loop/quant/nfl-parlay-book.json   (private)
 *
 * It NEVER writes the picks logs (a background seed run is actively appending to
 * them) — it only READS them. The book write targets the quant/ subdir.
 *
 * LEAKAGE DISCIPLINE: the engine selects legs on pre-game fields only (edge,
 * odds, favored, confidence) and reads `result` solely at settlement. The legs
 * are settled historical blind picks, so the book is a faithful "what would these
 * parlays have done" retrospective — QUARANTINED from the live loop (it tunes
 * nothing). The PUBLIC, aggregate-only mirror is written by nfl-exp5-summary.ts.
 */
import fs from "node:fs";
import path from "node:path";
import {
  defaultStateDir,
  loadGradedRows,
  loadGradedPropRows,
} from "../src/lib/nfl-loop";
import {
  runNflParlayBacktest,
  computeNflParlayStats,
  NFL_PARLAY_CONFIG,
} from "../src/lib/nfl-parlay";

function quantDir(stateDir: string): string {
  return path.join(stateDir, "quant");
}

function bookPath(stateDir: string): string {
  return path.join(quantDir(stateDir), "nfl-parlay-book.json");
}

function main(): void {
  const asJson = (process.argv[2] ?? "").toLowerCase() === "json";
  const stateDir = defaultStateDir();

  const games = loadGradedRows(stateDir);
  const props = loadGradedPropRows(stateDir);

  const nowIso = new Date().toISOString();
  const book = runNflParlayBacktest(games, props, nowIso);
  const stats = computeNflParlayStats(book);

  // Persist the PRIVATE book (quant/ subdir only — never the picks logs).
  const outDir = quantDir(stateDir);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(bookPath(stateDir), JSON.stringify({ ...book, stats }, null, 2) + "\n");

  if (asJson) {
    console.log(JSON.stringify({ stats, tally: book.tally }, null, 2));
    return;
  }

  const t = book.tally;
  console.log("");
  console.log("═══ Experiment No. 5 — NFL PARLAY BACKTEST (private, retrospective) ═══");
  console.log(
    "Durable parlay doctrine: 3 legs · DISTINCT games · +EV floor ≥" +
      `${(NFL_PARLAY_CONFIG.edgeFloor * 100).toFixed(0)}% · favorites ≤+${NFL_PARLAY_CONFIG.longshotMaxAmerican} ·`,
  );
  console.log(
    `−${(NFL_PARLAY_CONFIG.haircutPerLegProb * 100).toFixed(0)}pt-per-leg haircut · ¼-Kelly on COMBINED · $${NFL_PARLAY_CONFIG.startingBankrollUsd.toLocaleString()} book.`,
  );
  console.log("Legs are settled BLIND picks; selection reads pre-game fields only. QUARANTINED.");
  console.log("");
  console.log("─── Leg funnel ───");
  console.log(`  graded rows seen:    ${t.legsSeen}`);
  console.log(`  dropped no-data:     ${t.noData}`);
  console.log(`  dropped below +EV:   ${t.belowEdgeFloor}`);
  console.log(`  dropped longshot:    ${t.longshot}`);
  console.log(`  dropped bad odds:    ${t.badOdds}`);
  console.log(`  ELIGIBLE legs:       ${t.eligibleLegs}`);
  console.log("");
  console.log("─── Assembly funnel ───");
  console.log(`  triples examined:    ${t.triplesStarted}`);
  console.log(`  blocked same-game:   ${t.sameGame}`);
  console.log(`  blocked haircut:     ${t.haircut}`);
  console.log(`  blocked too-small:   ${t.tooSmall}`);
  console.log(`  capped-week dropped: ${t.cappedDropped}`);
  console.log(`  stranded (no partner): ${t.legsStranded}`);
  {
    // Reconciliation line — proves the eligible→formed gap is fully accounted,
    // so an operator can tell "doctrine correctly rejected everything" from
    // "the assembler dropped legs silently". (systems-reviewer finding #1)
    const legsUsed = stats.settledCount * 3;
    const accounted = legsUsed + t.cappedDropped + t.legsStranded;
    const ok = accounted === t.eligibleLegs;
    console.log(
      `  reconcile: ${legsUsed} used + ${t.cappedDropped} capped + ${t.legsStranded} stranded ` +
        `= ${accounted} vs ${t.eligibleLegs} eligible ${ok ? "✓" : "✗ MISMATCH"}`,
    );
  }
  console.log("");
  console.log("─── Result ───");
  console.log(`  Parlays:    ${stats.settledCount}  (W ${stats.wins} · L ${stats.losses} · void ${stats.voids})`);
  console.log(
    `  Win rate:   ${stats.winRatePct == null ? "—" : stats.winRatePct + "%"}`,
  );
  console.log(`  Staked:     $${stats.totalStakedUsd.toFixed(2)}`);
  console.log(
    `  Net P&L:    ${stats.realizedPnlUsd >= 0 ? "+" : ""}$${stats.realizedPnlUsd.toFixed(2)}   ` +
      `ROI ${stats.roiPct >= 0 ? "+" : ""}${stats.roiPct}%   ` +
      `yield ${stats.yieldPct == null ? "—" : (stats.yieldPct >= 0 ? "+" : "") + stats.yieldPct + "%"}`,
  );
  console.log(
    `  Equity:     $${NFL_PARLAY_CONFIG.startingBankrollUsd.toLocaleString()} → $${stats.equityUsd.toLocaleString()}`,
  );
  console.log(
    `  avg leg edge (decisive): ${stats.avgLegsEdge == null ? "—" : (stats.avgLegsEdge * 100).toFixed(2) + "%"}`,
  );
  console.log("");
  console.log(`Wrote private book → ${path.relative(process.cwd(), bookPath(stateDir))}`);
  console.log("");
}

main();
