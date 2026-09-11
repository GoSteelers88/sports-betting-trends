/**
 * nfl-grade-live.ts — grade a PRIVATE live-week model board against results.
 *
 *   npm run nfl:grade-live -- [season] [week]
 *
 * Reads  data/private/nfl-loop/live-boards/<season>-REG-wk<week>.json (the
 *        board nfl-live-week.ts wrote — every leg, PLAY and PASS)
 *        data/private/nfl-loop/games.csv (results; refresh with nfl:ingest)
 * Writes data/private/nfl-loop/live-graded.jsonl (upsert by key; private)
 *
 * This is the calibration RECORD for live reads. It never touches
 * picks-log.jsonl (the backtest record) and it changes no rule: whether the
 * calibration fit reads this log is the `--with-live-calibration` switch on
 * nfl-live-week.ts, OFF by default. Legs whose game has no final yet are
 * reported and left for the next run.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultStateDir, loadGames } from "../src/lib/nfl-loop";
import {
  gradeLiveBoard,
  loadLiveGradedRows,
  upsertLiveGradedRows,
  type LiveBoardLeg,
} from "../src/lib/nfl-live-grade";

function main(): void {
  const season = Number(process.argv[2] ?? new Date().getUTCFullYear());
  const week = Number(process.argv[3] ?? 1);
  const dir = defaultStateDir();
  const boardPath = path.join(dir, "live-boards", `${season}-REG-wk${week}.json`);
  if (!fs.existsSync(boardPath)) {
    console.error(`[nfl-grade-live] no private board at ${boardPath} — nothing to grade`);
    process.exit(1);
  }
  const board = JSON.parse(fs.readFileSync(boardPath, "utf8")) as { board?: LiveBoardLeg[] };
  const legs = board.board ?? [];
  if (legs.length === 0) {
    console.error(`[nfl-grade-live] ${boardPath} has no legs`);
    process.exit(1);
  }

  const games = loadGames(dir);
  const res = gradeLiveBoard(legs, games, new Date().toISOString());
  const io = upsertLiveGradedRows(dir, res.rows);
  const total = loadLiveGradedRows(dir);

  const byMarket = new Map<string, { n: number; w: number }>();
  for (const r of res.rows) {
    const m = byMarket.get(r.market) ?? { n: 0, w: 0 };
    if (r.result !== "push") {
      m.n++;
      if (r.result === "win") m.w++;
    }
    byMarket.set(r.market, m);
  }
  console.log(
    `[nfl-grade-live] ${season} wk${week}: graded ${res.rows.length}/${legs.length} legs ` +
      `(${io.added} new, ${io.replaced} replaced) · pending ${res.pending.length} · ` +
      `unparsed ${res.unparsed.length} · unknown games ${res.unknownGames.length} · log now ${total.length} rows`,
  );
  for (const [mkt, m] of byMarket) {
    console.log(`  ${mkt.padEnd(9)} ${m.w}-${m.n - m.w}${m.n ? ` (${((m.w / m.n) * 100).toFixed(0)}%)` : ""}`);
  }
  for (const p of res.pending) console.log(`  pending: ${p}`);
  for (const u of res.unparsed) console.warn(`  UNPARSED: ${u}`);
  for (const u of res.unknownGames) console.warn(`  UNKNOWN GAME: ${u}`);
}

main();
