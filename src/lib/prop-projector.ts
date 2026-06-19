// Deterministic prop projection engine. Given a player + prop type +
// opponent + line + side, returns a projected stat value, an empirical
// standard deviation, and the probability the actual outcome lands over
// the line.
//
// This is the load-bearing "modelProb source" for prop picks the analyst
// ships through AgentPick — Claude must NEVER invent a prop modelProb
// from reasoning alone (industry consensus: LLMs do not do prop math well).
//
// Data source: data/processed/player-gamelogs-{nba,mlb}.json, produced
// nightly by scripts/ingest-player-gamelogs.ts. Each player entry carries
// a list of recent games with the team they played, the opponent, and
// the per-prop-type stat value (PTS, REB, AST, batter_runs_scored, ...).
//
// ─────────────────────────────────────────────────────────────────────────────
// HARDENING (2026-06) — what changed and WHY it's honest:
//
//   1. RECENT-FORM WEIGHTING. Games are exponentially weighted (most recent
//      heaviest) instead of a flat mean, so a hot/cold streak moves the number.
//
//   2. SAMPLE-SIZE SHRINKAGE toward a league prior. With only 5 games the
//      empirical mean is noisy; we blend it toward the league average for the
//      market using a James-Stein / empirical-Bayes weight n/(n+k). Thin
//      samples can't produce an overconfident projection any more.
//
//   3. COUNT-AWARE TAILS. Low-mean integer markets (home runs, stolen bases)
//      are NOT well approximated by a normal — P(≥1 HR) from a Gaussian is
//      garbage. For these we use a Poisson tail on the projected mean and take
//      the MORE CONSERVATIVE (closer-to-0.5) of Poisson vs normal, so we never
//      print an overconfident rare-event probability.
//
//   4. DERIVED TOTAL BASES. ESPN MLB box scores expose H and HR but NOT 2B/3B,
//      so Total Bases cannot be MEASURED per game from the only feed we have.
//      We SYNTHESIZE it: TB ≈ HR·4 + (H − HR)·k, where k is the league-average
//      bases-per-non-HR-hit (~1.27). This is an honest ESTIMATE, flagged in the
//      output notes + `derived` field — it is NOT a measured distribution.
//      (When the ingester is later extended to capture real TB, `synthesize`
//      will see the real key and prefer it automatically.)
//
//   5. MARKET-IMPLIED FALLBACK. When we truly can't project (player missing,
//      < MIN_GAMES, unsupported market), the caller can fall back to the sharp
//      book's de-vigged fair prob — see props-plays.ts. The projector itself
//      returns null in that case and is explicit that the caller must label it.

import fs from "node:fs";
import path from "node:path";
import { normalizeName, normalCdf, type PropGradingLeague } from "./prop-grading";

type PerGameStats = { date: string; opponent: string | null; stats: Record<string, number> };
type PlayerEntry = { displayName: string; team: string | null; games: PerGameStats[] };
type TeamAllowed = { games: number; allowed: Record<string, { mean: number; n: number }> };
type GameLogFile = {
  generatedAt: string;
  league: PropGradingLeague;
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  players: Record<string, PlayerEntry>;
  teamsAllowed: Record<string, TeamAllowed>;
  leagueAverages: Record<string, number>;
};

const PROCESSED = path.resolve(process.cwd(), "data", "processed");

// Minimum games before we trust a player's distribution at all. Below this
// the projector returns null and the caller must either skip or fall back to
// the market-implied prob (clearly labeled). We won't ship a modelProb off
// 1-4 games.
const MIN_GAMES = 5;

// Markets that are LOW-MEAN INTEGER COUNTS where the normal approximation
// mis-prices the tail (especially "≥ 0.5" lines = P(at least one)). For these
// we cross-check with a Poisson tail and take the more conservative side.
// Home runs and stolen bases are the canonical cases; batter_strikeouts is
// borderline but its mean is usually > 0.5 so the normal is acceptable there.
const POISSON_TAIL_MARKETS = new Set<string>([
  "batter_home_runs",
  "batter_stolen_bases",
]);

