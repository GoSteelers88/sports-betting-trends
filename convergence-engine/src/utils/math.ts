// Core math utilities for edge calculations

export function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

export function roundDecimal(n: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

// Probability ↔ Price conversions
export function probToCents(prob: number): number {
  return roundDecimal(prob * 100, 1);
}

export function centsToProb(cents: number): number {
  return clamp(cents / 100, 0, 1);
}

// Vig removal: reverse-engineer fair probability from book odds
export function removeVig(p: number, q: number): { fairP: number; fairQ: number } {
  const bookSum = p + q;
  if (bookSum <= 0) return { fairP: 0.5, fairQ: 0.5 };
  return {
    fairP: p / bookSum,
    fairQ: q / bookSum,
  };
}

// Edge calculation
export function calculateGrossEdge(a: number, b: number): number {
  return Math.abs(a - b);
}

export function calculateNetEdge(
  grossEdge: number,
  fees: number,
  friction: number
): number {
  return Math.max(0, grossEdge - fees - friction);
}

// Statistical utilities
export function standardDeviation(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length;
  return Math.sqrt(variance);
}

export function sharpeRatio(returns: number[], riskFree: number = 0): number {
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const sd = standardDeviation(returns);
  if (sd === 0) return 0;
  return (avgReturn - riskFree) / sd;
}

// Kelly criterion for position sizing
export function kellyFraction(
  winProb: number,
  odds: number, // net odds received (e.g., 1.0 for even money)
  leverage: number = 0.5 // fractional Kelly
): number {
  const q = 1 - winProb;
  const k = (winProb * odds - q) / odds;
  return Math.max(0, k * leverage);
}
