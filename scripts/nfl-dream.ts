/**
 * nfl-dream.ts — the periodic Opus CONSOLIDATION for Experiment No. 5 (the
 * private NFL Backtest Learning Loop). The "learn toward the goal" mechanism.
 *
 *   npm run nfl:dream          # read the full record → Opus → write the doctrine
 *   npm run nfl:dream summary  # also print the machine summary (keyMetrics)
 *   npm run nfl:dream final    # WALK-COMPLETION dream on MODELS.nflDreamFinal
 *                              # (Fable 5) — the burst passes this automatically
 *                              # when the walk catches up; args compose
 *                              # ("final summary" works)
 *
 * Reads the PRIVATE, gitignored NFL loop logs:
 *   data/private/nfl-loop/picks-log.jsonl        (GradedRow[]     — game picks)
 *   data/private/nfl-loop/prop-picks-log.jsonl   (GradedPropRow[] — prop picks)
 *   data/private/nfl-loop/lessons/lessons-current.md (the rolling per-week memo)
 * and writes ONLY:
 *   data/private/nfl-loop/lessons/nfl-doctrine.md   (durable cross-season doctrine)
 *
 * QUARANTINE: NFL is NOT in IN_SCOPE_LEAGUES — this never touches AgentMemory /
 * the live NBA+MLB pipeline. It is a READ over the record + a WRITE to the one
 * private doctrine file; it never re-grades, re-picks, or mutates the picks logs.
 *
 * HONESTY: the record is graded vs ~closing lines (CLV ≈ 0). The doctrine's
 * numbers are an OPTIMISTIC UPPER BOUND — directional, "validate live". The dream
 * system prompt enforces this (and the no-70%-parlay-win-rate math).
 *
 * No-ops politely when the record is empty (no Opus spend on nothing).
 */
import {
  defaultStateDir,
  loadGradedRows,
  loadGradedPropRows,
} from "../src/lib/nfl-loop";
import {
  consolidateNflDream,
  makeClaudeNflDreamFn,
  nflDoctrinePath,
} from "../src/lib/nfl-dream";
import { MODELS } from "../src/lib/agent/client";
import path from "node:path";

const B = "\x1b[1m";
const R = "\x1b[0m";
const D = "\x1b[2m";
const C = "\x1b[36m";
const Y = "\x1b[33m";
const G = "\x1b[32m";

function pct(n: number | null): string {
  return n == null ? "—" : `${(n * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).map((a) => a.toLowerCase());
  const asSummary = args.includes("summary");
  const isFinal = args.includes("final");
  const model = isFinal ? MODELS.nflDreamFinal : MODELS.dream;
  const dir = defaultStateDir();

  const gameRows = loadGradedRows(dir);
  const propRows = loadGradedPropRows(dir);

  if (gameRows.length === 0) {
    console.log(
      `${Y}No graded game rows under ${path.relative(process.cwd(), dir)} — ` +
        `nothing to consolidate. Run \`npm run nfl:seed\` first.${R}`,
    );
    return;
  }

  console.log(
    `${C}NFL dream${R} — consolidating ${B}${gameRows.length}${R} graded game rows + ` +
      `${B}${propRows.length}${R} prop rows into durable cross-season doctrine…` +
      (isFinal ? ` ${Y}[FINAL walk-completion pass on ${model}]${R}` : ""),
  );
  console.log(
    `${D}(graded vs ~closing lines → optimistic upper bound; doctrine is directional, validate live)${R}`,
  );

  const result = await consolidateNflDream({
    dir,
    gameRows,
    propRows,
    dreamFn: makeClaudeNflDreamFn(model),
  });

  if (!result) {
    console.log(`${Y}Empty record — no doctrine written.${R}`);
    return;
  }

  const m = result.keyMetrics;
  const s = result.recordSummary;
  console.log("");
  console.log(`${B}━━━ doctrine written ━━━${R}`);
  console.log(`  ${G}→ ${path.relative(process.cwd(), nflDoctrinePath(dir))}${R}`);
  console.log("");
  console.log(`  seasons:            ${s.seasons.join(", ")}`);
  console.log(
    `  ATS:                ${s.overallByMarket.ats.record}  win ${pct(s.overallByMarket.ats.winRate)}  ` +
      `roi ${s.overallByMarket.ats.roiPct == null ? "—" : s.overallByMarket.ats.roiPct + "%"}  ${D}(n=${s.overallByMarket.ats.n})${R}`,
  );
  console.log(
    `  Moneyline:          ${s.overallByMarket.moneyline.record}  win ${pct(s.overallByMarket.moneyline.winRate)}  ${D}(n=${s.overallByMarket.moneyline.n})${R}`,
  );
  console.log(
    `  Total:              ${s.overallByMarket.total.record}  win ${pct(s.overallByMarket.total.winRate)}  ${D}(n=${s.overallByMarket.total.n})${R}`,
  );
  console.log(
    `  calibration gap:    ${m.calibrationGapPp == null ? "—" : m.calibrationGapPp + "pp"} ${D}(mean |realized−predicted|, weighted)${R}`,
  );
  console.log(
    `  parlay backtest:    ${s.parlay.settled} settled (W ${s.parlay.wins}/L ${s.parlay.losses})  ` +
      `win ${s.parlay.winRatePct == null ? "—" : s.parlay.winRatePct + "%"}  ` +
      `yield ${s.parlay.yieldPct == null ? "—" : s.parlay.yieldPct + "%"}`,
  );
  console.log("");

  if (asSummary) {
    console.log(JSON.stringify(result.keyMetrics, null, 2));
    console.log("");
  }

  console.log(`${B}━━━ doctrine ━━━${R}`);
  console.log(result.lessons);
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
