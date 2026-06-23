// quant-desk/nfl-runner.ts — Experiment No. 5 (NFL): the QUIET NFL DRY-RUN (private).
//
// Runs the SAME deterministic engine (scan → playable → ¼-Kelly + drawdown rail
// → ledger + CLV) over the NFL loop's cached HISTORICAL weeks. Because nflverse
// lines are ~CLOSING and the games are already played, this is a BACKTEST: for
// each week we (1) read the Elo dry-run fair value + de-vigged closing line,
// (2) record every playable bet at the closing price, (3) grade it against the
// known result in the same pass. Entry == close, so CLV ≈ 0 by construction —
// we report that honestly; the value here is proving the desk's machinery on
// real games and measuring the model-vs-market EDGE DISTRIBUTION.
//
// QUIET: everything lives under data/private/nfl-loop/quant/. No dashboard, no
// nav, no user-facing NFL strings. Reads the loop's games.csv; never mutates it.

import {
  loadGames,
  defaultStateDir,
  type GameRow,
} from "../nfl-loop";
import {
  americanToDecimal,
  americanToImpliedProb,
  probToAmerican,
} from "../devig";
import {
  isPlayable,
  stakeFor,
  drawdownBreached,
  computeStats,
  writeSnapshot,
  QUANT_DESK_CONFIG,
  betId,
  type QuantStats,
} from "./engine";
import {
  buildNflWeekOpps,
  gradeNflMoneyline,
  walkSchedulePrimed,
} from "./adapters/nfl";
import { loadBook, saveBook, nflBookDir } from "./store";
import type { QuantBet, QuantBook } from "./types";

export interface NflDryRunResult {
  weeksProcessed: number;
  betsRecorded: number;
  oppsScanned: number;
  playable: number;
  railSkips: number;
  stats: QuantStats;
}

/** Run the FULL dry-run over every cached week, from a FRESH book each time
 *  (deterministic + idempotent — re-running reproduces the same book). The Elo
 *  ledger is leak-safe: each week's opps are read before that week's results
 *  feed the ledger. */
export function runNflDryRun(opts: { stateDir?: string; outDir?: string } = {}): NflDryRunResult {
  const stateDir = opts.stateDir ?? defaultStateDir();
  const outDir = opts.outDir ?? nflBookDir();
  const games = loadGames(stateDir);

  // Index games by id for fast grading.
  const byId = new Map<string, GameRow>(games.map((g) => [g.gameId, g]));

  // Fresh book — the dry-run is a deterministic backtest, not an accumulating
  // live book, so we rebuild it from scratch every run.
  const book: QuantBook = { updatedAt: "", bets: [], ledger: [] };
  const cfg = QUANT_DESK_CONFIG;

  let weeksProcessed = 0;
  let oppsScanned = 0;
  let playable = 0;
  let railSkips = 0;

  for (const { cursor, elo } of walkSchedulePrimed(games)) {
    const opps = buildNflWeekOpps(games, cursor, elo);
    if (opps.length === 0) continue;
    weeksProcessed++;
    oppsScanned += opps.length;

    // Sizing uses the equity AT THE START of this week (sequential bankroll).
    let stats = computeStats(book, cfg);
    const railActive = drawdownBreached(stats, cfg);

    for (const opp of opps) {
      if (!isPlayable(opp, cfg)) continue;
      playable++;
      if (railActive) {
        railSkips++;
        continue; // drawdown rail: no new opens while underwater
      }
      const id = betId("NFL", opp.gameId, opp.fair.key);
      if (book.bets.some((b) => b.id === id)) continue; // idempotent
      const stake = stakeFor(opp.fair.modelFairProb, opp.line.priceAmerican, stats.equityUsd, cfg);
      if (stake <= 0) continue;

      // The closing-line entry: entry price == close fair (entry==close).
      const closeFairAmerican = probToAmerican(opp.line.devigMarketProb);
      const bet: QuantBet = {
        id,
        sport: "NFL",
        gameId: opp.gameId,
        matchup: opp.matchup,
        market: opp.fair.market,
        selection: opp.fair.selection,
        commenceTime: opp.commenceTime,
        entryAt: opp.commenceTime,
        priceAmerican: opp.line.priceAmerican,
        book: opp.line.book,
        modelFairProb: +opp.fair.modelFairProb.toFixed(4),
        devigMarketProb: +opp.line.devigMarketProb.toFixed(4),
        edge: opp.edge,
        stakeUsd: stake,
        estimate: opp.fair.estimate,
        closeAt: opp.commenceTime,
        closeDevigMarketProb: +opp.line.devigMarketProb.toFixed(4),
        closeFairAmerican: Number.isFinite(closeFairAmerican) ? closeFairAmerican : NaN,
        clvCents: null,
        beatClose: null,
        status: "open",
        finalScore: null,
        pnlUsd: null,
        settledAt: null,
      };

      // Grade immediately against the known result (separate from the pick read).
      const realGameId = opp.gameId.split("|").pop() ?? "";
      const game = byId.get(realGameId);
      if (game) {
        const result = gradeNflMoneyline(opp.fair.selection, game);
        if (result) {
          const dec = americanToDecimal(bet.priceAmerican);
          bet.pnlUsd =
            result === "won"
              ? +(bet.stakeUsd * (dec - 1)).toFixed(2)
              : result === "lost"
                ? +(-bet.stakeUsd).toFixed(2)
                : 0;
          bet.status = result;
          bet.finalScore = `${game.awayTeam} ${game.awayScore} @ ${game.homeTeam} ${game.homeScore}`;
          bet.settledAt = bet.commenceTime;
          // CLV: entry == the closing line itself (we have no earlier price in
          // the historical feed), so beatClose is ~false and clvCents reflects
          // the gap between the RAW price we took and the DE-VIGGED fair close
          // (i.e. the vig we paid). Reported honestly; the dry-run's value is the
          // edge distribution, not CLV.
          const entryImplied = americanToImpliedProb(bet.priceAmerican);
          bet.clvCents = Number.isFinite(bet.closeFairAmerican)
            ? +(bet.priceAmerican - bet.closeFairAmerican).toFixed(1)
            : null;
          bet.beatClose = Number.isFinite(entryImplied)
            ? entryImplied < bet.closeDevigMarketProb
            : null;
        }
      }
      book.bets.push(bet);
    }

    // Snapshot equity after each week so the curve + drawdown track sequentially.
    stats = writeSnapshot(book, opp0Iso(opps), cfg);
  }

  const finalStats = computeStats(book, cfg);
  const nowIso = new Date().toISOString();
  saveBook(outDir, "NFL", book, nowIso);

  return {
    weeksProcessed,
    betsRecorded: book.bets.length,
    oppsScanned,
    playable,
    railSkips,
    stats: finalStats,
  };
}

/** Read-only report of the persisted NFL dry-run book (no recompute). */
export function reportNflDryRun(outDir: string = nflBookDir()): QuantStats {
  return computeStats(loadBook(outDir, "NFL"), QUANT_DESK_CONFIG);
}

function opp0Iso(opps: { commenceTime: string }[]): string {
  return opps[0]?.commenceTime || new Date().toISOString();
}