// Floor on standard deviation. Prevents a 100% modelProb when a player has
// been freakishly consistent in a small sample. Calibrated per league/market.
const STDDEV_FLOOR: Record<PropGradingLeague, Record<string, number>> = {
  NBA: {
    player_points: 4.0,
    player_rebounds: 1.8,
    player_assists: 1.5,
    player_threes: 0.9,
    player_blocks: 0.8,
    player_steals: 0.7,
    player_turnovers: 0.8,
    player_points_rebounds_assists: 4.5,
    player_points_rebounds: 4.0,
    player_points_assists: 3.5,
    player_rebounds_assists: 2.2,
    player_blocks_steals: 1.0,
  },
  MLB: {
    batter_hits: 0.9,
    batter_home_runs: 0.6,
    batter_rbis: 0.95,
    batter_runs_scored: 0.85,
    batter_total_bases: 1.1,
    batter_stolen_bases: 0.5,
    batter_strikeouts: 0.95,
    pitcher_strikeouts: 1.8,
    pitcher_earned_runs: 1.3,
  },
  // WNBA shares the basketball box-score schema — same per-stat dispersion
  // floors as the NBA until a WNBA-specific game-log history is ingested.
  WNBA: {
    player_points: 4.0,
    player_rebounds: 1.8,
    player_assists: 1.5,
    player_threes: 0.9,
    player_blocks: 0.8,
    player_steals: 0.7,
    player_turnovers: 0.8,
    player_points_rebounds_assists: 4.5,
    player_points_rebounds: 4.0,
    player_points_assists: 3.5,
    player_rebounds_assists: 2.2,
    player_blocks_steals: 1.0,
  },
};

// Shrinkage constant k (in "effective games"). The player mean gets weight
// n/(n+k); the league prior gets k/(n+k). Larger k = trust the prior more.
// Tuned per league: baseball single-game counts are noisier than NBA box
// totals, so MLB shrinks harder. At n=5 with k=6, the prior still carries
// 55% of the weight — exactly the caution thin samples demand. WNBA mirrors
// the NBA until its own game-log history exists.
const SHRINK_K: Record<PropGradingLeague, number> = { NBA: 4, MLB: 6, WNBA: 4 };

// League-average bases per NON-HR hit, used to SYNTHESIZE total bases from
// (H, HR) when the box-score feed lacks 2B/3B. Of non-HR hits, roughly 76%
// singles / 20% doubles / 4% triples → ~1.28 bases each. Conservative-ish;
// see the derivation note in the file header.
const BASES_PER_NON_HR_HIT = 1.28;

// Cap how far opponent allowance can swing a projection. If the opponent gives
// up 2× league average in a stat, that's almost certainly small-sample noise
// unless we have many games. Capping at ±25% prevents the projector from
// ballooning on a thin opponent sample.
const ALLOWANCE_CAP = 0.25;

// Recent-form half-life in games: a game `h` slots back gets half the weight.
// 5 games half-life = the last ~10 games still meaningfully contribute while
// the most recent carries the most weight.
const FORM_HALF_LIFE = 5;

let CACHE: Partial<Record<PropGradingLeague, { mtime: number; data: GameLogFile }>> = {};

function loadGameLog(league: PropGradingLeague): GameLogFile | null {
  const filename = `player-gamelogs-${league.toLowerCase()}.json`;
  const filepath = path.join(PROCESSED, filename);
  try {
    const stat = fs.statSync(filepath);
    const cached = CACHE[league];
    if (cached && cached.mtime === stat.mtimeMs) return cached.data;
    const raw = fs.readFileSync(filepath, "utf8");
    const data = JSON.parse(raw) as GameLogFile;
    CACHE[league] = { mtime: stat.mtimeMs, data };
    return data;
  } catch {
    return null;
  }
}

// Pull the per-game series of a market's value for one player. Returns null
// when fewer than MIN_GAMES usable values exist. For batter_total_bases this
// SYNTHESIZES the series from hits + home runs when the real TB key is absent
// (the common case with the ESPN feed) — see header note 4.
function seriesFor(
  games: PerGameStats[],
  propType: string,
): { values: number[]; derived: boolean } | null {
  // Real, measured values first — always preferred when present.
  const direct = games
    .map(g => g.stats[propType])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (direct.length >= MIN_GAMES) return { values: direct, derived: false };

  // Synthesized Total Bases from (H, HR). Only when the real key is missing.
  if (propType === "batter_total_bases" && direct.length < MIN_GAMES) {
    const synth: number[] = [];
    for (const g of games) {
      const h = g.stats["batter_hits"];
      const hr = g.stats["batter_home_runs"];
      if (typeof h === "number" && Number.isFinite(h)) {
        const homers = typeof hr === "number" && Number.isFinite(hr) ? hr : 0;
        const nonHrHits = Math.max(0, h - homers);
        // TB = HR*4 + (non-HR hits)*avg-bases-per-non-HR-hit. Rounded to a
        // plausible integer-ish estimate but kept as a real number so the
        // variance reflects the continuous estimate.
        synth.push(homers * 4 + nonHrHits * BASES_PER_NON_HR_HIT);
      }
    }
    if (synth.length >= MIN_GAMES) return { values: synth, derived: true };
  }

  return null;
}

