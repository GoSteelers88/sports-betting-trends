// De-vig (no-vig) math — the heart of the de-vigged-sharp pivot.
//
// A bookmaker's posted prices imply probabilities that sum to MORE than 1.
// The excess is the vig (overround / juice). To recover the book's true
// estimate of each outcome's probability we must strip the vig back out.
//
// We treat a SHARP book's de-vigged price as fair value: the best public
// estimate of the true probability. We then bet only when a SOFT book offers
// a price whose implied probability is BELOW that fair value (i.e. positive
// expected value). See `fair-value.ts`.
//
// Methods implemented (all I/O-free, deterministic, NaN-guarded):
//   - multiplicative (proportional) — the default; best-justified for a
//     low, symmetric-vig book like Pinnacle.
//   - additive (equal-margin)       — subtract the same probability mass from
//     each side.
//   - power                         — raise each implied prob to a common
//     exponent k so they sum to 1 (favourite-longshot aware).
//   - shin                          — models a fraction z of insider money;
//     shades probability toward longshots. Industry standard for fair value.
//
// References: Shin (1992, 1993); Štrumbelj (2014) "On determining probability
// forecasts from betting odds"; Wong / Davidow on de-vigging the sharp close.

export type DevigMethod = "multiplicative" | "additive" | "power" | "shin";

export const DEFAULT_DEVIG_METHOD: DevigMethod = "multiplicative";

// ─────────────────────────────────────────────────────────────────────────────
// Odds conversions (American ↔ decimal ↔ implied probability)
// ─────────────────────────────────────────────────────────────────────────────

