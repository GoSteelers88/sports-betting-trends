// quant-desk/adapters/mlb.ts — the MLB fair-value bus + market lines.
//
// Two FairValue sources, both from EXISTING, tuned models:
//   • game moneyline — OUR mlb-model win-probability (xERA→log5→Pythagorean,
//     shrunk toward market). Read from mlb-model-output.json.
//   • per-stat props — OUR mlb-prop-distributions milestone ladders
//     (P(stat ≥ k)) from the player gamelog feed.
//
// Market lines come from the SAME sharp/soft feeds the rest of the desk uses:
//   • moneyline   — de-vigged Pinnacle via buildFairValueBoard (fair-value.ts)
//   • props       — de-vigged Pinnacle prop via the sharp-props feed + best soft
//                   price, joined by props-board's samePlayer + exact line.
//
// Pure given loaded inputs (the runner does the fs reads), so the join logic is
// testable without touching disk.

import { teamMatches, type FairValueBoard } from "../../fair-value";
import {
  MLB_STAT_SPECS,
  distributionFor,
  findPlayer,
  type MlbGameLogFile,
} from "../../mlb-prop-distributions";
import { samePlayer } from "../../props-board";
import { americanToImpliedProb, noVigFairProbTwoWay } from "../../devig";
import type { FairValue, MarketLine, Opportunity } from "../types";
import { scan } from "../engine";

// ── model moneyline output (mlb-model-output.json) ──────────────────────────
export interface MlbModelResultLite {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  homeWinProb: number;
  awayWinProb: number;
}
export interface MlbModelFile {
  generatedAt?: string;
  results?: MlbModelResultLite[];
}

// ── sharp prop feed (latest-sharp-props-mlb.json) ───────────────────────────
export interface SharpPropRow {
  player: string;
  units: string; // Pinnacle units: TotalBases, HomeRuns, Strikeouts, EarnedRuns
  line: number;
  overAmerican: number;
  underAmerican: number;
  fairOverProb: number;
}
export interface SharpPropsFile {
  fetchedAt?: string;
  props?: SharpPropRow[];
}

// ── soft prop feed (latest-soft-props-mlb.json) ─────────────────────────────
export interface SoftPropRow {
  player: string;
  market: string; // Odds API key
  line: number;
  side: "Over" | "Under";
  american: number;
  book: string;
  commence?: string;
}
export interface SoftPropsFile {
  fetchedAt?: string;
  quotes?: SoftPropRow[];
}

// Pinnacle `units` ↔ our stat key (for overlaying the sharp fair prob on a rung).
const UNITS_TO_STAT: Record<string, string> = {
  HomeRuns: "batter_home_runs",
  TotalBases: "batter_total_bases",
  Strikeouts: "pitcher_strikeouts",
  EarnedRuns: "pitcher_earned_runs",
};

// Odds API soft market key ↔ our stat key (for the soft price we'd take).
const SOFT_MARKET_TO_STAT: Record<string, string> = {
  pitcher_strikeouts: "pitcher_strikeouts",
  batter_home_runs: "batter_home_runs",
  batter_total_bases: "batter_total_bases",
  pitcher_earned_runs: "pitcher_earned_runs",
  batter_hits: "batter_hits",
  batter_rbis: "batter_rbis",
  batter_runs_scored: "batter_runs_scored",
};

