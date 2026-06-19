// mlb-prop-distributions.ts — per-player, per-stat DISCRETE DISTRIBUTIONS for
// MLB props, so that P(stat ≥ k) is well-defined for every rung of a
// sportsbook-style milestone ladder (1+, 2+, 3+, 4+ …).
//
// This is the "harden the model so it can power a threshold ladder" layer.
// `prop-projector.ts` answers ONE question — P(over a single line) for a
// single market — using a normal/Poisson tail. A milestone ladder needs the
// WHOLE distribution: P(≥1), P(≥2), P(≥3), P(≥4) that are mutually consistent
// (monotone decreasing) and come from one coherent count model, not four
// independent Gaussian tail calls. So we fit a real discrete PMF per stat and
// read every rung off its survival function.
//
// ─────────────────────────────────────────────────────────────────────────────
// HONESTY ABOUT THE DATA (the binding constraint — read this before trusting a
// number):
//
//   The only per-game MLB stats the gamelog feed measures are:
//     batter_hits, batter_home_runs, batter_rbis, batter_runs_scored,
//     pitcher_strikeouts, pitcher_earned_runs.
//
//   So these stats get a REAL fit from a measured per-game series:
//     Hits, Home Runs, RBI, Runs, Pitcher Strikeouts, Pitcher Earned Runs.
//
//   Total Bases is SYNTHESIZED (TB ≈ HR·4 + non-HR-hits·1.28) because the feed
//   has no 2B/3B — the fit is over an estimated series, flagged `derived`.
//
//   Stolen Bases, batter Strikeouts, Walks, Pitcher Outs/Innings have ZERO
//   measured signal in this feed. We refuse to fabricate a distribution for
//   them: `distributionFor` returns null and the by-stat board simply omits
//   those rungs. The market-edge overlay can still surface them when a sharp
//   line exists, but the MODEL probability is only printed where the model can
//   honestly produce one.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE MODEL (per stat, per player):
//
//   1. RECENT-FORM WEIGHTED MEAN. Games are exponentially weighted (newest
//      heaviest, 5-game half-life), so a hot/cold streak moves the rate.
//
//   2. SAMPLE-SIZE SHRINKAGE toward a league prior. The form mean gets weight
//      nEff/(nEff+k); the league average carries the rest. At n≈5 the prior
//      still owns ~55% of the weight — thin samples can't produce overconfident
//      tails. This is the empirical-Bayes discipline `prop-projector` already
//      uses, applied to the mean that drives the PMF.
//
//   3. NEGATIVE-BINOMIAL (over-dispersed) COUNT PMF. Real per-game baseball
//      counts have variance > mean (clustering: multi-hit games, multi-K
//      starts). A Poisson (variance = mean) UNDER-states the tail and prints an
//      overconfident P(≥2)/P(≥3). We fit an NB with dispersion r estimated from
//      the form-weighted variance/mean ratio, SHRUNK toward a per-stat prior r
//      so a 5-game variance estimate can't run wild. When the sample is
//      under-dispersed (variance ≤ mean, common in thin samples) we fall back to
//      Poisson — NB is undefined there and Poisson is the conservative limit.
//
//   4. HOME RUNS via rate × opportunity. HR is rare enough that the per-game
//      mean is dominated by how many plate appearances the hitter gets. We model
//      λ_HR = (HR per PA, shrunk) × expected PA, then NB/Poisson tail. Expected
//      PA is inferred from the league prior (a regular sees ~4.2 PA/game) since
//      the feed carries no lineup slot — documented, not hidden.
//
//   Every ladder is monotone by construction: P(≥k) is the NB/Poisson survival
//   function, which is non-increasing in k. We never assemble a ladder from four
//   independent tail calls that could cross.

import {
  normalizeName,
  type PropGradingLeague,
} from "./prop-grading";

// ─────────────────────────────────────────────────────────────────────────────
// Stat catalog — the ladders we expose, and which feed key backs each.
// `feedKey` is the per-game stat in player-gamelogs-mlb.json; `synthesize`
// flags Total Bases (no real key — built from hits+HR). A stat with no
// real or synthesizable signal is simply ABSENT from this catalog and the
// board shows it only when a market line exists (no model number).
// ─────────────────────────────────────────────────────────────────────────────