/** American odds → decimal odds. Returns NaN for non-finite / zero input. */
export function americanToDecimal(american: number): number {
  if (!Number.isFinite(american) || american === 0) return NaN;
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

/** Decimal odds → American odds. */
export function decimalToAmerican(decimal: number): number {
  if (!Number.isFinite(decimal) || decimal <= 1) return NaN;
  return decimal >= 2
    ? Math.round((decimal - 1) * 100)
    : Math.round(-100 / (decimal - 1));
}

/** American odds → implied probability (INCLUDES vig). */
export function americanToImpliedProb(american: number): number {
  const dec = americanToDecimal(american);
  return Number.isFinite(dec) ? 1 / dec : NaN;
}

/**
 * Closing line value, in PROBABILITY POINTS.
 *
 * Positive = the price we took implies a LOWER probability than the close, i.e.
 * we bought a longer number than the market settled on.
 *
 * Use this instead of subtracting American odds. American odds are not a linear
 * scale and they are DISCONTINUOUS at ±100: +100 and −100 are both 50%, yet
 * they subtract to 200. Raw subtraction therefore preserves the SIGN (the raw
 * value is monotonically decreasing in probability) but wildly distorts the
 * MAGNITUDE of any move that crosses the boundary.
 *
 * That distortion is not hypothetical. It put three sign-crossing picks —
 * one of them a genuine 1.48pp move recorded as "206¢" — in charge of 98% of
 * the paper trial's entire CLV total, which flipped the pre-registered
 * "avg CLV ≥ +2¢" funding gate from FAIL to PASS on an artifact.
 *
 * Returns NaN when either price is unusable.
 */
export function clvProbPoints(takenAmerican: number, closeAmerican: number): number {
  const taken = americanToImpliedProb(takenAmerican);
  const close = americanToImpliedProb(closeAmerican);
  if (!Number.isFinite(taken) || !Number.isFinite(close)) return NaN;
  return (close - taken) * 100;
}

/** Probability (0,1) → American odds (the fair line at that probability). */
export function probToAmerican(p: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return NaN;
  const dec = 1 / p;
  return decimalToAmerican(dec);
}

/** Probability (0,1) → decimal odds. */
export function probToDecimal(p: number): number {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return NaN;
  return 1 / p;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core de-vig — operates on a vector of implied (with-vig) probabilities
// ─────────────────────────────────────────────────────────────────────────────

export type DevigResult = {
  /** Fair (no-vig) probabilities, same order as input, summing to ~1. */
  fair: number[];
  /** Overround Φ = Σ implied − 1 (the book's margin; >0 normally). */
  overround: number;
  method: DevigMethod;
  /** Shin insider fraction z (only for method="shin", else 0). */
  z?: number;
  /** Power exponent k (only for method="power", else undefined). */
  k?: number;
};

function sanitizeImplied(implied: number[]): number[] | null {
  if (!Array.isArray(implied) || implied.length < 2) return null;
  for (const p of implied) {
    if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
  }
  return implied;
}

/**
 * De-vig a vector of implied probabilities (one per outcome).
 * Works for 2-way (moneyline, total, spread) and n-way (3-way soccer, futures).
 * Returns null if any input is non-finite or outside (0,1).
 */
export function devigImplied(
  implied: number[],
  method: DevigMethod = DEFAULT_DEVIG_METHOD,
): DevigResult | null {
  const clean = sanitizeImplied(implied);
  if (!clean) return null;

  const sum = clean.reduce((s, p) => s + p, 0);
  const overround = sum - 1;

  switch (method) {
    case "multiplicative": {
      const fair = clean.map((p) => p / sum);
      return { fair, overround, method };
    }
    case "additive": {
      // Remove the same probability mass (overround / n) from each side.
      // Can push a heavy favourite >1 or a longshot <0; clamp + renormalize
      // so the result stays a valid distribution.
      const n = clean.length;
      let fair = clean.map((p) => p - overround / n);
      fair = fair.map((p) => Math.min(Math.max(p, 1e-6), 1 - 1e-6));
      const fsum = fair.reduce((s, p) => s + p, 0);
      fair = fair.map((p) => p / fsum);
      return { fair, overround, method };
    }
    case "power": {
      // Find k > 0 such that Σ p_i^k = 1. Since Σ p_i > 1, k > 1.
      const k = solvePowerExponent(clean);
      if (!Number.isFinite(k)) return null;
      const raw = clean.map((p) => Math.pow(p, k));
      const rsum = raw.reduce((s, p) => s + p, 0);
      const fair = raw.map((p) => p / rsum); // tidy any tiny residual
      return { fair, overround, method, k };
    }
    case "shin": {
      const z = solveShinZ(clean);
      if (!Number.isFinite(z)) return null;
      const fair = shinFair(clean, z);
      const fsum = fair.reduce((s, p) => s + p, 0);
      const norm = fair.map((p) => p / fsum);
      return { fair: norm, overround, method, z };
    }
    default:
      return null;
  }
}

/**
 * Convenience: de-vig a set of American prices directly.
 * Returns fair probabilities (and fair American lines) per outcome.
 */
export function devigAmerican(
  prices: number[],
  method: DevigMethod = DEFAULT_DEVIG_METHOD,
): (DevigResult & { fairAmerican: number[] }) | null {
  const implied = prices.map(americanToImpliedProb);
  const res = devigImplied(implied, method);
  if (!res) return null;
  return { ...res, fairAmerican: res.fair.map(probToAmerican) };
}

/**
 * Two-way de-vig sugar — returns the fair probability of `sideA` given the
 * American prices of both sides. The most common call site (moneyline).
 */
export function noVigFairProbTwoWay(
  americanA: number,
  americanB: number,
  method: DevigMethod = DEFAULT_DEVIG_METHOD,
): { fairA: number; fairB: number; overround: number } | null {
  const res = devigAmerican([americanA, americanB], method);
  if (!res) return null;
  return { fairA: res.fair[0], fairB: res.fair[1], overround: res.overround };
}

// ─────────────────────────────────────────────────────────────────────────────
// Solvers (bisection — robust, no external deps, monotone targets)
// ─────────────────────────────────────────────────────────────────────────────

// Σ p_i^k is strictly decreasing in k for p_i ∈ (0,1) when Σ p_i > 1, so a
// simple bracketed bisection converges fast and can't diverge.
function solvePowerExponent(implied: number[]): number {
  const f = (k: number) => implied.reduce((s, p) => s + Math.pow(p, k), 0) - 1;
  let lo = 1; // Σ p_i^1 = Σ p_i ≥ 1  → f(lo) ≥ 0
  let hi = 1;
  // expand hi until f(hi) < 0 (Σ shrinks below 1)
  for (let i = 0; i < 60 && f(hi) > 0; i++) hi *= 1.5;
  if (f(hi) > 0) return NaN;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const v = f(mid);
    if (Math.abs(v) < 1e-12) return mid;
    if (v > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// Shin fair probability for outcome i given insider fraction z and the
// normalized booked probabilities. Uses the standard closed form:
//   π_i = [ sqrt(z² + 4(1−z) · q_i² / Σq) − z ] / (2(1−z))
// where q_i are the raw implied probs. As z→0 this reduces to multiplicative.
function shinFair(implied: number[], z: number): number[] {
  const sum = implied.reduce((s, p) => s + p, 0);
  if (z <= 0) return implied.map((p) => p / sum);
  const denom = 2 * (1 - z);
  return implied.map((p) => {
    const inside = z * z + (4 * (1 - z) * (p * p)) / sum;
    return (Math.sqrt(inside) - z) / denom;
  });
}

// Find z ∈ [0, 1) so that Σ shinFair = 1. The sum is monotone decreasing in z
// over the feasible range, so bisection is safe.
function solveShinZ(implied: number[]): number {
  const g = (z: number) => shinFair(implied, z).reduce((s, p) => s + p, 0) - 1;
  let lo = 0;
  let hi = 0.5; // z this high implies absurd insider share; ample bracket
  // g(0) = Σ(p/Σp) − 1 = 0 numerically; nudge if the overround is ~0.
  if (Math.abs(g(0)) < 1e-9) return 0;
  // Ensure a sign change; if g(hi) hasn't crossed, expand toward (but below) 1.
  for (let i = 0; i < 40 && g(hi) > 0; i++) hi = (hi + 1) / 2;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const v = g(mid);
    if (Math.abs(v) < 1e-12) return mid;
    if (v > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ─────────────────────────────────────────────────────────────────────────────
// Expected value
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expected value (as a fraction of stake) of betting `offeredAmerican` when
 * the true probability is `fairProb`. EV = fairProb · decimal − 1.
 * +0.04 means +4% EV per dollar staked. Returns NaN on bad input.
 */
export function expectedValue(fairProb: number, offeredAmerican: number): number {
  const dec = americanToDecimal(offeredAmerican);
  if (!Number.isFinite(dec) || !Number.isFinite(fairProb)) return NaN;
  return fairProb * dec - 1;
}

/**
 * Fractional-Kelly stake (as a fraction of bankroll) for a bet at
 * `offeredAmerican` with true probability `fairProb`. `fraction` defaults to
 * quarter-Kelly (0.25) — the conservative standard for model-driven bets.
 * Never returns negative (no bet if no edge).
 */
export function kellyFraction(
  fairProb: number,
  offeredAmerican: number,
  fraction = 0.25,
): number {
  const dec = americanToDecimal(offeredAmerican);
  if (!Number.isFinite(dec) || !Number.isFinite(fairProb)) return 0;
  const b = dec - 1; // net decimal winnings per unit
  if (b <= 0) return 0;
  const q = 1 - fairProb;
  const full = (b * fairProb - q) / b; // classic Kelly
  return Math.max(0, full * fraction);
}
