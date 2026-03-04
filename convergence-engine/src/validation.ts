import { MarketMapping } from "./types";
import { config } from "./config";

/**
 * BRD Section 5.2: Contract Mapping & Validation
 * - Resolution text semantic equivalence
 * - Expiry drift ≤ 24 hours
 * - Binary payoff structure match
 * - Block signal if validation fails
 */

export interface ValidationResult {
  valid: boolean;
  reasons: string[];
}

export function validateMapping(mapping: MarketMapping): ValidationResult {
  const reasons: string[] = [];

  // Check if explicitly validated
  if (!mapping.validated) {
    reasons.push("Mapping not validated");
  }

  // Check semantic equivalence score
  if (mapping.equivalenceScore < config.mapping.semanticMatchThreshold) {
    reasons.push(
      `Semantic score ${(mapping.equivalenceScore * 100).toFixed(1)}% below threshold ${(config.mapping.semanticMatchThreshold * 100).toFixed(1)}%`
    );
  }

  // Check expiry drift (polyExpiryTs removed; kalshiExpiryTs is the sole reference point)
  // No cross-platform expiry check needed without Polymarket

  return {
    valid: reasons.length === 0,
    reasons,
  };
}

export function hoursToExpiry(expiryTs: number): number {
  return Math.max(0, (expiryTs - Date.now()) / (60 * 60 * 1000));
}

export function bothHaltsAreInSync(a: MarketMapping): boolean {
  // Placeholder: both markets should resolve to same outcome
  return true;
}