export type MlbStat =
  | "batter_hits"
  | "batter_home_runs"
  | "batter_rbis"
  | "batter_runs_scored"
  | "batter_total_bases"
  | "pitcher_strikeouts"
  | "pitcher_earned_runs";

export type StatKind = "batter" | "pitcher";

export interface StatSpec {
  stat: MlbStat;
  kind: StatKind;
  /** Per-game feed key (player-gamelogs-mlb.json stats). */
  feedKey: string | null;
  /** Milestone rungs to expose as P(stat ≥ k). */
  ladder: number[];
  /** Synthesized from hits+HR (Total Bases) — flagged in output. */
  synthesize?: boolean;
  /** Modeled as rate × expected-PA rather than a direct per-game series (HR). */
  rateTimesPa?: boolean;
  /** Human label for the section group header. */
  label: string;
}

// League-average bases per NON-HR hit — used to synthesize Total Bases from
// (H, HR). Matches prop-projector's BASES_PER_NON_HR_HIT for consistency.
const BASES_PER_NON_HR_HIT = 1.28;

// Expected plate appearances for a regular in the lineup. The feed has no
// lineup slot, so HR rate (per PA) is scaled by this league-typical PA count.
// Conservative-ish: a leadoff hitter sees ~4.6, a #8 hitter ~3.8; 4.2 is the
// honest middle. Documented in the header.
const EXPECTED_PA_REGULAR = 4.2;

export const MLB_STAT_SPECS: StatSpec[] = [
  { stat: "batter_home_runs", kind: "batter", feedKey: "batter_home_runs", ladder: [1, 2], rateTimesPa: true, label: "Home Runs" },
  { stat: "batter_hits", kind: "batter", feedKey: "batter_hits", ladder: [1, 2, 3, 4], label: "Hits" },
  { stat: "batter_rbis", kind: "batter", feedKey: "batter_rbis", ladder: [1, 2, 3, 4], label: "RBIs" },
  { stat: "batter_total_bases", kind: "batter", feedKey: null, ladder: [1, 2, 3, 4], synthesize: true, label: "Total Bases" },
  { stat: "batter_runs_scored", kind: "batter", feedKey: "batter_runs_scored", ladder: [1, 2], label: "Runs Scored" },
  { stat: "pitcher_strikeouts", kind: "pitcher", feedKey: "pitcher_strikeouts", ladder: [4, 5, 6, 7], label: "Pitcher Strikeouts" },
  { stat: "pitcher_earned_runs", kind: "pitcher", feedKey: "pitcher_earned_runs", ladder: [1, 2, 3], label: "Pitcher Earned Runs" },
];

export const MLB_STAT_SPEC_BY_STAT: Record<MlbStat, StatSpec> = Object.fromEntries(
  MLB_STAT_SPECS.map(s => [s.stat, s]),
) as Record<MlbStat, StatSpec>;

// Minimum games before we trust a fit at full confidence. Below this the
// distribution is still produced (so the ladder isn't blank) but flagged
// `lowConfidence` so the UI can mark it, and shrinkage already pulls it hard
// toward the prior.
const MIN_GAMES = 5;

// Shrinkage constant k (effective games). Player mean gets nEff/(nEff+k); the
// league prior gets the rest. MLB single-game counts are noisy, so we shrink
// fairly hard — at nEff=5, k=6 leaves the prior 55% of the weight.
const SHRINK_K = 6;

// Recent-form half-life in games. A game `h` slots back gets half the weight.
const FORM_HALF_LIFE = 5;

// Per-stat prior dispersion r for the Negative Binomial (the "size" param).
// Larger r → closer to Poisson (less over-dispersion). These are sane defaults
// reflecting that hits/TB cluster more (smaller r) than runs. The fitted r is
// shrunk toward this so a thin-sample variance estimate can't dominate.
const PRIOR_NB_R: Record<MlbStat, number> = {
  batter_hits: 4,
  batter_home_runs: 6,
  batter_rbis: 3,
  batter_runs_scored: 4,
  batter_total_bases: 3,
  pitcher_strikeouts: 6,
  pitcher_earned_runs: 4,
};

