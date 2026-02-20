import { thresholds } from "./thresholds.js";
import { weights } from "./weights.js";
import { risk } from "./risk.js";
import { env } from "./env.js";

export { thresholds, weights, risk, env };

export interface EngineConfig {
  thresholds: typeof thresholds;
  weights: typeof weights;
  risk: typeof risk;
  env: typeof env;
}

export function loadConfig(): EngineConfig {
  return {
    thresholds,
    weights,
    risk,
    env: env.load(),
  };
}
