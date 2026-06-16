/**
 * nfl-week.ts — process ONE NFL week for the private Backtest Learning Loop.
 *
 *   npm run nfl:week           # pick → grade → learn → advance the cursor
 *   npm run nfl:week report    # read-only cumulative stat record + calibration
 *
 * The cycle order is: pick → grade → upsert log → write lessons → advance cursor.
 * The cursor advance is the commit point, so a crash mid-week re-processes that
 * week cleanly (the log is keyed by gameId|market — no double-count).
 *
 * The pick/reflect steps call Claude (needs ANTHROPIC_API_KEY). `report` and the
 * test suite never call the network — the pick function is injected.
 */
import {
  defaultStateDir,
  loadGames,
  loadInjuries,
  loadCursor,
  saveCursor,
  nextCursor,
  buildBlindWeek,
  gamesForCursor,
  gradeGame,
  upsertGradedRows,
  loadGradedRows,
  loadLessonsCurrent,
  writeWeekLessons,
  computeStatRecord,
  type Cursor,
  type GradedRow,
  type StatRecord,
  type SplitStat,
} from "../src/lib/nfl-loop";
import {
  makeClaudePickFn,
  makeClaudeReflectFn,
  type PickFn,
  type ReflectFn,
} from "../src/lib/nfl-agent";

const B = "\x1b[1m";
const R = "\x1b[0m";
const G = "\x1b[32m";
const RED = "\x1b[31m";
const Y = "\x1b[33m";
const D = "\x1b[2m";
const C = "\x1b[36m";

function pct(n: number | null): string {
  return n == null ? "  -  " : `${(n * 100).toFixed(1)}%`;
}
function units(n: number): string {
  const s = `${Math.abs(n).toFixed(2)}u`;
  return n > 0 ? `${G}+${s}${R}` : n < 0 ? `${RED}-${s}${R}` : `${D}${s}${R}`;
}
function roi(n: number | null): string {
  if (n == null) return `${D}  -  ${R}`;
  return n > 0 ? `${G}+${n.toFixed(1)}%${R}` : n < 0 ? `${RED}${n.toFixed(1)}%${R}` : `${D}0.0%${R}`;
}

function printSplit(rows: SplitStat[], indent = "    "): void {
  for (const s of rows) {
    console.log(
      `${indent}${s.label.padEnd(18)} ${String(s.wins).padStart(3)}-${String(s.losses).padStart(3)}-${String(s.pushes).padStart(2)}  ` +
        `win ${pct(s.winRate).padStart(6)}  roi ${roi(s.roiPct)}  ${D}(${s.n})${R}`,
    );
  }
}

function printReport(record: StatRecord): void {
  console.log(`\n${B}NFL Loop — cumulative stat record${R} ${D}(${record.totalRows} graded rows)${R}`);

  console.log(`\n  ${B}Overall by market${R}`);
  printSplit([record.overall.ats, record.overall.moneyline, record.overall.total]);

  const baseFav = record.baseRates.favoriteCoverRate;
  const baseOver = record.baseRates.overRate;
  console.log(
    `\n  ${B}Base rates${R}  favorite-cover ${pct(baseFav)}   over rate ${pct(baseOver)}`,
  );

  const sections: Array<[string, SplitStat[]]> = [
    ["Favorite vs underdog (ATS)", record.splits.favoriteVsDog],
    ["Home vs away (ATS+ML)", record.splits.homeVsAway],
    ["Divisional", record.splits.divisional],
    ["Dome vs outdoor", record.splits.domeVsOutdoor],
    ["By rest advantage", record.splits.byRestAdvantage],
    ["By wind", record.splits.byWind],
    ["By temperature", record.splits.byTemp],
  ];
  for (const [title, rows] of sections) {
    if (rows.length === 0) continue;
    console.log(`\n  ${B}${title}${R}`);
    printSplit(rows);
  }

  if (record.calibration.length) {
    console.log(`\n  ${B}Calibration${R} ${D}(confidence bucket → realized win rate)${R}`);
    for (const c of record.calibration) {
      const gap =
        c.realized == null ? "" : ` ${D}gap ${((c.realized - c.predicted) * 100).toFixed(1)}pp${R}`;
      console.log(
        `    ${c.label}   pred ${pct(c.predicted)}  real ${pct(c.realized).padStart(6)}  ${D}(n=${c.n})${R}${gap}`,
      );
    }
  }
  console.log(
    `\n  ${D}Note: nflverse lines are ~closing — treat any positive ROI as an optimistic upper bound.${R}\n`,
  );
}