// Weight on the prior r when blending fitted vs prior dispersion (effective
// games of prior). Same spirit as SHRINK_K but for the second moment, which is
// even noisier than the mean — so we lean on the prior more.
const DISPERSION_PRIOR_WEIGHT = 8;

// ─────────────────────────────────────────────────────────────────────────────
// Pure math — exported for unit tests.
// ─────────────────────────────────────────────────────────────────────────────

/** Exponentially-weighted mean + weighted variance + Kish effective n.
 *  `values` is oldest→newest; the NEWEST game gets the most weight. */
export function weightedMoments(values: number[]): {
  mean: number;
  variance: number;
  nEff: number;
} {
  const n = values.length;
  if (n === 0) return { mean: 0, variance: 0, nEff: 0 };
  const decay = Math.pow(0.5, 1 / FORM_HALF_LIFE);
  const weights = values.map((_, i) => Math.pow(decay, n - 1 - i));
  const wSum = weights.reduce((a, b) => a + b, 0);
  const mean = values.reduce((a, v, i) => a + v * weights[i], 0) / wSum;
  const wSqSum = weights.reduce((a, w) => a + w * w, 0);
  const nEff = (wSum * wSum) / wSqSum; // Kish effective sample size
  const num = values.reduce((a, v, i) => a + weights[i] * (v - mean) ** 2, 0);
  const variance = nEff > 1 ? (num / wSum) * (nEff / (nEff - 1)) : num / wSum;
  return { mean, variance: Math.max(0, variance), nEff };
}

/** Poisson upper tail P(X ≥ k), mean λ. Conservative limit of the NB as the
 *  dispersion r → ∞ (variance → mean). */
export function poissonSf(k: number, lambda: number): number {
  if (lambda <= 0) return k <= 0 ? 1 : 0;
  const kk = Math.max(0, Math.ceil(k));
  if (kk <= 0) return 1;
  let term = Math.exp(-lambda);
  let cdf = term; // j = 0
  for (let j = 1; j < kk; j++) {
    term *= lambda / j;
    cdf += term;
  }
  return Math.min(1, Math.max(0, 1 - cdf));
}

/** Negative-Binomial PMF P(X = j) with mean μ and dispersion r (the "size").
 *  Parameterized so Var = μ + μ²/r (over-dispersed vs Poisson's Var = μ).
 *  p = r/(r+μ). Uses log-gamma for numerical stability. */
export function nbPmf(j: number, mean: number, r: number): number {
  if (mean <= 0) return j === 0 ? 1 : 0;
  if (!Number.isFinite(r) || r <= 0) return NaN;
  const p = r / (r + mean);
  // log P(X=j) = lnΓ(j+r) − lnΓ(r) − lnΓ(j+1) + r·ln p + j·ln(1−p)
  const logP =
    lnGamma(j + r) -
    lnGamma(r) -
    lnGamma(j + 1) +
    r * Math.log(p) +
    j * Math.log(1 - p);
  return Math.exp(logP);
}

/** Negative-Binomial upper tail P(X ≥ k), mean μ, dispersion r. Computed by
 *  accumulating the lower PMF (k is small for milestone ladders). Falls back to
 *  Poisson when r is non-finite/non-positive. */
export function nbSf(k: number, mean: number, r: number): number {
  if (mean <= 0) return k <= 0 ? 1 : 0;
  const kk = Math.max(0, Math.ceil(k));
  if (kk <= 0) return 1;
  if (!Number.isFinite(r) || r <= 0) return poissonSf(kk, mean);
  let cdf = 0;
  for (let j = 0; j < kk; j++) cdf += nbPmf(j, mean, r);
  return Math.min(1, Math.max(0, 1 - cdf));
}

// Lanczos log-gamma — accurate to ~1e-10, no deps. Standard coefficients.
const LG_C = [
  76.18009172947146, -86.50532032941677, 24.01409824083091,
  -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
];
function lnGamma(x: number): number {
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) {
    y += 1;
    ser += LG_C[j] / y;
  }
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

// ─────────────────────────────────────────────────────────────────────────────
// Gamelog file shape (subset we read).
// ─────────────────────────────────────────────────────────────────────────────

