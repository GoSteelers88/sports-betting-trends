import { NormalizedSnapshot } from "./types";
import { config } from "./config";
import { logNorm } from "./utils";

export function liquidityConfidence(
  s: NormalizedSnapshot,
  maxDepth: number,
  maxVolume: number
): number {
  const spreadScore = 1 - Math.min(1, s.spread / config.liquidity.spreadThreshold);
  const depthScore = logNorm(s.depthAtBest, maxDepth);
  const volumeScore = logNorm(s.volume24h, maxVolume);

  const confidence = config.liquidity.wSpread * spreadScore +
                    config.liquidity.wDepth * depthScore +
                    config.liquidity.wVolume * volumeScore;

  return Math.max(0, Math.min(1, confidence));
}
