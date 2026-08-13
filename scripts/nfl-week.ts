/**
 * nfl-week.ts — process ONE NFL week for Experiment No. 5: the private NFL
 * Backtest Learning Loop.
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
  assertSpreadConvention,
  loadInjuries,
  loadPlayerStats,
  loadCursor,
  saveCursor,
  nextCursor,
  buildBlindWeek,
  gamesForCursor,
  gradeGame,
  gradePropPick,
  upsertGradedRows,
  upsertGradedPropRows,
  loadGradedRows,
  loadLessonsCurrent,
  writeWeekLessons,
  computeStatRecord,
  buildActualStatMap,
  type Cursor,
  type GradedRow,
  type GradedPropRow,
  type PropPick,
  type StatRecord,
  type SplitStat,
} from "../src/lib/nfl-loop";
import {
  makeClaudePickFn,
  makeClaudePropsPickFn,
  makeClaudeReflectFn,
  type PickFn,
  type PropPickFn,
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

// Whether the week actually processed a slate (true) or we're caught up to the
// end of the loaded seasons (false). The seed loop reads this to know when to
// stop; a single `nfl:week` invocation ignores it.
async function runWeek(
  pickFn: PickFn,
  propPickFn: PropPickFn,
  reflectFn: ReflectFn,
): Promise<boolean> {
  const dir = defaultStateDir();
  const games = loadGames(dir);
  // Fail fast rather than silently manufacture a phantom edge (see the
  // function's comment for the incident this guard exists because of).
  assertSpreadConvention(games);
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
      return false;
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
    return false;
  }

  console.log(
    `${C}Processing${R} ${B}${cursorLabel(cursor)}${R} ${D}(${realSlate.length} games)${R}`,
  );

  // 1) BLIND pick. Injuries are a PRE-GAME source (reports publish before
  //    kickoff) — buildBlindWeek scopes them per game to the two playing teams.
  //    Absent cache → empty arrays (offline-safe).
  //    Player stats are optional — absent cache → playerContexts [] (offline-safe).
  const lessons = loadLessonsCurrent(dir);
  const injuries = loadInjuries(dir);
  const playerStats = loadPlayerStats(dir);
  const blind = buildBlindWeek(games, cursor, lessons, injuries, playerStats);
  const totalInj = blind.games.reduce(
    (s, g) => s + g.injuries.away.length + g.injuries.home.length,
    0,
  );
  console.log(
    `  injury reports attached: ${totalInj} across ${realSlate.length} games` +
      `${injuries.length === 0 ? ` ${D}(no injuries.csv — run npm run nfl:ingest-injuries)${R}` : ""}`,
  );
  console.log(
    `  player contexts: ${blind.playerContexts.length}` +
      `${playerStats.length === 0 ? ` ${D}(no player_stats.csv — run npm run nfl:ingest-props-stats)${R}` : ""}`,
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

  // 3) upsert the game picks log (idempotent)
  const { added, replaced } = upsertGradedRows(dir, graded);
  console.log(`  graded rows: ${G}${added} new${R}, ${replaced} replaced (rerun-safe)`);

  // week summary line
  const w = graded.filter((r) => r.result === "win").length;
  const l = graded.filter((r) => r.result === "loss").length;
  const pu = graded.filter((r) => r.result === "push").length;
  const wkPnl = graded.reduce((s, r) => s + r.pnlUnits, 0);
  console.log(`  week record ${B}${w}-${l}-${pu}${R}  P&L ${units(+wkPnl.toFixed(2))}`);

  // 4) Props — optional layer, silently skipped when playerContexts is empty
  const propPicks: PropPick[] = await propPickFn(blind);
  console.log(`  prop picks returned: ${propPicks.length}`);

  const gradedProps: GradedPropRow[] = [];
  if (propPicks.length > 0) {
    // Build actual stat map for this exact cursor week (grading path only)
    const actualStatMap = buildActualStatMap(playerStats, cursor);

    // Associate each prop pick with the gameId for the player's team this week
    for (const p of propPicks) {
      // Find the game where this player's team is playing
      const game = realSlate.find(
        (g) => g.awayTeam === p.team || g.homeTeam === p.team,
      );
      if (!game) {
        // Team string didn't match any slate game (abbreviation drift, mid-season
        // trade, etc.). Don't mint a fake-but-plausible gameId that detaches the
        // row from any real game forever — stamp empty so it's filterable, and
        // name the player/team so a 3am debugger can see WHY.
        console.warn(
          `  ${Y}prop: ${p.player} (${p.team}) ${p.stat} — team not on this week's slate; gameId left empty${R}`,
        );
      }
      const gameId = game?.gameId ?? "";
      gradedProps.push(gradePropPick(p, gameId, cursor, actualStatMap));
    }

    const noDataCount = gradedProps.filter((r) => r.result === "no-data").length;
    if (noDataCount > 0 && noDataCount / gradedProps.length > 0.3) {
      console.warn(
        `  ${Y}warning: ${noDataCount}/${gradedProps.length} prop picks have no-data (>${Math.round((noDataCount / gradedProps.length) * 100)}% no-data rate)${R}`,
      );
    }

    const { added: pAdded, replaced: pReplaced } = upsertGradedPropRows(dir, gradedProps);
    console.log(`  prop graded rows: ${G}${pAdded} new${R}, ${pReplaced} replaced`);

    // prop week summary
    const pw = gradedProps.filter((r) => r.result === "win").length;
    const pl = gradedProps.filter((r) => r.result === "loss").length;
    const pp = gradedProps.filter((r) => r.result === "push").length;
    const pnd = gradedProps.filter((r) => r.result === "no-data").length;
    console.log(`  prop record ${B}${pw}-${pl}-${pp}${R}${pnd ? ` ${D}(${pnd} no-data)${R}` : ""}`);
  }

  // 5) learn — reflect into the lessons memo (fed into next week's prompt)
  const memo = await reflectFn(blind, graded, gradedProps);
  writeWeekLessons(dir, cursor, memo);
  console.log(`  lessons memo written + rolled into lessons-current.md`);

  // 6) advance cursor — the COMMIT POINT
  const next = nextCursor(games, cursor);
  if (next) {
    saveCursor(dir, next);
    console.log(`  ${C}cursor advanced${R} → ${B}${cursorLabel(next)}${R}`);
  } else {
    console.log(`  ${Y}that was the final week of the loaded seasons.${R}`);
  }

  // cumulative snapshot
  printReport(computeStatRecord(loadGradedRows(dir)));
  return true;
}

// Seed mode — process every remaining week of the loaded seasons back-to-back
// until caught up. Crash-safe + idempotent: the cursor advance is the commit
// point, so a re-run resumes exactly where it stopped. maxWeeks is a runaway
// guard (3 seasons × ~22 weeks ≈ 66; 100 leaves headroom).
async function runSeed(
  pickFn: PickFn,
  propPickFn: PropPickFn,
  reflectFn: ReflectFn,
  maxWeeks = 100,
): Promise<void> {
  for (let i = 0; i < maxWeeks; i++) {
    console.log(`\n${B}━━━ seed week ${i + 1}/${maxWeeks} ━━━${R}`);
    let advanced = false;
    try {
      advanced = await runWeek(pickFn, propPickFn, reflectFn);
    } catch (err) {
      // One bad week (API blip, parse error) must not abort the whole overnight
      // seed. Log it and continue — the cursor only advances on a clean week,
      // so the next iteration retries the SAME week.
      console.error(`${RED}seed week ${i + 1} errored — retrying next iteration:${R}`, err);
      continue;
    }
    if (!advanced) {
      console.log(`\n${G}seed complete${R} — caught up to the end of the loaded seasons after ${i} processed week(s).`);
      return;
    }
  }
  console.log(`${Y}seed hit maxWeeks=${maxWeeks} guard — re-run to continue if not yet caught up.${R}`);
}

// Burst mode — the budget-capped nightly variant of seed. Processes weeks
// back-to-back until ONE of:
//   1. today's REAL logged spend (spend-log.jsonl, actual response.usage priced
//      at list rates) reaches the daily cap (NFL_BURST_DAILY_USD, default $20),
//   2. the walk is caught up to the end of the loaded seasons, or
//   3. three CONSECUTIVE weeks error (unlike seed's retry-forever: an
//      unattended 1 AM run with a dead API key must fail loudly in the cron
//      log, not spin all night).
// After any week that crosses a season boundary, the Opus dream re-distills the
// doctrine so the next season's picks carry the accumulated learning. The
// budget check runs BEFORE each week, so one week can overshoot the cap by at
// most its own cost (~$0.45) — same shape as every other spend gate in this repo.
async function runBurst(
  pickFn: PickFn,
  propPickFn: PropPickFn,
  reflectFn: ReflectFn,
): Promise<void> {
  const { spendTodayUsd } = await import("../src/lib/nfl-spend");
  const { spawnSync } = await import("node:child_process");
  const dir = defaultStateDir();
  const capRaw = Number.parseFloat(process.env.NFL_BURST_DAILY_USD ?? "");
  const cap = Number.isFinite(capRaw) && capRaw > 0 ? capRaw : 20;
  // Runaway guard well above what $20 of Sonnet weeks can reach (~45).
  const maxWeeks = 80;

  const runDream = (why: string) => {
    console.log(`\n${C}burst: running dream (${why})...${R}`);
    // Same spawn pattern as runners.ts. npx.cmd via shell for Windows; the
    // dream logs its own spend row. A dream failure must not stop the walk —
    // doctrine just refreshes on the next boundary.
    const r = spawnSync("npx", ["tsx", "scripts/nfl-dream.ts"], {
      stdio: "inherit",
      shell: true,
      timeout: 10 * 60 * 1000,
    });
    if (r.status !== 0) console.error(`${RED}burst: dream exited ${r.status} — continuing the walk.${R}`);
  };

  let consecutiveErrors = 0;
  for (let i = 0; i < maxWeeks; i++) {
    const spent = spendTodayUsd();
    if (spent >= cap) {
      console.log(
        `\n${G}burst done for today${R} — $${spent.toFixed(2)} of $${cap.toFixed(2)} daily budget spent ` +
          `after ${i} week(s). ${D}(cursor ${cursorLabel(loadCursor(dir))})${R}`,
      );
      return;
    }
    console.log(
      `\n${B}━━━ burst week ${i + 1} ━━━${R} ${D}$${spent.toFixed(2)} / $${cap.toFixed(2)} spent today${R}`,
    );

    const before = loadCursor(dir);
    let advanced = false;
    try {
      advanced = await runWeek(pickFn, propPickFn, reflectFn);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      console.error(
        `${RED}burst week errored (${consecutiveErrors}/3 consecutive):${R}`,
        err,
      );
      if (consecutiveErrors >= 3) {
        console.error(`${RED}burst aborting — 3 consecutive failures. Fix and re-run; the cursor is unchanged for the failed week.${R}`);
        process.exitCode = 1;
        return;
      }
      continue;
    }

    if (!advanced) {
      console.log(`\n${G}burst complete — walk caught up to the end of the loaded seasons.${R}`);
      runDream("walk complete");
      return;
    }

    const after = loadCursor(dir);
    if (after.season !== before.season) {
      runDream(`season boundary ${before.season} -> ${after.season}`);
    }
  }
  console.log(`${Y}burst hit maxWeeks=${maxWeeks} guard — cap logic suspect, investigate before re-running.${R}`);
}

async function main() {
  const mode = (process.argv[2] ?? "run").toLowerCase();
  const dir = defaultStateDir();

  if (mode === "report") {
    printReport(computeStatRecord(loadGradedRows(dir)));
    return;
  }

  // Real Claude functions — constructed lazily so `report`/tests never need a key.
  if (mode === "seed") {
    await runSeed(makeClaudePickFn(), makeClaudePropsPickFn(), makeClaudeReflectFn());
    return;
  }

  if (mode === "burst") {
    await runBurst(makeClaudePickFn(), makeClaudePropsPickFn(), makeClaudeReflectFn());
    return;
  }

  await runWeek(makeClaudePickFn(), makeClaudePropsPickFn(), makeClaudeReflectFn());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
