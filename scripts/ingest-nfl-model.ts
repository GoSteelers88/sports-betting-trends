/**
 * ingest-nfl-model.ts — builds the week's NFL win-probability model file.
 *
 * Reads:
 *   data/processed/nfl-live/ledger.json          (which board is current)
 *   data/processed/nfl-live/board-<season>-wkNN.json (the published doctrine board)
 * Writes:
 *   data/processed/nfl-model.json
 *
 * The NFL model is NOT rebuilt here — it is the Experiment No. 5 loop's
 * published, notarized doctrine board (scripts/nfl-publish-board.ts). This
 * script projects that board into the envelope the agent's
 * `get_model_probabilities` tool reads for NBA / WNBA / NHL (data.results[]).
 * See src/lib/nfl-model-from-board.ts for the PLAY / PASS rule that keeps the
 * account's NFL picks a subset of the doctrine's plays.
 *
 * Run after `npm run nfl:publish` (Tuesdays) and before `npm run agent:run`.
 * No network, no credits: everything it reads is committed.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeModelFile } from "../src/lib/hockey-model";
import { loadLedger, defaultLedgerPath } from "../src/lib/nfl-receipts/ledger";
import type { PublishedBoard } from "../src/lib/nfl-receipts/board";
import {
  buildNflModelFromBoard,
  emptyNflModel,
  latestBoardFile,
} from "../src/lib/nfl-model-from-board";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const processedDir = path.join(rootDir, "data", "processed");
const liveDir = path.join(processedDir, "nfl-live");
const outPath = path.join(processedDir, "nfl-model.json");

function main(): void {
  const now = Date.now();
  const ledger = loadLedger(defaultLedgerPath(rootDir));
  const boardFile = latestBoardFile(ledger.boards);
  if (!boardFile) {
    const empty = emptyNflModel(new Date(now).toISOString(), "no board registered in ledger.json");
    fs.mkdirSync(processedDir, { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(empty, null, 2), "utf-8");
    console.log("[ingest-nfl-model] no published board yet — wrote empty model");
    return;
  }

  const boardPath = path.join(liveDir, boardFile);
  if (!fs.existsSync(boardPath)) {
    console.error(`[ingest-nfl-model] ledger names ${boardFile} but ${boardPath} is missing`);
    process.exit(1);
  }
  const board = JSON.parse(fs.readFileSync(boardPath, "utf8")) as PublishedBoard;
  const output = buildNflModelFromBoard(board, boardFile, now);

  // writeModelFile is the shared tmp-then-rename writer; the envelope is a
  // superset of ModelOutput's outer shape (generatedAt/source/status/…/data).
  writeModelFile(outPath, output as unknown as Parameters<typeof writeModelFile>[1]);

  const plays = output.data.results.filter((r) => r.verdict === "PLAY");
  console.log(
    `[ingest-nfl-model] ${boardFile} (${output.season} wk${output.week}, published ${output.freshnessMins} min ago): ` +
      `${output.recordCount} games modeled, ${plays.length} doctrine PLAY. Wrote ${outPath}`,
  );
  for (const r of output.data.results) {
    const fav = r.homeWinProb >= 0.5 ? r.homeTeam : r.awayTeam;
    const favProb = r.homeWinProb >= 0.5 ? r.homeWinProb : r.awayWinProb;
    console.log(
      `  ${r.verdict.padEnd(4)} ${r.awayTeam} @ ${r.homeTeam} — ${fav} ${(favProb * 100).toFixed(1)}%  ${r.notes[0] ?? ""}`,
    );
  }
  if (output.errors.length > 0) {
    console.warn(`[ingest-nfl-model] ${output.errors.length} legs skipped:`);
    for (const e of output.errors) console.warn(`  ${e}`);
  }
}

main();
