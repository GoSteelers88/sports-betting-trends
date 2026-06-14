// quant-desk/adapters/nfl.ts — the NFL DRY-RUN fair-value bus (PRIVATE).
//
// NFL has no tuned model in this repo, so the fair value here is a TRANSPARENT
// Elo power rating built ONLY from games strictly before each week (leak-safe,
// using the loop's standingsBefore discipline). Every FairValue is flagged
// `estimate: true` and labelled "dry-run" so it can never be mistaken for a
// tuned model number.
//
// Market lines are the nflverse games.csv lines (spread/total/moneyline), which
// are ~CLOSING — so the measured edge is vs the close and CLV is, by definition,
// ~0 at entry (entry == close). We still run the full engine to PROVE the desk's
// machinery on real historical games and to measure model-vs-market edge
// distribution. This is QUIET: no dashboard, no nav, no user-facing strings.

import {
  type GameRow,
  type Cursor,
  fullSchedule,
  gamesForCursor,
} from "../../nfl-loop";
import {
  americanToImpliedProb,
  noVigFairProbTwoWay,
  probToAmerican,
} from "../../devig";
import type { FairValue, MarketLine, Opportunity } from "../types";
import { scan } from "../engine";

// ─────────────────────────────────────────────────────────────────────────────
// Elo power rating — built incrementally, leak-safe (only past games).
// ─────────────────────────────────────────────────────────────────────────────

const ELO_BASE = 1500;
const ELO_K = 20;
const ELO_HFA = 55;        // home-field advantage in Elo points (~2.5 pts ≈ NFL)
const ELO_REVERT = 0.33;   // mean-revert a third of the way to base each new season

/** Win prob for `a` vs `b` from Elo with a home-field bump applied to the home
 *  side. Standard logistic. */
function eloWinProb(eloA: number, eloB: number): number {
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
}

/** Incremental Elo ledger over games in chronological order. Exposed so the
 *  dry-run can ask "what did Elo say BEFORE this game?" with no leakage. */
export class EloLedger {
  private rating = new Map<string, number>();
  private lastSeason = new Map<string, number>();

  private get(team: string, season: number): number {
    let r = this.rating.get(team);
    const ls = this.lastSeason.get(team);
    if (r == null) {
      r = ELO_BASE;
    } else if (ls != null && season > ls) {
      // New season → revert toward the mean.
      r = ELO_BASE + (r - ELO_BASE) * (1 - ELO_REVERT);
    }
    this.rating.set(team, r);
    this.lastSeason.set(team, season);
    return r;
  }

  /** Pre-game home win prob (with HFA). Does NOT mutate ratings — leak-safe. */
  homeWinProb(home: string, away: string, season: number): number {
    const h = this.get(home, season) + ELO_HFA;
    const a = this.get(away, season);
    return eloWinProb(h, a);
  }

