import Anthropic from "@anthropic-ai/sdk";
import { getRequiredEnv } from "@/lib/server-env";

let cached: Anthropic | null = null;

export function getAnthropic(): Anthropic {
  if (!cached) {
    cached = new Anthropic({ apiKey: getRequiredEnv("ANTHROPIC_API_KEY") });
  }
  return cached;
}

export const MODELS = {
  analyst: "claude-sonnet-4-6",
  dream: "claude-opus-4-7",
  // PEAD entry annotator — label-only classification of 0-3 rows/day;
  // never on the trading path, so the cheapest tier is appropriate.
  annotator: "claude-haiku-4-5",
} as const;

export type ModelKey = keyof typeof MODELS;
