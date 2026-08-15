// nfl-calibration.ts — the deterministic probability/side of the loop
// (2026-08-15 research, rec 3): shrinkage-gated bucket stats, beta
// calibration of model confidences, and fractional-Kelly staking in code.
// The LLM never sizes a bet and never promotes a small-n bucket to doctrine;
// these functions are the frozen anchors it cannot tune.

import { americanToDecimal } from "./nfl-devig";

// ─── Beta(50,50) posterior gate ──────────────────────────────────────────────

/** Break-even win probability at american juice, e.g. -110 → 0.5238. */
export function breakevenProb(american: number): number {
  return 1 / americanToDecimal(american);
}

/** Posterior mean win rate under a Beta(50,50) prior: (w + 50) / (n + 100).
 *  The prior mean is 50% — below breakeven — so a zero-evidence bucket can
 *  never pass, and passing at all requires 8/10, 13/20, 29/50 shapes. */
export function posteriorMeanWinRate(
  wins: number,
  n: number,
  priorWins = 50,
  priorN = 100,
): number {
  if (n < 0 || wins < 0 || wins > n) {
    throw new Error(`invalid bucket record: ${wins}/${n}`);
  }
  return (wins + priorWins) / (n + priorN);
}

export interface BucketEligibility {
  bucket: string;
  wins: number;
  losses: number;
  pushes: number;
  n: number; // decided bets (pushes excluded)
  rawRate: number;
  posteriorMean: number;
  /** The win rate this bucket must clear — the mean break-even implied by the
   *  bucket's OWN prices, not a fixed -110. A -300-favorite bucket must clear
   *  75%, a +150-dog bucket only 40% (review finding 2026-08-15: gating every
   *  bucket at 52.4% certified win-rate-high/ROI-negative favorite buckets and
   *  permanently blinded the gate to profitable plus-money dogs). */
  breakeven: number;
  eligible: boolean;
}

/** Evaluate one bucket record against the doctrine gate at an explicit
 *  break-even probability. Pushes are excluded from n (they return stakes). */
export function evaluateBucketAt(
  bucket: string,
  wins: number,
  losses: number,
  pushes: number,
  breakeven: number,
): BucketEligibility {
  const n = wins + losses;
  const posteriorMean = posteriorMeanWinRate(wins, n);
  return {
    bucket,
    wins,
    losses,
    pushes,
    n,
    rawRate: n > 0 ? wins / n : 0,
    posteriorMean,
    breakeven,
    eligible: posteriorMean > breakeven,
  };
}

/** Evaluate a bucket priced uniformly at one american juice (default -110).
 *  For mixed-price buckets use evaluateBucketAt with the mean break-even of
 *  the actual prices. */
export function evaluateBucket(
  bucket: string,
  wins: number,
  losses: number,
  pushes = 0,
  juiceAmerican = -110,
): BucketEligibility {
  return evaluateBucketAt(
    bucket,
    wins,
    losses,
    pushes,
    breakevenProb(juiceAmerican),
  );
}

// ─── Wilson score interval ───────────────────────────────────────────────────

/** Wilson 95% CI for a binomial proportion — the props verdict metric
 *  (research rec 2: props are graded on realized results with CIs, not CLV). */
export function wilsonInterval(
  wins: number,
  n: number,
  z = 1.96,
): { low: number; high: number; mid: number } {
  if (n === 0) return { low: 0, high: 1, mid: 0.5 };
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half), mid: center };
}

// ─── Beta calibration (Kull, Silva Filho & Flach 2017) ──────────────────────
//
// Maps a raw confidence s ∈ (0,1) to a calibrated probability via
//   p = sigmoid(a·ln(s) − b·ln(1−s) + c)
// Chosen over Platt (wrong distortion family for [0,1] scores; excludes the
// identity map) and isotonic (overfits below ~500-1000 samples). Stable at
// the ~100-200 graded picks per walk-forward step the loop actually has.

export interface BetaCalibration {
  a: number;
  b: number;
  c: number;
  n: number;
}

const EPS = 1e-6;

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Fit by gradient descent on log loss (samples are small; convergence is
 *  fast and dependency-free). Scores are clamped away from 0/1. */
export function fitBetaCalibration(
  samples: Array<{ score: number; won: boolean }>,
  iterations = 4000,
  lr = 0.5,
): BetaCalibration {
  if (samples.length < 20) {
    // Too little data to fit anything — identity map (a=1, b=1, c=0 is
    // exactly p = s under this parameterization... verified in tests).
    return { a: 1, b: 1, c: 0, n: samples.length };
  }
  const xs = samples.map((s) => {
    const sc = Math.min(1 - EPS, Math.max(EPS, s.score));
    return { x1: Math.log(sc), x2: -Math.log(1 - sc), y: s.won ? 1 : 0 };
  });
  let a = 1;
  let b = 1;
  let c = 0;
  const n = xs.length;
  for (let it = 0; it < iterations; it++) {
    let ga = 0;
    let gb = 0;
    let gc = 0;
    for (const { x1, x2, y } of xs) {
      const err = sigmoid(a * x1 + b * x2 + c) - y;
      ga += err * x1;
      gb += err * x2;
      gc += err;
    }
    a -= (lr * ga) / n;
    b -= (lr * gb) / n;
    c -= (lr * gc) / n;
    // Kull et al. constrain a,b ≥ 0 so the map stays monotone.
    if (a < 0) a = 0;
    if (b < 0) b = 0;
  }
  return { a, b, c, n };
}

/** Apply a fitted calibration map to a raw confidence. */
export function calibrate(cal: BetaCalibration, score: number): number {
  const s = Math.min(1 - EPS, Math.max(EPS, score));
  return sigmoid(cal.a * Math.log(s) - cal.b * Math.log(1 - s) + cal.c);
}

/** Mean log loss of scores vs outcomes — lower is better-calibrated. */
export function logLoss(
  samples: Array<{ score: number; won: boolean }>,
): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const { score, won } of samples) {
    const s = Math.min(1 - EPS, Math.max(EPS, score));
    sum += won ? -Math.log(s) : -Math.log(1 - s);
  }
  return sum / samples.length;
}

// ─── Fractional Kelly staking ────────────────────────────────────────────────

/** Fraction of bankroll to stake: k × Kelly, floored at 0, capped.
 *  p must be a CALIBRATED probability; the price is the actual entry odds.
 *  k defaults to 0.25 (quarter Kelly — the professional standard against
 *  estimation error; overbetting is asymmetrically worse than underbetting). */
export function kellyStakeFraction(
  p: number,
  entryAmerican: number,
  k = 0.25,
  maxFraction = 0.03,
): number {
  if (p <= 0 || p >= 1) return 0;
  const b = americanToDecimal(entryAmerican) - 1; // net odds
  const full = (b * p - (1 - p)) / b;
  if (full <= 0) return 0;
  return Math.min(full * k, maxFraction);
}