// Exponentially-weighted mean + (weighted) sample variance. The series is
// oldest→newest; the NEWEST game gets the most weight. Returns the weighted
// mean, the weighted unbiased-ish stddev, and the effective sample size.
function weightedMoments(values: number[]): { mean: number; std: number; nEff: number } {
  const n = values.length;
  // weight for the i-th element (0 = oldest). Newest (i=n-1) → weight 1.
  const decay = Math.pow(0.5, 1 / FORM_HALF_LIFE);
  const weights = values.map((_, i) => Math.pow(decay, n - 1 - i));
  const wSum = weights.reduce((a, b) => a + b, 0);
  const mean = values.reduce((a, v, i) => a + v * weights[i], 0) / wSum;
  // Reliability-weighted variance with Bessel-style correction via effective n.
  const wSqSum = weights.reduce((a, w) => a + w * w, 0);
  const nEff = (wSum * wSum) / wSqSum; // Kish effective sample size
  const num = values.reduce((a, v, i) => a + weights[i] * (v - mean) ** 2, 0);
  const variance = nEff > 1 ? (num / wSum) * (nEff / (nEff - 1)) : num / wSum;
  return { mean, std: Math.sqrt(Math.max(0, variance)), nEff };
}

// Poisson upper-tail P(X >= k) for integer k, mean λ. Used for low-mean count
// markets where the normal CDF mis-prices the tail.
function poissonSf(k: number, lambda: number): number {
  if (lambda <= 0) return k <= 0 ? 1 : 0;
  const kk = Math.max(0, Math.ceil(k));
  // P(X >= kk) = 1 - sum_{j=0}^{kk-1} e^-λ λ^j / j!
  let term = Math.exp(-lambda);
  let cdf = term; // j = 0
  for (let j = 1; j < kk; j++) {
    term *= lambda / j;
    cdf += term;
  }
  return Math.min(1, Math.max(0, 1 - cdf));
}

export type ProjectionInput = {
  league: PropGradingLeague;
  player: string;
  propType: string;
  line: number;
  side: "over" | "under";
  opponent?: string | null;
};

export type ProjectionOutput = {
  projected: number;       // shrunk, form-weighted, opponent-adjusted mean
  stddev: number;          // distribution stddev, floored
  modelProb: number;       // P(stat ≥ line) for over, P(stat ≤ line) for under
  edge: number | null;     // filled by the caller when a marketProb is supplied
  nGames: number;          // raw games behind the projection
  rollingMean: number;     // form-weighted player mean BEFORE shrinkage/opp
  shrunkMean: number;      // mean after shrinkage toward the league prior
  shrinkWeight: number;    // weight given to the player's own mean (0..1)
  opponentFactor: number;  // multiplier applied (1.0 = neutral)
  recentForm: number[];    // last up-to-5 stat values (raw, newest last)
  derived: boolean;        // true when the series was SYNTHESIZED (e.g. TB)
  method: "normal" | "poisson-floor"; // tail model actually used
  windowAge: number;       // age of game log in hours
  notes: string[];
};

