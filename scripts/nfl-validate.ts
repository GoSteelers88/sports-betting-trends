// nfl-validate.ts — the one-shot 2025 HOLDOUT validation.
//
//   npm run nfl:validate              # game markets only (~$3), the default
//   npm run nfl:validate -- --props   # add the props layer (~3x the cost)
//   npm run nfl:validate -- --report  # print the report, spend nothing
//   NFL_VALIDATE_USD=6 npm run nfl:validate   # override the budget cap
//
// Cost discipline (this run exists once; it must not become a money loop):
//   - NO reflect call. Validation writes no lessons, so paying for a memo
//     nothing will ever read is pure waste.
//   - Props are OPT-IN. The props prompt is ~65K tokens (~68% of a week's
//     cost) and that layer is slated for a deterministic rebuild anyway.
//   - Hard budget cap read from the REAL spend ledger before every week.
//   - Resumable + idempotent: the validation cursor advances only after a
//     clean week, and graded rows upsert on gameId|market, so a re-run costs
//     nothing for weeks already done.
//   - Stops at the end of the season instead of re-picking the final week
//     forever (the 2026-08-17/18 bug — see runWeek's cursor-advance return).

import * as fs from "node:fs";
import * as path from "node:path";

import { makeClaudePickFn, makeClaudePropsPickFn } from "../src/lib/nfl-agent";
import { loadNflDoctrine } from "../src/lib/nfl-dream";
import {
  assertSpreadConvention,
  buildActualStatMap,
  buildBlindWeek,
  defaultStateDir,
  gamesForCursor,
  gradeGame,
  gradePropPick,
  loadGames,
  loadGradedRows,
  loadInjuries,
  loadPlayerStats,
  upsertGradedPropRows,
  upsertGradedRows,
  type Cursor,
  type GradedPropRow,
  type GradedRow,
} from "../src/lib/nfl-loop";
import { spendTodayUsd } from "../src/lib/nfl-spend";
import {
  assertDoctrineIsPreValidation,
  summarizeValidation,
  validationStateDir,
  validationWeeks,
  VALIDATION_SEASON,
  type MarketLine,
} from "../src/lib/nfl-validation";

const B = "\x1b[1m";
const D = "\x1b[2m";
const G = "\x1b[32m";
const RED = "\x1b[31m";
const Y = "\x1b[33m";
const C = "\x1b[36m";
const X = "\x1b[0m";

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const roiStr = (v: number): string =>
  v >= 0 ? `${G}+${v.toFixed(1)}%${X}` : `${RED}${v.toFixed(1)}%${X}`;

const cursorLabel = (c: Cursor): string =>
  `${c.season} ${c.phase} wk${c.week}`;

function cursorFile(vdir: string): string {
  return path.join(vdir, "cursor.json");
}

function loadDone(vdir: string): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(cursorFile(vdir), "utf8")) as {
      done?: string[];
    };
    return new Set(raw.done ?? []);
  } catch {
    return new Set();
  }
}