  /** Feed a FINISHED game to update ratings. Call AFTER reading the pre-game
   *  prob for that game, so the rating used to bet never saw the result. */
  update(game: GameRow): void {
    if (game.homeScore == null || game.awayScore == null) return;
    const season = game.season;
    const home = this.get(game.homeTeam, season) + ELO_HFA;
    const away = this.get(game.awayTeam, season);
    const expHome = eloWinProb(home, away);
    const homeWon = game.homeScore > game.awayScore ? 1 : game.homeScore < game.awayScore ? 0 : 0.5;
    const delta = ELO_K * (homeWon - expHome);
    this.rating.set(game.homeTeam, (this.rating.get(game.homeTeam) ?? ELO_BASE) + delta);
    this.rating.set(game.awayTeam, (this.rating.get(game.awayTeam) ?? ELO_BASE) - delta);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dry-run opportunity builder — one moneyline market per game.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build NFL moneyline Opportunities for ONE cursor week, using an Elo ledger
 * primed on every game strictly before this week. The market line is the
 * nflverse closing moneyline, de-vigged two-way; the fair value is the Elo
 * dry-run prob. Returns one Opportunity per side that has a usable line.
 *
 * `elo` is supplied already primed (the runner walks the schedule and primes it
 * week by week), so this function is pure and leak-safe by contract.
 */
export function buildNflWeekOpps(
  games: GameRow[],
  cursor: Cursor,
  elo: EloLedger,
): Opportunity[] {
  const slate = gamesForCursor(games, cursor);
  const opps: Opportunity[] = [];

  for (const g of slate) {
    if (g.homeMoneyline == null || g.awayMoneyline == null) continue;
    const devig = noVigFairProbTwoWay(g.homeMoneyline, g.awayMoneyline);
    if (!devig) continue;

    const homeFair = elo.homeWinProb(g.homeTeam, g.awayTeam, g.season);
    const gameId = `nflml|${g.season}|${g.gameType}|${g.week}|${g.gameId}`;
    const commenceTime = isoKickoff(g);

    const fairs: FairValue[] = [
      {
        key: "moneyline|home",
        market: "moneyline",
        selection: `${g.homeTeam} ML`,
        modelFairProb: homeFair,
        estimate: true,
        basis: "DRY-RUN Elo power rating (leak-safe, pre-game only) — NOT a tuned model",
      },
      {
        key: "moneyline|away",
        market: "moneyline",
        selection: `${g.awayTeam} ML`,
        modelFairProb: 1 - homeFair,
        estimate: true,
        basis: "DRY-RUN Elo power rating (leak-safe, pre-game only) — NOT a tuned model",
      },
    ];
    const lines: MarketLine[] = [
      {
        key: "moneyline|home",
        devigMarketProb: devig.fairA,
        priceAmerican: g.homeMoneyline,
        book: "nflverse-close",
        sharpFavorsThis: devig.fairA > 0.5,
      },
      {
        key: "moneyline|away",
        devigMarketProb: devig.fairB,
        priceAmerican: g.awayMoneyline,
        book: "nflverse-close",
        sharpFavorsThis: devig.fairB > 0.5,
      },
    ];

    opps.push(
      ...scan(
        "NFL",
        { gameId, matchup: `${g.awayTeam} @ ${g.homeTeam}`, commenceTime },
        fairs,
        lines,
      ),
    );
  }
  return opps;
}

/** Grade an NFL moneyline opportunity against the (known) game result. Used by
 *  the dry-run runner — the result is read from the SAME GameRow but only AFTER
 *  the pick is recorded, mirroring the loop's strict pick→grade separation. */
export function gradeNflMoneyline(
  selection: string,
  game: GameRow,
): "won" | "lost" | "void" | null {
  if (game.homeScore == null || game.awayScore == null) return null;
  const pickedHome = selection.startsWith(game.homeTeam);
  const pickedAway = selection.startsWith(game.awayTeam);
  if (!pickedHome && !pickedAway) return null;
  if (game.homeScore === game.awayScore) return "void";
  const homeWon = game.homeScore > game.awayScore;
  if (pickedHome) return homeWon ? "won" : "lost";
  return homeWon ? "lost" : "won";
}

/** Walk the full schedule and return, in chronological order, every week's
 *  cursor with the Elo ledger primed up to (but not including) that week. The
 *  ledger is shared + mutated as we advance — but each week's opps are read
 *  BEFORE we feed that week's results in, so no leakage. */
export function* walkSchedulePrimed(
  games: GameRow[],
): Generator<{ cursor: Cursor; elo: EloLedger }, void, void> {
  const schedule = fullSchedule(games);
  const elo = new EloLedger();
  for (const slot of schedule) {
    const cursor: Cursor = { season: slot.season, phase: slot.phase, week: slot.week };
    yield { cursor, elo };
    // After yielding (caller reads pre-game opps), feed this week's results in.
    for (const g of gamesForCursor(games, cursor)) elo.update(g);
  }
}

function isoKickoff(g: GameRow): string {
  // gameday is YYYY-MM-DD; gametime HH:MM (may be empty). Treat as ET-ish UTC
  // for ordering only — the dry-run never uses wall-clock "now" gating.
  const time = g.gametime && /^\d{1,2}:\d{2}$/.test(g.gametime) ? g.gametime : "13:00";
  return `${g.gameday}T${time.padStart(5, "0")}:00Z`;
}

export { americanToImpliedProb, probToAmerican };