function cursorLabel(c: Cursor): string {
  return `${c.season} ${c.phase} wk${c.week}`;
}

async function runWeek(pickFn: PickFn, reflectFn: ReflectFn): Promise<void> {
  const dir = defaultStateDir();
  const games = loadGames(dir);
  let cursor = loadCursor(dir);

  // Snap a fresh/stale cursor onto the first real scheduled week.
  const slate = gamesForCursor(games, cursor);
  if (slate.length === 0) {
    const snapped = nextCursor(games, { ...cursor, week: cursor.week - 1 });
    // nextCursor on (week-1) returns the first week >= cursor; if even that's
    // null we're genuinely caught up.
    if (!snapped) {
      console.log(
        `${Y}caught up${R} — processed through the end of the loaded seasons. ` +
          `Awaiting a live season. ${D}(cursor ${cursorLabel(cursor)})${R}`,
      );
      return;
    }
    if (snapped.season !== cursor.season || snapped.phase !== cursor.phase || snapped.week !== cursor.week) {
      console.log(`${D}snapping cursor ${cursorLabel(cursor)} → ${cursorLabel(snapped)}${R}`);
      cursor = snapped;
      saveCursor(dir, cursor);
    }
  }

  const realSlate = gamesForCursor(games, cursor);
  if (realSlate.length === 0) {
    console.log(
      `${Y}caught up${R} — no games for ${cursorLabel(cursor)}. Awaiting a live season.`,
    );
    return;
  }

  console.log(
    `${C}Processing${R} ${B}${cursorLabel(cursor)}${R} ${D}(${realSlate.length} games)${R}`,
  );

  // 1) BLIND pick. Injuries are a PRE-GAME source (reports publish before
  //    kickoff) — buildBlindWeek scopes them per game to the two playing teams.
  //    Absent cache → empty arrays (offline-safe).
  const lessons = loadLessonsCurrent(dir);
  const injuries = loadInjuries(dir);
  const blind = buildBlindWeek(games, cursor, lessons, injuries);
  const totalInj = blind.games.reduce(
    (s, g) => s + g.injuries.away.length + g.injuries.home.length,
    0,
  );
  console.log(
    `  injury reports attached: ${totalInj} across ${realSlate.length} games` +
      `${injuries.length === 0 ? ` ${D}(no injuries.csv — run npm run nfl:ingest-injuries)${R}` : ""}`,
  );
  const picks = await pickFn(blind);
  console.log(`  picks returned: ${picks.length}/${realSlate.length} games`);

  // 2) grade against real results (separate path — never fed to the model)
  const byId = new Map(realSlate.map((g) => [g.gameId, g]));
  const graded: GradedRow[] = [];
  for (const p of picks) {
    const game = byId.get(p.gameId);
    if (!game) continue;
    graded.push(...gradeGame(game, p));
  }

  // 3) upsert the log (idempotent)
  const { added, replaced } = upsertGradedRows(dir, graded);
  console.log(`  graded rows: ${G}${added} new${R}, ${replaced} replaced (rerun-safe)`);

  // week summary line
  const w = graded.filter((r) => r.result === "win").length;
  const l = graded.filter((r) => r.result === "loss").length;
  const pu = graded.filter((r) => r.result === "push").length;
  const wkPnl = graded.reduce((s, r) => s + r.pnlUnits, 0);
  console.log(`  week record ${B}${w}-${l}-${pu}${R}  P&L ${units(+wkPnl.toFixed(2))}`);

  // 4) learn — reflect into the lessons memo (fed into next week's prompt)
  const memo = await reflectFn(blind, graded);
  writeWeekLessons(dir, cursor, memo);
  console.log(`  lessons memo written + rolled into lessons-current.md`);

  // 5) advance cursor — the COMMIT POINT
  const next = nextCursor(games, cursor);
  if (next) {
    saveCursor(dir, next);
    console.log(`  ${C}cursor advanced${R} → ${B}${cursorLabel(next)}${R}`);
  } else {
    console.log(`  ${Y}that was the final week of the loaded seasons.${R}`);
  }

  // cumulative snapshot
  printReport(computeStatRecord(loadGradedRows(dir)));
}

async function main() {
  const mode = (process.argv[2] ?? "run").toLowerCase();
  const dir = defaultStateDir();

  if (mode === "report") {
    printReport(computeStatRecord(loadGradedRows(dir)));
    return;
  }

  // Real Claude functions — constructed lazily so `report`/tests never need a key.
  await runWeek(makeClaudePickFn(), makeClaudeReflectFn());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
