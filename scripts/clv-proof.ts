/**
 * CLV-proof CLI — one tick of the harness: lock new entries, refresh closes,
 * settle started games, print the accumulated report.
 *
 * Run it on a schedule (every 30-60 min during game days) so it captures entry
 * prices early and the closing sharp line late. The report becomes meaningful
 * after a few dozen settled sides.
 *
 *   npm run clv:proof          # one tick + report
 *   npm run clv:proof -- report  # report only (no capture)
 *
 * Pre-req each tick (the schedulers should run these first):
 *   npm run ingest:sharp && npm run ingest:odds && THE_ODDS_REGIONS=us,us2 npm run ingest:softbooks
 */
import path from "node:path";
import { loadStore, report, runTick } from "../src/lib/clv-proof";

const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";

function pct(n: number): string {
  return (n * 100).toFixed(1) + "%";
}

function printReport(r: ReturnType<typeof report>) {
  console.log(
    `\n${BOLD}CLV proof — ${r.settled} settled / ${r.pending} pending / ${r.totalEntries} total${RESET}`,
  );
  if (r.settled === 0) {
    console.log(
      `${DIM}  no settled entries yet — let games finish, then re-run. The signal needs a few dozen.${RESET}`,
    );
    return;
  }
  const order = Object.keys(r.byScope).sort((a, b) => {
    const rank = (k: string) =>
      k === "would_bet_only" ? 0 : k === "all_settled" ? 1 : 2;
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  console.log(
    `  ${"scope".padEnd(18)} ${"n".padStart(4)}  ${"beat-close".padStart(10)}  ${"avg CLV".padStart(8)}  ${"avg EV vs close".padStart(15)}`,
  );
  for (const k of order) {
    const s = r.byScope[k];
    if (s.n === 0) continue;
    const beatColor = s.beatCloseRate >= 0.55 ? GREEN : s.beatCloseRate >= 0.5 ? CYAN : RED;
    const evColor = s.avgEvVsClose > 0 ? GREEN : RED;
    console.log(
      `  ${k.padEnd(18)} ${String(s.n).padStart(4)}  ` +
        `${beatColor}${pct(s.beatCloseRate).padStart(10)}${RESET}  ` +
        `${(s.avgClvProbPoints > 0 ? "+" : "") + s.avgClvProbPoints}pp`.padStart(8) +
        `  ${evColor}${(s.avgEvVsClose > 0 ? "+" : "") + pct(s.avgEvVsClose)}${RESET}`.padStart(24),
    );
  }
  console.log(
    `${DIM}  beat-close ≥55% with avg CLV >0 = the timing edge is real. <50% = it isn't.${RESET}`,
  );
}

async function main() {
  const dir = path.join(process.cwd(), "data", "processed");
  const mode = (process.argv[2] ?? "tick").toLowerCase();

  if (mode === "report") {
    printReport(report(loadStore(dir)));
    console.log("");
    return;
  }

  const { summary, report: r } = runTick({ dataDir: dir });
  console.log(
    `${CYAN}tick @ ${summary.nowIso}${RESET} — ` +
      `${GREEN}+${summary.newEntries} entries${RESET}, ` +
      `${summary.refreshedCloses} closes refreshed, ` +
      `${summary.settled} settled` +
      (summary.skippedSuspicious
        ? `, ${summary.skippedSuspicious} suspicious skipped`
        : ""),
  );
  for (const [lg, b] of Object.entries(summary.boards)) {
    console.log(`${DIM}  ${lg}: sharp ${b.sharpGames} · soft ${b.softGames}${RESET}`);
  }
  printReport(r);
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
