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
  // Private NFL Backtest Learning Loop (offline offseason study, not on any
  // live path). Sonnet balances slate-sized reasoning against per-week cost.
  nflLoop: "claude-sonnet-4-6",
  // The Sharp — public chatbot Lane A (persona-only) + the router's cheap
  // ambiguity classifier. Haiku because ~90% of chat traffic is general
  // persona Q&A with no tools and no DB reads; the cheapest tier fits.
  // Lane B (live grounded analysis) deliberately reuses `analyst` (Sonnet),
  // not this — never Opus.
  chatPersona: "claude-haiku-4-5",
} as const;

export type ModelKey = keyof typeof MODELS;
