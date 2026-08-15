// nfl-devig.ts — vig removal for two-outcome betting markets.
//
// Why this exists (2026-08-15 research, rec 7): naive proportional
// normalization spreads the bookmaker's margin evenly across outcomes, but
// books load margin disproportionately onto longshots (favorite-longshot
// bias). Devigging a dog with the naive method therefore overstates its fair
// probability by ~0.5-1pp — phantom value concentrated exactly where the
// loop's dog doctrine lives. Buchdahl's yield-to-zero test on 410,628
// Pinnacle closes: naive devig graded -0.56% (should be 0%), odds-weighted
// models graded within ±0.20%.
//
// All functions are pure. Markets here are two-outcome (side A / side B);
// probabilities always sum to 1 after devig.

export type DevigMethod = "multiplicative" | "oddsWeighted" | "power" | "shin";

export const DEVIG_METHODS: DevigMethod[] = [
  "multiplicative",
  "oddsWeighted",
  "power",
  "shin",
];

/** American odds → decimal odds. -110 → 1.9091, +200 → 3.0 */
export function americanToDecimal(american: number): number {
  if (!Number.isFinite(american) || american === 0) {
    throw new Error(`invalid american odds: ${american}`);
  }
  return american > 0 ? 1 + american / 100 : 1 + 100 / -american;
}

/** American odds → raw implied probability (vig included). */
export function americanToImplied(american: number): number {
  return 1 / americanToDecimal(american);
}

/** Decimal odds → american (for display). */
export function decimalToAmerican(decimal: number): number {
  if (decimal <= 1) throw new Error(`invalid decimal odds: ${decimal}`);
  return decimal >= 2 ? (decimal - 1) * 100 : -100 / (decimal - 1);
}

/** Overround (booksum) of a two-sided market from american prices, e.g.
 *  -110/-110 → 1.0476. */
export function overround(americanA: number, americanB: number): number {
  return americanToImplied(americanA) + americanToImplied(americanB);
}

/** Fair probabilities for [sideA, sideB] with the margin split evenly —
 *  the NAIVE baseline. Kept for comparison; do not use for dog edges. */
function multiplicative(qA: number, qB: number): [number, number] {
  const s = qA + qB;
  return [qA / s, qB / s];
}

/** Buchdahl's closed-form "margin weights proportional to odds":
 *  p_i = (n - M·O_i) / (n·O_i)  with n outcomes, M = overround - 1,
 *  O_i decimal odds. Loads more margin onto the longshot. */
function oddsWeighted(oA: number, oB: number): [number, number] {
  const n = 2;
  const M = 1 / oA + 1 / oB - 1;
  const pA = (n - M * oA) / (n * oA);
  const pB = (n - M * oB) / (n * oB);
  // Degenerate at extreme longshots (can go negative, like additive devig);
  // clamp then renormalize so callers always get a distribution.
  const cA = Math.max(pA, 1e-9);
  const cB = Math.max(pB, 1e-9);
  return [cA / (cA + cB), cB / (cA + cB)];
}

/** Power method: find k ≥ 1 with qA^k + qB^k = 1, fair p_i = q_i^k.
 *  Solved by bisection — the sum is strictly decreasing in k. */
function power(qA: number, qB: number): [number, number] {
  let lo = 1;
  let hi = 1;
  while (Math.pow(qA, hi) + Math.pow(qB, hi) > 1) {
    hi *= 2;
    if (hi > 1024) break;
  }
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (Math.pow(qA, mid) + Math.pow(qB, mid) > 1) lo = mid;
    else hi = mid;
  }
  const k = (lo + hi) / 2;
  const pA = Math.pow(qA, k);
  const pB = Math.pow(qB, k);
  return [pA / (pA + pB), pB / (pA + pB)];
}

/** Shin (1992/93) insider-trading model, two-outcome closed form given z:
 *  p_i = (sqrt(z² + 4(1−z)·q_i²/S) − z) / (2(1−z)), S = booksum.
 *  z (insider fraction) solved by bisection so probabilities sum to 1. */
function shin(qA: number, qB: number): [number, number] {
  const S = qA + qB;
  const pAt = (z: number, q: number): number =>
    z >= 1
      ? q / S
      : (Math.sqrt(z * z + 4 * (1 - z) * ((q * q) / S)) - z) / (2 * (1 - z));
  // The probability sum is strictly DECREASING in z (at z=0 it is √S > 1),
  // so a sum above 1 means z must grow: move lo up, not hi down.
  let lo = 0;
  let hi = 0.5;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (pAt(mid, qA) + pAt(mid, qB) > 1) lo = mid;
    else hi = mid;
  }
  const z = (lo + hi) / 2;
  const pA = pAt(z, qA);
  const pB = pAt(z, qB);
  return [pA / (pA + pB), pB / (pA + pB)];
}

export interface DevigResult {
  /** Fair probability of side A under each method. Side B is 1 - value. */
  byMethod: Record<DevigMethod, number>;
  /** The LOWEST fair probability of side A across methods — bet side A only
   *  if the edge survives this (the conservative envelope from rec 7). */
  worstCaseA: number;
  /** Booksum − 1, e.g. 0.0476 for -110/-110. */
  margin: number;
}

/** Devig a two-outcome market quoted in american odds. Side A is the side
 *  under evaluation (e.g. the dog); returns fair P(A) under every method
 *  plus the worst case. */
export function devigTwoWay(americanA: number, americanB: number): DevigResult {
  const oA = americanToDecimal(americanA);
  const oB = americanToDecimal(americanB);
  const qA = 1 / oA;
  const qB = 1 / oB;
  const byMethod: Record<DevigMethod, number> = {
    multiplicative: multiplicative(qA, qB)[0],
    oddsWeighted: oddsWeighted(oA, oB)[0],
    power: power(qA, qB)[0],
    shin: shin(qA, qB)[0],
  };
  return {
    byMethod,
    worstCaseA: Math.min(...DEVIG_METHODS.map((m) => byMethod[m])),
    margin: qA + qB - 1,
  };
}

/** Devigged fair probability of side A from decimal odds (for sources that
 *  quote decimal, e.g. the SBR archive after conversion). */
export function devigTwoWayDecimal(
  decimalA: number,
  decimalB: number,
): DevigResult {
  return devigTwoWay(decimalToAmerican(decimalA), decimalToAmerican(decimalB));
}