export function project(input: ProjectionInput): ProjectionOutput | null {
  const log = loadGameLog(input.league);
  if (!log) return null;

  const key = normalizeName(input.player);
  const player = log.players[key];
  if (!player || player.games.length < MIN_GAMES) return null;

  // Games come newest-first in the file; reverse to oldest→newest so the
  // recent-form weighting (newest heaviest) is well-defined.
  const ordered = [...player.games].reverse();
  const series = seriesFor(ordered, input.propType);
  if (!series) return null;

  const { values, derived } = series;
  const notes: string[] = [];
  if (derived) {
    notes.push(
      `total bases SYNTHESIZED from hits+HR (feed has no 2B/3B) — estimate, not a measured distribution`,
    );
  }

  // 1) Form-weighted moments.
  const { mean: rollingMean, std: empiricalStd, nEff } = weightedMoments(values);

  // 2) Shrinkage toward the league prior. Without a league average for this
  //    market we can't shrink — fall back to the raw form mean and note it.
  const leagueAvg = log.leagueAverages[input.propType];
  // For synthesized TB there is no leagueAverages entry; synthesize the prior
  // the same way from the hits/HR league averages so shrinkage still applies.
  const priorMean =
    typeof leagueAvg === "number" && leagueAvg > 0
      ? leagueAvg
      : derived
        ? (log.leagueAverages["batter_home_runs"] ?? 0) * 4 +
          Math.max(
            0,
            (log.leagueAverages["batter_hits"] ?? 0) - (log.leagueAverages["batter_home_runs"] ?? 0),
          ) * BASES_PER_NON_HR_HIT
        : null;

  const k = SHRINK_K[input.league];
  let shrinkWeight = 1;
  let shrunkMean = rollingMean;
  if (priorMean !== null && priorMean >= 0) {
    shrinkWeight = nEff / (nEff + k);
    shrunkMean = shrinkWeight * rollingMean + (1 - shrinkWeight) * priorMean;
    if (shrinkWeight < 0.6) {
      notes.push(
        `thin sample (n≈${nEff.toFixed(1)}) — shrunk ${((1 - shrinkWeight) * 100).toFixed(0)}% toward league prior ${priorMean.toFixed(2)}`,
      );
    }
  } else {
    notes.push(`no league prior for ${input.propType} — no shrinkage applied`);
  }

  // 3) Opponent allowance adjustment, capped to ±25% and gated on a usable
  //    opponent sample. For synthesized TB we have no opponent TB allowance,
  //    so this naturally no-ops (and the note explains why).
  let factor = 1;
  if (input.opponent && priorMean && priorMean > 0) {
    const allowed = log.teamsAllowed[input.opponent]?.allowed[input.propType];
    if (allowed && allowed.n >= MIN_GAMES) {
      const raw = allowed.mean / priorMean;
      factor = Math.max(1 - ALLOWANCE_CAP, Math.min(1 + ALLOWANCE_CAP, raw));
      if (Math.abs(raw - factor) > 0.001) {
        notes.push(`opponent allowance capped (raw ${raw.toFixed(2)}×, clamped to ${factor.toFixed(2)}×)`);
      } else {
        notes.push(`opponent allows ${(factor * 100).toFixed(0)}% of league avg for ${input.propType}`);
      }
    } else {
      notes.push(`no usable opponent-allowance sample for ${input.opponent}`);
    }
  }

  const projected = Math.max(0, shrunkMean * factor);

  // 4) Variance / tail model.
  //    Floor the stddev so a freakishly consistent small sample can't pin
  //    modelProb at 0/1. For shrunk count means we also floor variance at the
  //    Poisson variance (= mean), because a count process can't be tighter
  //    than Poisson — this widens overconfident thin-sample distributions.
  const floor = STDDEV_FLOOR[input.league]?.[input.propType] ?? 1.0;
  const poissonStd = Math.sqrt(Math.max(projected, 1e-6));
  const isCountTail = POISSON_TAIL_MARKETS.has(input.propType);
  const stddev = Math.max(empiricalStd, floor, isCountTail ? poissonStd : 0);

  // Normal-CDF probability of going UNDER the line; over = 1 - that.
  const probUnderNormal = normalCdf(input.line, projected, stddev);
  let modelProbOver = 1 - probUnderNormal;
  let method: ProjectionOutput["method"] = "normal";

  if (isCountTail) {
    // Poisson tail on the projected mean. For a ".5" line, over means
    // X >= ceil(line) = (line rounded up). Take the prob CLOSER to 0.5
    // (more conservative) between normal and Poisson so we never print the
    // overconfident tail.
    const overThreshold = Math.floor(input.line) + 1; // X >= this ⇒ over a .5 line
    const poissonOver = poissonSf(overThreshold, projected);
    const normalDist = Math.abs(modelProbOver - 0.5);
    const poissonDist = Math.abs(poissonOver - 0.5);
    if (poissonDist < normalDist) {
      modelProbOver = poissonOver;
      method = "poisson-floor";
      notes.push(`low-mean count market — Poisson tail (λ=${projected.toFixed(2)}) used over normal (more conservative)`);
    }
  }

  // Clamp away from the absolute edges so downstream EV/Kelly math is finite.
  modelProbOver = Math.min(0.99, Math.max(0.01, modelProbOver));
  const modelProb = input.side === "over" ? modelProbOver : 1 - modelProbOver;

  const recentForm = values.slice(-5);
  const windowAgeHours = Math.max(0, (Date.now() - new Date(log.generatedAt).getTime()) / 36e5);

  return {
    projected: +projected.toFixed(2),
    stddev: +stddev.toFixed(2),
    modelProb: +modelProb.toFixed(4),
    edge: null,
    nGames: values.length,
    rollingMean: +rollingMean.toFixed(2),
    shrunkMean: +shrunkMean.toFixed(2),
    shrinkWeight: +shrinkWeight.toFixed(3),
    opponentFactor: +factor.toFixed(3),
    recentForm: recentForm.map(v => +v.toFixed(2)),
    derived,
    method,
    windowAge: +windowAgeHours.toFixed(1),
    notes,
  };
}

// Cache reset helper — used by tests or when callers want to force a re-read
// after a fresh ingest. No-op when no cache populated.
export function _resetProjectorCache(): void {
  CACHE = {};
}