function saveDone(vdir: string, done: Set<string>): void {
  fs.mkdirSync(vdir, { recursive: true });
  const tmp = `${cursorFile(vdir)}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({ season: VALIDATION_SEASON, done: [...done] }, null, 2),
  );
  fs.renameSync(tmp, cursorFile(vdir));
}

function printReport(vdir: string, mainDir: string): void {
  const holdout = loadGradedRows(vdir);
  if (holdout.length === 0) {
    console.log(`${Y}No validation rows yet — run without --report first.${X}`);
    return;
  }
  const walk = loadGradedRows(mainDir);
  const s = summarizeValidation(holdout, walk);

  console.log(
    `\n${B}2025 HOLDOUT VALIDATION${X} ${D}(out-of-sample — no lessons written, no dream, doctrine frozen at 2024)${X}`,
  );
  console.log(
    `  ${s.rows} graded rows across ${s.weeks} weeks\n`,
  );
  const row = (l: MarketLine): void =>
    console.log(
      `    ${String(l.market).padEnd(11)} ${String(l.wins).padStart(3)}-${String(l.losses).padEnd(3)}` +
        `(${l.pushes}p)  win ${pct(l.winRate).padStart(6)}  roi ${roiStr(l.roiPct)}` +
        `  ${D}be ${pct(l.breakeven)} post ${pct(l.posteriorMean)}${X}` +
        `  ${l.clearsGate ? `${G}clears gate${X}` : `${RED}fails gate${X}`}`,
    );
  console.log(`${B}  Out-of-sample record${X}`);
  for (const l of s.byMarket) row(l);

  console.log(`\n${B}  Transfer — walk (2019-24, in-sample) vs holdout${X}`);
  for (const t of s.transfer) {
    const d = t.deltaPp;
    console.log(
      `    ${t.label.padEnd(11)} walk ${roiStr(t.walkRoiPct)}   holdout ${roiStr(t.holdoutRoiPct)}` +
        `   ${D}delta${X} ${d >= 0 ? G : RED}${d >= 0 ? "+" : ""}${d.toFixed(1)}pp${X}`,
    );
  }

  console.log(
    `\n${B}  Calibration${X} ${D}(mean gap ${s.calibrationGapPp != null ? s.calibrationGapPp.toFixed(1) + "pp" : "—"})${X}`,
  );
  for (const b of s.calibration) {
    if (b.realized == null) continue;
    console.log(
      `    ${b.label}   pred ${pct(b.predicted)}  real ${pct(b.realized)}  ${D}(n=${b.n})${X}`,
    );
  }
  console.log(
    `\n  ${D}Graded vs nflverse ~closing lines — an optimistic upper bound, same caveat as the walk.` +
      ` The receipts-page number is CLV at real entry prices, not this ROI.${X}\n`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const withProps = args.includes("--props");
  const reportOnly = args.includes("--report");

  const mainDir = defaultStateDir();
  const vdir = validationStateDir(mainDir);

  if (reportOnly) {
    printReport(vdir, mainDir);
    return;
  }

  const capRaw = Number.parseFloat(process.env.NFL_VALIDATE_USD ?? "");
  const cap = Number.isFinite(capRaw) && capRaw > 0 ? capRaw : withProps ? 12 : 6;

  const games = loadGames(mainDir);
  assertSpreadConvention(games);

  // THE LEAK GATE. Refuse if the doctrine has seen the holdout season.
  const doctrine = loadNflDoctrine(mainDir);
  assertDoctrineIsPreValidation(doctrine.coverage);
  console.log(
    `\n${C}2025 holdout validation${X} ${D}(doctrine coverage ${
      doctrine.coverage
        ? `${doctrine.coverage.season} ${doctrine.coverage.phase} wk${doctrine.coverage.week}`
        : "none"
    }, ${doctrine.text.length} bytes — leak gate PASSED)${X}`,
  );

  const weeks = validationWeeks(games);
  const done = loadDone(vdir);
  const todo = weeks.filter((w) => !done.has(`${w.phase}|${w.week}`));
  console.log(
    `  ${weeks.length} weeks in ${VALIDATION_SEASON}; ${done.size} already validated, ${todo.length} to run.` +
      `  props ${withProps ? `${Y}ON${X}` : `${D}off (game markets only)${X}`}` +
      `  cap $${cap.toFixed(2)}\n`,
  );
  if (todo.length === 0) {
    console.log(`${G}Validation already complete.${X}`);
    printReport(vdir, mainDir);
    return;
  }

  const pickFn = makeClaudePickFn();
  const propsFn = withProps ? makeClaudePropsPickFn() : null;
  const injuries = loadInjuries(mainDir);
  const playerStats = loadPlayerStats(mainDir);
  const startSpend = spendTodayUsd();

  for (const cursor of todo) {
    const spent = spendTodayUsd();
    if (spent - startSpend >= cap) {
      console.log(
        `\n${Y}budget cap reached${X} — $${(spent - startSpend).toFixed(2)} of $${cap.toFixed(2)} this run. ` +
          `Re-run to continue; completed weeks are free.`,
      );
      break;
    }
    const slate = gamesForCursor(games, cursor);
    if (slate.length === 0) continue;
    console.log(
      `${B}━━━ ${cursorLabel(cursor)}${X} ${D}(${slate.length} games, $${(spent - startSpend).toFixed(2)}/$${cap.toFixed(2)})${X}`,
    );

    // lessons deliberately EMPTY: week N+1 must not learn from week N.
    const blind = buildBlindWeek(games, cursor, "", injuries, playerStats);
    let picks;
    try {
      picks = await pickFn(blind);
    } catch (err) {
      console.error(`${RED}  week failed — leaving it unvalidated:${X}`, err);
      continue;
    }
    if (picks.length === 0) {
      console.error(`${RED}  0 picks parsed — leaving week unvalidated.${X}`);
      continue;
    }

    const byId = new Map(slate.map((g) => [g.gameId, g]));
    const graded: GradedRow[] = [];
    for (const p of picks) {
      const g = byId.get(p.gameId);
      if (g) graded.push(...gradeGame(g, p));
    }
    const { added, replaced } = upsertGradedRows(vdir, graded);
    const w = graded.filter((r) => r.result === "win").length;
    const l = graded.filter((r) => r.result === "loss").length;
    const pnl = graded.reduce((s, r) => s + r.pnlUnits, 0);
    console.log(
      `  picks ${picks.length}/${slate.length}  rows ${added} new/${replaced} replaced  ` +
        `record ${B}${w}-${l}${X}  P&L ${pnl >= 0 ? G : RED}${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}u${X}`,
    );

    if (propsFn) {
      try {
        const propPicks = await propsFn(blind);
        const actual = buildActualStatMap(playerStats, cursor);
        const gradedProps: GradedPropRow[] = [];
        for (const pp of propPicks) {
          const g = slate.find(
            (x) => x.homeTeam === pp.team || x.awayTeam === pp.team,
          );
          gradedProps.push(gradePropPick(pp, g?.gameId ?? "", cursor, actual));
        }
        const { added: pa } = upsertGradedPropRows(vdir, gradedProps);
        console.log(`  props ${propPicks.length} picks, ${pa} graded rows`);
      } catch (err) {
        console.error(`${RED}  props failed (game markets kept):${X}`, err);
      }
    }

    // NO reflect, NO lessons write, NO dream — the whole point.
    done.add(`${cursor.phase}|${cursor.week}`);
    saveDone(vdir, done);
  }

  const finalSpend = spendTodayUsd() - startSpend;
  console.log(
    `\n${G}validation run done${X} — $${finalSpend.toFixed(2)} spent, ${done.size}/${weeks.length} weeks validated.`,
  );
  printReport(vdir, mainDir);
}

main();