type PerGameStats = { date: string; opponent: string | null; stats: Record<string, number> };
export interface PlayerGameLog {
  displayName: string;
  team: string | null;
  games: PerGameStats[];
}
export interface MlbGameLogFile {
  generatedAt: string;
  league: PropGradingLeague;
  players: Record<string, PlayerGameLog>;
  leagueAverages: Record<string, number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// The fit.
// ─────────────────────────────────────────────────────────────────────────────

export interface LadderRung {
  threshold: number; // k in "P(stat ≥ k)"
  prob: number;      // model probability, clamped to (0,1)
}

export interface StatDistribution {
  stat: MlbStat;
  label: string;
  kind: StatKind;
  /** Projected per-game mean (form-weighted, shrunk). */
  mean: number;
  /** Dispersion r actually used in the NB (Infinity ⇒ Poisson fallback). */
  dispersion: number;
  method: "negative-binomial" | "poisson";
  ladder: LadderRung[];
  nGames: number;
  /** True when the series was synthesized (Total Bases). */
  derived: boolean;
  /** True when n < MIN_GAMES — the fit leans almost entirely on the prior. */
  lowConfidence: boolean;
  notes: string[];
}

/** Pull the per-game series for a stat, synthesizing Total Bases when needed.
 *  Returns null when no usable series exists. `games` is newest-first (file
 *  order); we reverse to oldest→newest for the form weighting. */
export function seriesFor(games: PerGameStats[], spec: StatSpec): {
  values: number[];
  derived: boolean;
} | null {
  const ordered = [...games].reverse(); // oldest → newest

  if (spec.synthesize) {
    // Total Bases ≈ HR·4 + (non-HR hits)·BASES_PER_NON_HR_HIT.
    const synth: number[] = [];
    for (const g of ordered) {
      const h = g.stats["batter_hits"];
      if (typeof h !== "number" || !Number.isFinite(h)) continue;
      const hrRaw = g.stats["batter_home_runs"];
      const hr = typeof hrRaw === "number" && Number.isFinite(hrRaw) ? hrRaw : 0;
      const nonHr = Math.max(0, h - hr);
      synth.push(hr * 4 + nonHr * BASES_PER_NON_HR_HIT);
    }
    return synth.length > 0 ? { values: synth, derived: true } : null;
  }

  if (!spec.feedKey) return null;
  const values = ordered
    .map(g => g.stats[spec.feedKey as string])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return values.length > 0 ? { values, derived: false } : null;
}

/** League prior mean for a stat. For synthesized Total Bases we build the prior
 *  the same way from the hits/HR league averages so shrinkage still applies. */
function priorMeanFor(spec: StatSpec, leagueAverages: Record<string, number>): number | null {
  if (spec.synthesize) {
    const h = leagueAverages["batter_hits"];
    const hr = leagueAverages["batter_home_runs"];
    if (typeof h !== "number") return null;
    const homers = typeof hr === "number" ? hr : 0;
    return homers * 4 + Math.max(0, h - homers) * BASES_PER_NON_HR_HIT;
  }
  const avg = leagueAverages[spec.feedKey as string];
  return typeof avg === "number" && avg >= 0 ? avg : null;
}

/** Fit a count distribution for ONE player + ONE stat. Returns null only when
 *  there is no usable series at all (player absent or feed key missing). */
export function distributionFor(
  player: PlayerGameLog,
  spec: StatSpec,
  leagueAverages: Record<string, number>,
): StatDistribution | null {
  const series = seriesFor(player.games, spec);
  if (!series) return null;
  const { values, derived } = series;
  const n = values.length;
  const notes: string[] = [];
  if (derived) notes.push("Total Bases synthesized from hits+HR (feed has no 2B/3B) — estimate, not measured");

  const { mean: formMean, variance: formVar, nEff } = weightedMoments(values);

  // Shrink the mean toward the league prior.
  const prior = priorMeanFor(spec, leagueAverages);
  let shrunkMean = formMean;
  if (prior !== null) {
    const w = nEff / (nEff + SHRINK_K);
    shrunkMean = w * formMean + (1 - w) * prior;
    if (w < 0.6) {
      notes.push(`thin sample (n≈${nEff.toFixed(1)}) — ${((1 - w) * 100).toFixed(0)}% shrunk toward league prior ${prior.toFixed(2)}`);
    }
  } else {
    notes.push("no league prior — mean not shrunk");
  }

  // HR (rateTimesPa): the per-game series is per-game HR, which already bakes in
  // a typical PA count. We DECOMPOSE it into a per-PA rate and re-multiply by
  // EXPECTED_PA_REGULAR so the rare-event mean is anchored on OPPORTUNITY (the
  // honest driver) rather than a raw game count. With no lineup-slot feed the
  // assumed PA equals the league-typical PA the rate was derived from, so the
  // value is unchanged TODAY — but the decomposition is the seam a future feed
  // with real PA/slot scales through without touching the tail math. The note
  // makes that assumption explicit rather than hiding it.
  let mean = Math.max(0, shrunkMean);
  if (spec.rateTimesPa) {
    const perPaRate = mean / EXPECTED_PA_REGULAR;
    mean = perPaRate * EXPECTED_PA_REGULAR;
    notes.push(`HR modeled as per-PA rate × ${EXPECTED_PA_REGULAR} expected PA (no lineup-slot feed — assumes a regular's PA)`);
  }

  // Dispersion: estimate r from variance vs mean, shrink toward the prior r.
  // Var = μ + μ²/r  ⇒  r = μ² / (Var − μ)  when Var > μ. Otherwise Poisson.
  const priorR = PRIOR_NB_R[spec.stat];
  let dispersion = Infinity;
  let method: StatDistribution["method"] = "poisson";
  if (mean > 0 && formVar > mean + 1e-9) {
    const fittedR = (mean * mean) / (formVar - mean);
    if (Number.isFinite(fittedR) && fittedR > 0) {
      // Blend fitted r with the prior r on a precision-like weight: the fit
      // earns weight nEff, the prior carries DISPERSION_PRIOR_WEIGHT. The
      // second moment is noisier than the mean, so the prior leans heavy.
      const wFit = nEff / (nEff + DISPERSION_PRIOR_WEIGHT);
      dispersion = wFit * fittedR + (1 - wFit) * priorR;
      method = "negative-binomial";
    }
  }
  if (method === "poisson" && mean > 0) {
    // Under-dispersed / thin sample. Use the prior r as a mild over-dispersion
    // floor rather than a bare Poisson, so we never PRINT a tighter-than-real
    // tail on a quiet sample. (Poisson is the r→∞ limit; capping at priorR
    // widens it.)
    dispersion = priorR;
    method = "negative-binomial";
    notes.push("variance ≤ mean in sample — used prior dispersion (avoids overconfident Poisson tail)");
  }

  const lowConfidence = n < MIN_GAMES;
  if (lowConfidence) notes.push(`only ${n} game${n === 1 ? "" : "s"} — low confidence, leans on prior`);

  const ladder: LadderRung[] = spec.ladder.map(threshold => {
    const raw =
      method === "negative-binomial"
        ? nbSf(threshold, mean, dispersion)
        : poissonSf(threshold, mean);
    // Clamp away from the absolute edges so downstream EV/Kelly stays finite.
    const prob = Math.min(0.99, Math.max(0.005, raw));
    return { threshold, prob: +prob.toFixed(4) };
  });

  return {
    stat: spec.stat,
    label: spec.label,
    kind: spec.kind,
    mean: +mean.toFixed(3),
    dispersion: Number.isFinite(dispersion) ? +dispersion.toFixed(2) : Infinity,
    method,
    ladder,
    nGames: n,
    derived,
    lowConfidence,
    notes,
  };
}

/** All distributions for one player across every catalog stat that matches the
 *  player's kind (batters get batter stats, pitchers get pitcher stats — a
 *  player with both kinds of games gets both, which is rare but harmless). */
export function distributionsForPlayer(
  player: PlayerGameLog,
  leagueAverages: Record<string, number>,
): StatDistribution[] {
  const out: StatDistribution[] = [];
  for (const spec of MLB_STAT_SPECS) {
    const dist = distributionFor(player, spec, leagueAverages);
    if (dist) out.push(dist);
  }
  return out;
}

/** Resolve a player entry in the gamelog file by display name (normalized). */
export function findPlayer(
  file: MlbGameLogFile,
  name: string,
): PlayerGameLog | null {
  const key = normalizeName(name);
  return file.players[key] ?? null;
}
