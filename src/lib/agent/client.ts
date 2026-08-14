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
  //
  // Sonnet 5 since the 2026-08-13 walk restart at 2019 REG wk1: cheaper than
  // Sonnet 4.6 ($2/$10 vs $3/$15 — the intro price was made permanent), more
  // capable, and FROZEN for the whole walk + the live 2026 season so the
  // doctrine is calibrated to the exact model that picks live. The pre-restart
  // Sonnet 4.6 record (2015 era) is archived under
  // data/private/nfl-loop/_archive-2026-08-13-pre-2019-restart/.
  // NOTE: Sonnet 5's tokenizer is ~30% denser — the loop's max_tokens caps in
  // nfl-agent.ts were sized up accordingly. Do not mix models mid-walk.
  nflLoop: "claude-sonnet-5",
  // The one-shot WALK-COMPLETION dream only (nfl-dream.ts `final` mode) — the
  // deepest synthesis pass over the full 2019-2024 record, whose doctrine feeds
  // the 2025 holdout and the live 2026 season. Season-boundary dreams during
  // the walk stay on MODELS.dream (Opus); the pick loop stays FROZEN on
  // nflLoop. Fable 5: thinking is always on (never send a `thinking` param),
  // thinking tokens count against max_tokens, and stop_reason can be
  // "refusal" — the dream fn handles all three.
  nflDreamFinal: "claude-fable-5",
  // The Sharp — public chatbot Lane A (persona-only) + the router's cheap
  // ambiguity classifier. Haiku because ~90% of chat traffic is general
  // persona Q&A with no tools and no DB reads; the cheapest tier fits.
  // Lane B (live grounded analysis) deliberately reuses `analyst` (Sonnet),
  // not this — never Opus.
  chatPersona: "claude-haiku-4-5",
} as const;

export type ModelKey = keyof typeof MODELS;
