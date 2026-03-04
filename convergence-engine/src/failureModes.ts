import { SystemHealth, Venue } from "./types";
import { config } from "./config";

/**
 * BRD Section 5.9: Failure Modes
 * Disable signals if:
 * - Venue halt
 * - API latency > 3.5 seconds
 * - Spread widening persists > 5 minutes
 * - Oracle divergence
 * - Liquidity collapse
 */

export function createSystemHealth(): SystemHealth {
  return {
    venueHalt: new Map([
      ["KALSHI", false],
    ]),
    apiLatencyMs: new Map([
      ["KALSHI", 0],
    ]),
    oracleDivergent: false,
    liquidityCollapsed: false,
    killSwitch: false,
  };
}

export interface HealthCheck {
  healthy: boolean;
  reasons: string[];
}

export function checkSystemHealth(
  health: SystemHealth,
  spreadWideningStart?: number
): HealthCheck {
  const reasons: string[] = [];

  // Venue halts
  for (const [venue, halted] of health.venueHalt) {
    if (halted) {
      reasons.push(`${venue} halted`);
    }
  }

  // API latency
  for (const [venue, latency] of health.apiLatencyMs) {
    if (latency > config.latency.maxApiLatencyMs) {
      reasons.push(
        `${venue} API latency ${latency}ms exceeds ${config.latency.maxApiLatencyMs}ms`
      );
    }
  }

  // Spread widening timeout (5 minutes)
  if (spreadWideningStart) {
    const wideningDuration = (Date.now() - spreadWideningStart) / 1000;
    if (wideningDuration > config.failure.spreadWidenTimeoutSec) {
      reasons.push(
        `Spread widening persisted ${(wideningDuration / 60).toFixed(1)}min > ${config.failure.spreadWidenTimeoutSec / 60}min`
      );
    }
  }

  // Oracle divergence
  if (health.oracleDivergent) {
    reasons.push("Oracle divergence detected");
  }

  // Liquidity collapse
  if (health.liquidityCollapsed) {
    reasons.push("Liquidity collapsed below minimum");
  }

  // Master kill switch
  if (health.killSwitch) {
    reasons.push("Kill switch engaged");
  }

  return {
    healthy: reasons.length === 0,
    reasons,
  };
}
