/**
 * Parlay paper book CLI — Experiment No. 4 (PARLAY_PAPER_SPEC.md).
 *
 * One cycle: grade open legs against ESPN box scores, settle parlays whose
 * legs are all terminal (push/void legs drop + re-price), assemble new disjoint
 * +EV three-leg parlays from the props-board log, snapshot the equity curve.
 * Places NO real bets — there is no broker client anywhere in this path.
 *
 *   npm run paper:parlay           # run a cycle + report
 *   npm run paper:parlay report    # read-only report (no grade/settle/open)
 *
 * Pre-req: the props board must have logged playable rows first
 * (ingest:soft-props + ingest:sharp-props + board:props). Each props-board row
 * now carries a gameId so legs can be proven to come from distinct games.
 */
import path from "node:path";
import {
  runParlayPaperCycle,
  getParlayLedgerView,
  computeStats,
  loadBook,
  PARLAY_PAPER_CONFIG,
  type ParlayPaperStats,
  type SkipTally,
  type ParlayBet,
} from "../src/lib/parlay-paper";

const B = "\x1b[1m";
const R = "\x1b[0m";
const G = "\x1b[32m";
const RED = "\x1b[31m";
const D = "\x1b[2m";
const C = "\x1b[36m";

function money(n: number): string {
  const s = `$${Math.abs(n).toFixed(2)}`;
  return n < 0 ? `-${s}` : s;
}

function legLine(l: ParlayBet["legs"][number]): string {
  const odds = `${l.oddsAmerican > 0 ? "+" : ""}${l.oddsAmerican}`;
  const mark =
    l.status === "won"
      ? `${G}✓${R}`
      : l.status === "lost"
        ? `${RED}✗${R}`
        : l.status === "push" || l.status === "void"
          ? `${D}∅${R}`
          : `${D}·${R}`;
  return (
    `    ${mark} ${l.player} ${l.propType} ${l.side} ${l.line} @ ${odds} ` +
    `${D}(${l.book} · ${(l.fairProb * 100).toFixed(0)}% fair · ${l.gameId})${R}` +
    (l.actual != null ? `  ${D}actual ${l.actual}${R}` : "")
  );
}

function printStats(s: ParlayPaperStats) {
  const pnlColor = s.realizedPnlUsd > 0 ? G : s.realizedPnlUsd < 0 ? RED : D;
  console.log(
    `\n${B}Parlay paper book${R}  ${D}($${PARLAY_PAPER_CONFIG.startingBankrollUsd.toLocaleString()} book · ${PARLAY_PAPER_CONFIG.minLegs}–${PARLAY_PAPER_CONFIG.maxLegs} legs · distinct games · +EV legs ≥ ${(PARLAY_PAPER_CONFIG.evFloor * 100).toFixed(0)}% · ¼-Kelly on the combined)${R}`,
  );
  console.log(
    `  equity ${B}${money(s.equityUsd)}${R}  ` +
      `realized ${pnlColor}${money(s.realizedPnlUsd)} (${s.roiPct > 0 ? "+" : ""}${s.roiPct}%)${R}  ` +
      `exposure ${money(s.exposureUsd)}`,
  );
  console.log(
    `  parlays: ${s.openCount} open · ${s.settledCount} settled  ` +
      `record ${s.wins}-${s.losses}${s.voids ? `-${s.voids}` : ""} ` +
      `${s.winRatePct != null ? `(${s.winRatePct}%)` : ""}  ` +
      (s.yieldPct != null
        ? `yield ${s.yieldPct > 0 ? "+" : ""}${s.yieldPct}% on ${money(s.totalStakedUsd)} staked`
        : ""),
  );
  if (s.avgParlayEv != null) {
    console.log(`  ${D}avg parlay EV at open: ${(s.avgParlayEv * 100).toFixed(1)}%${R}`);
  }
  if (s.settledCount === 0 && s.openCount === 0) {
    console.log(
      `  ${D}no parlays yet — the rule only fires on 2–3 independent +EV legs across distinct games. This is the honest book.${R}`,
    );
  }
}

function printTally(t: SkipTally) {
  if (t.started === 0) {
    console.log(
      `  ${D}no playable independent triples tonight — nothing to assemble (need 3 playable legs across 3 distinct games).${R}`,
    );
    if (t.noGameId > 0) {
      console.log(`  ${D}(${t.noGameId} playable leg(s) skipped for missing gameId)${R}`);
    }
    return;
  }
  console.log(
    `  ${D}skip tally — started ${t.started}, same-game ${t.sameGame}, correlated ${t.correlated}, ` +
      `neg-EV ${t.negEV}, haircut ${t.haircut}, too-small ${t.tooSmall}, dup ${t.dup}, ` +
      `no-gameId ${t.noGameId}, leg-reused ${t.legReused}${R}`,
  );
}

async function main() {
  const dir = path.join(process.cwd(), "data", "processed");
  const mode = (process.argv[2] ?? "cycle").toLowerCase();

  if (mode === "report") {
    printStats(computeStats(loadBook(dir)));
    console.log("");
    return;
  }

  const { opened, settled, legsGraded, tally, stats } = await runParlayPaperCycle({ dataDir: dir });
  console.log(
    `${C}cycle done${R} — ${G}+${opened} opened${R}, ${settled} settled, ${legsGraded} legs graded`,
  );
  printTally(tally);
  printStats(stats);

  const view = getParlayLedgerView(dir);
  if (view.open.length) {
    console.log(`\n${B}Open parlays:${R}`);
    for (const p of view.open) {
      console.log(
        `  ${B}#${p.id.slice(0, 10)}…${R}  ${money(p.stakeUsd)} to win ${money(p.stakeUsd * (p.parlayDecimalOdds - 1))}  ` +
          `${D}EV ${(p.parlayEV * 100).toFixed(1)}% · flip-δ ${(p.flipDelta * 100).toFixed(1)}pt · dec ${p.parlayDecimalOdds.toFixed(2)}${R}`,
      );
      for (const l of p.legs) console.log(legLine(l));
    }
  }
  if (view.settled.length) {
    console.log(`\n${B}Recently settled:${R}`);
    for (const p of view.settled.slice(0, 8)) {
      const col = p.status === "won" ? G : p.status === "lost" ? RED : D;
      console.log(
        `  ${col}${p.status.toUpperCase().padEnd(5)}${R} ${money(p.pnlUsd ?? 0).padStart(10)}  ` +
          `${D}${p.survivingLegIds.length}/${p.legs.length} legs survived · EV ${(p.parlayEV * 100).toFixed(1)}%${R}`,
      );
      for (const l of p.legs) console.log(legLine(l));
    }
  }
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
