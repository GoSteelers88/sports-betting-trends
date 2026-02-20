import { RiskState, Signal, PositionSize } from "./types";
import { config } from "./config";

/**
 * BRD Section 5.7: Portfolio Governor
 * - Max 5% per market
 * - Max 15% per cluster
 * - Max 20% per event
 * - Max 40% total exposure
 */

export function createRiskState(): RiskState {
  return {
    perMarketPct: new Map(),
    perClusterPct: new Map(),
    perEventPct: new Map(),
    totalExposurePct: 0,
  };
}

export interface ExposureCheck {
  allowed: boolean;
  reasons: string[];
}

export function checkExposure(
  risk: RiskState,
  signal: Signal,
  clusterId: string,
  eventId: string,
  proposedExposure: number
): ExposureCheck {
  const reasons: string[] = [];

  // Per market limit
  const currentMarket = risk.perMarketPct.get(signal.marketId) ?? 0;
  if (currentMarket + proposedExposure > config.risk.maxPerMarketPct) {
    reasons.push(
      `Per-market limit ${(config.risk.maxPerMarketPct * 100).toFixed(0)}% exceeded`
    );
  }

  // Per cluster limit
  const currentCluster = risk.perClusterPct.get(clusterId) ?? 0;
  if (currentCluster + proposedExposure > config.risk.maxPerClusterPct) {
    reasons.push(
      `Per-cluster limit ${(config.risk.maxPerClusterPct * 100).toFixed(0)}% exceeded`
    );
  }

  // Per event limit
  const currentEvent = risk.perEventPct.get(eventId) ?? 0;
  if (currentEvent + proposedExposure > config.risk.maxPerEventPct) {
    reasons.push(
      `Per-event limit ${(config.risk.maxPerEventPct * 100).toFixed(0)}% exceeded`
    );
  }

  // Total exposure limit
  if (risk.totalExposurePct + proposedExposure > config.risk.maxTotalExposurePct) {
    reasons.push(
      `Total exposure limit ${(config.risk.maxTotalExposurePct * 100).toFixed(0)}% exceeded`
    );
  }

  return { allowed: reasons.length === 0, reasons };
}

export function updateRiskState(
  risk: RiskState,
  signal: Signal,
  clusterId: string,
  eventId: string,
  exposure: number
): RiskState {
  const newRisk = { ...risk };

  newRisk.perMarketPct = new Map(risk.perMarketPct);
  newRisk.perMarketPct.set(
    signal.marketId,
    (risk.perMarketPct.get(signal.marketId) ?? 0) + exposure
  );

  newRisk.perClusterPct = new Map(risk.perClusterPct);
  newRisk.perClusterPct.set(
    clusterId,
    (risk.perClusterPct.get(clusterId) ?? 0) + exposure
  );

  newRisk.perEventPct = new Map(risk.perEventPct);
  newRisk.perEventPct.set(
    eventId,
    (risk.perEventPct.get(eventId) ?? 0) + exposure
  );

  newRisk.totalExposurePct = risk.totalExposurePct + exposure;

  return newRisk;
}
