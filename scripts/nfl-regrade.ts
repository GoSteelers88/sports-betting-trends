// nfl-regrade.ts — re-grade the walked NFL record at OPENING lines from the
// SBR archive (research recs 1 + 8). Read-only: touches no loop state.
//
//   npm run nfl:regrade
//
// Prints the doctrine verdict tables: ATS/totals at open vs close, dog/fav
// splits with Beta(50,50) posterior means, open→close drift on our dogs,
// ML-dog devig envelope, home/road × spread-size localization with
// Holm-corrected p-values, and the per-season era table.

import {
  computeEntryRegrade,
  loadOddsArchiveDetailed,
  type EntryRegradeReport,
  type Line3,
} from "../src/lib/nfl-entry-regrade";
import { defaultStateDir, loadGames, loadGradedRows } from "../src/lib/nfl-loop";

const B = "\x1b[1m";
const D = "\x1b[2m";
const G = "\x1b[32m";
const R = "\x1b[31m";
const C = "\x1b[36m";
const X = "\x1b[0m";

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const roi = (v: number): string =>
  v >= 0 ? `${G}+${v.toFixed(1)}%${X}` : `${R}${v.toFixed(1)}%${X}`;

function line(label: string, t: Line3): string {
  return (
    `    ${label.padEnd(26)} ${String(t.wins).padStart(4)}-${String(t.losses).padEnd(4)}` +
    `(${t.pushes}p)  win ${pct(t.winRate).padStart(6)}  roi ${roi(t.roiPct)}` +
    `  ${D}posterior ${pct(t.posteriorMean)}${X}`
  );
}

function main(): void {
  const dir = defaultStateDir();
  const games = loadGames(dir);
  const graded = loadGradedRows(dir);
  const load = loadOddsArchiveDetailed();
  console.log(
    `\n  archive rows: ${load.rawCount} raw → ${load.rows.length} clean ` +
      `(${load.droppedCount} dropped, ${load.nulledCloseCount} with corrupt close cells nulled)`,
  );
  const report: EntryRegradeReport = computeEntryRegrade({
    graded,
    games,
    archive: load.rows,
  });

  const a = report.anchors;
  console.log(`\n${B}NFL entry-price re-grade${X} ${D}(SBR archive, seasons ${report.scope.seasons.join(", ")})${X}`);
  console.log(
    `  anchors: coverage ${pct(a.coverage)}, close corr ${a.closeSpreadCorr.toFixed(3)}, open corr ${a.openSpreadCorr.toFixed(3)}, ` +
      `regrade agreement ${pct(a.regradeAgreement)} → ${a.pass ? `${G}PASS${X}` : `${R}FAIL${X}`}`,
  );
  console.log(
    `  in scope: ${report.scope.gradedRowsInScope} graded rows ` +
      `(${report.scope.atsRows} ats, ${report.scope.totalRows} total, ${report.scope.mlRows} ml)\n`,
  );

  console.log(`${B}  ATS — same picks, three reference lines${X}`);
  console.log(line("nflverse ~close (record)", report.ats.atNflverseClose));
  console.log(line("archive close", report.ats.atArchiveClose));
  console.log(line("archive OPEN", report.ats.atArchiveOpen));

  console.log(`\n${B}  The dog doctrine, honestly graded${X}`);
  console.log(line("dogs at close", report.ats.dogAtClose));
  console.log(line("dogs at OPEN", report.ats.dogAtOpen));
  console.log(line("favorites at close", report.ats.favAtClose));
  console.log(line("favorites at OPEN", report.ats.favAtOpen));
  const drift = report.ats.dogDriftTowardPickPts;
  console.log(
    `    open→close drift toward our open-line dogs: ${drift >= 0 ? G : R}${drift >= 0 ? "+" : ""}${drift.toFixed(2)} pts${X}` +
      ` ${D}(positive = market moved our way = entry CLV existed)${X}`,
  );

  console.log(`\n${B}  Totals — same picks, three reference lines${X}`);
  console.log(line("nflverse ~close (record)", report.totals.atNflverseClose));
  console.log(line("archive close", report.totals.atArchiveClose));
  console.log(line("archive OPEN", report.totals.atArchiveOpen));

  const ml = report.moneylineDogs;
  console.log(`\n${B}  ML dogs under the devig envelope${X} ${D}(rec 7 — n=${ml.n})${X}`);
  console.log(
    `    +EV vs naive fair: ${ml.plusEvNaive}   surviving worst-case: ${ml.plusEvWorstCase}` +
      `   ${D}avg naive-vs-worst fair gap ${ml.avgFairGapNaiveVsWorstPp.toFixed(2)}pp${X}`,
  );
  console.log(line("ml dog record (stored)", ml.record));

  console.log(`\n${B}  Dog localization at OPEN${X} ${D}(rec 8 — Holm-corrected vs 52.4% breakeven)${X}`);
  for (const cell of report.dogLocalization) {
    console.log(
      line(cell.cell, cell) +
        `  p=${cell.pValue.toFixed(3)}${cell.holmSignificant ? ` ${C}**${X}` : ""}`,
    );
  }

  console.log(`\n${B}  Era table at OPEN${X} ${D}(rec 8 — does the signal live in recent seasons?)${X}`);
  for (const era of report.eraAts) {
    console.log(line(`${era.season} all ATS`, era.all));
    console.log(line(`${era.season} dogs`, era.dogs));
  }
  console.log(
    `\n  ${D}Flat 1u at -110 for ats/totals (archive carries no spread prices). ` +
      `Archive lacks 2022+ — extend via aussportsbetting xlsx when the walk gets there.${X}\n`,
  );
}

main();