/** A milestone line `k − 0.5` ⇒ rung "≥ k". (mirrors mlb-prop-plays.) */
function lineToThreshold(line: number): number | null {
  const k = line + 0.5;
  if (Math.abs(k - Math.round(k)) > 1e-9) return null;
  const ki = Math.round(k);
  return ki >= 1 ? ki : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Moneyline opportunities — model fair vs de-vigged Pinnacle, best soft price.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build moneyline Opportunities for the MLB slate. For each matched game we get
 * OUR model win prob (FairValue) and the de-vigged Pinnacle fair + best soft
 * price (MarketLine), one per side. Direction agreement is decided by the SHARP
 * side (sharpFavorsThis = the side's de-vigged prob > 0.5).
 */
export function buildMlbMoneylineOpps(
  model: MlbModelFile,
  board: FairValueBoard,
): Opportunity[] {
  const results = model.results ?? [];
  const opps: Opportunity[] = [];

  for (const g of board.games) {
    // Match the model row to this board game with the SAME token-aware matcher
    // the rest of the app uses (handles "Detroit Tigers" vs "Tigers" etc.).
    const modelRow = results.find(
      (r) =>
        teamMatches(r.homeTeam, g.home_team) &&
        teamMatches(r.awayTeam, g.away_team),
    );
    if (!modelRow) continue;

    const gameId = `ml|${g.commence_time.slice(0, 10)}|${pairKey(g.home_team, g.away_team)}`;
    const fairs: FairValue[] = [];
    const lines: MarketLine[] = [];

    for (const side of g.sides) {
      const modelProb = side.side === "home" ? modelRow.homeWinProb : modelRow.awayWinProb;
      if (!Number.isFinite(modelProb)) continue;
      if (!side.bestSoft) continue; // no price to actually take

      const key = `moneyline|${side.side}`;
      fairs.push({
        key,
        market: "moneyline",
        selection: `${side.team} ML`,
        modelFairProb: modelProb,
        estimate: false,
        basis: "mlb-model (xERA→log5→Pythagorean, market-shrunk)",
      });
      lines.push({
        key,
        devigMarketProb: side.fairProb,
        priceAmerican: side.bestSoft.american,
        book: side.bestSoft.book,
        sharpFavorsThis: side.fairProb > 0.5,
      });
    }

    if (fairs.length === 0) continue;
    opps.push(
      ...scan(
        "MLB",
        { gameId, matchup: g.matchup, commenceTime: g.commence_time },
        fairs,
        lines,
      ),
    );
  }
  return opps;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prop opportunities — model P(stat≥k) vs de-vigged Pinnacle prop, best soft.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build per-stat prop Opportunities. For every sharp prop line that maps to a
 * model rung AND has a soft OVER price, we compare OUR model P(≥k) (FairValue)
 * to the de-vigged sharp prop fair (MarketLine) and take the soft OVER price.
 * Only the OVER (milestone "k+") side is modeled — that's the rung the
 * distribution gives us honestly.
 */
export function buildMlbPropOpps(
  gamelog: MlbGameLogFile | null,
  sharp: SharpPropRow[],
  soft: SoftPropRow[],
  isSlateTeam: (team: string | null) => boolean,
): Opportunity[] {
  if (!gamelog || !gamelog.players) return [];
  const leagueAverages = gamelog.leagueAverages ?? {};
  const opps: Opportunity[] = [];

  // Index soft OVER prices by (statKey, threshold, normPlayer).
  const softBest = new Map<string, { american: number; book: string; commence: string }>();
  for (const q of soft) {
    if (q.side !== "Over") continue;
    const stat = SOFT_MARKET_TO_STAT[q.market];
    if (!stat) continue;
    const k = lineToThreshold(q.line);
    if (k === null) continue;
    if (!Number.isFinite(q.american)) continue;
    const key = `${stat}|${k}|${normName(q.player)}`;
    const prev = softBest.get(key);
    if (!prev || q.american > prev.american) {
      softBest.set(key, { american: q.american, book: q.book, commence: q.commence ?? "" });
    }
  }

  for (const sp of sharp) {
    const stat = UNITS_TO_STAT[sp.units];
    if (!stat) continue;
    const k = lineToThreshold(sp.line);
    if (k === null) continue;
    if (!Number.isFinite(sp.fairOverProb)) continue;

    const player = findPlayer(gamelog, sp.player);
    if (!player) continue;
    if (!isSlateTeam(player.team)) continue;

    const spec = MLB_STAT_SPECS.find((s) => s.stat === stat);
    if (!spec) continue;
    const dist = distributionFor(player, spec, leagueAverages);
    if (!dist) continue;
    const rung = dist.ladder.find((r) => r.threshold === k);
    if (!rung) continue;

    // Need a soft OVER price to actually take.
    const softKey = `${stat}|${k}|${normName(player.displayName)}`;
    const soFt = softBest.get(softKey);
    if (!soFt) continue;

    // Sanity: the sharp prop must reference the same player (it already does by
    // construction, but the gamelog name is authoritative).
    if (!samePlayer(sp.player, player.displayName)) continue;

    const commenceTime = soFt.commence || "";
    const gameId = `prop|${commenceTime.slice(0, 10) || "na"}|${normName(player.displayName)}|${stat}|${k}`;
    const fairKey = `prop:${spec.label}>=${k}`;

    const fairs: FairValue[] = [
      {
        key: fairKey,
        market: `prop:${spec.label}`,
        selection: `${player.displayName} ${spec.label} ${k}+`,
        modelFairProb: rung.prob,
        estimate: dist.derived || dist.lowConfidence, // synthesized/thin = estimate
        basis: `mlb-prop-distributions (${dist.method}, n=${dist.nGames}${dist.derived ? ", synthesized" : ""})`,
      },
    ];
    const lines: MarketLine[] = [
      {
        key: fairKey,
        devigMarketProb: sp.fairOverProb,
        priceAmerican: soFt.american,
        book: soFt.book,
        sharpFavorsThis: sp.fairOverProb > 0.5,
      },
    ];

    opps.push(
      ...scan(
        "MLB",
        { gameId, matchup: `${player.displayName} (${player.team ?? "?"})`, commenceTime },
        fairs,
        lines,
      ),
    );
  }
  return opps;
}

// ─────────────────────────────────────────────────────────────────────────────
// Settlement helpers — moneyline settles vs ESPN finals (handled in the runner
// via espn-finals); props settle vs the player gamelog once the game has the
// stat. To keep V1 honest and deterministic without a per-game box-score feed,
// the runner settles ONLY moneyline bets (game outcome) and leaves prop bets
// open until a future box-score settler — props are logged + CLV-tracked now.
// ─────────────────────────────────────────────────────────────────────────────

/** Re-price moneyline closes for refresh: bet.id → latest de-vigged sharp fair.
 *  Props closes are refreshed from the sharp-prop feed the same way. */
export function buildMoneylineCloseMap(board: FairValueBoard): Map<string, number> {
  const m = new Map<string, number>();
  for (const g of board.games) {
    const gameId = `ml|${g.commence_time.slice(0, 10)}|${pairKey(g.home_team, g.away_team)}`;
    for (const side of g.sides) {
      m.set(`MLB|${gameId}|moneyline|${side.side}`, side.fairProb);
    }
  }
  return m;
}

// ── name/team normalization (local, matches the rest of the app) ────────────

function normName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normTeam(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[.'-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pairKey(home: string, away: string): string {
  return [normTeam(home), normTeam(away)]
    .map((t) => t.replace(/[^a-z]/g, ""))
    .sort()
    .join("");
}

// Re-export for the runner / tests so they can use the exact implied-prob math.
export { americanToImpliedProb, noVigFairProbTwoWay };
