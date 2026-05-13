// Devil's Advocate critic. Takes the analyst's picks and tries to kill each
// one. A pick survives only if the critic can't find a strong reason to drop it.
// Runs as a single Sonnet call (one round trip, no tool use) for low latency.

import { getAnthropic, MODELS } from "./client";
import type { GradedPick } from "./grader";
import type { AgentLeague } from "./tools";
import type { TraceStep } from "./analyst";

export type CritiqueDecision = {
  pickIndex: number; // 0-based index into input array
  verdict: "keep" | "kill" | "weaken";
  reason: string;
  suggestedStakeMultiplier?: number; // for "weaken", e.g. 0.5 to halve
};

export type CritiqueResult = {
  decisions: CritiqueDecision[];
  rawText: string;
  // True when the LLM response could not be parsed into a valid decisions
  // array. The orchestrator treats this as fail-closed: drop ALL picks rather
  // than auto-approve them.
  parseFailed?: boolean;
};

const CRITIC_SYSTEM = `You are a sharp, contrarian sports-betting analyst whose job is to KILL bad picks before they ship.

You will receive an analyst's proposed picks AND, when available, the analyst's reasoning trace — the tool calls it made, what each tool returned, and any narrative it wrote between tool calls. Use the trace to audit upstream decisions, not just the final JSON:

- Did the analyst gather the right data? (e.g., picked an MLB game without checking get_injuries or get_mlb_signals)
- Did a tool result contradict the thesis but get ignored? (e.g., get_injuries flagged a star out, thesis doesn't mention it)
- Is the modelProb consistent with what get_model_probabilities or get_prop_projection returned, or did the analyst invent a number?
- Are the bestPrice odds the analyst cited actually present in the get_odds result, or did it hallucinate?
- Did the analyst follow active AgentMemory rules visible in the trace, or quietly violate them?

For each pick, your default position is skeptical: assume it's wrong unless the thesis is rock-solid AND the trace supports it.

═══ MONEYLINE-SPECIFIC kill signals ═══
- Large model-vs-market gaps (>10pp). 6+ books rarely all miss by 10pp.
- Plus-money longshots with thin theses. Big edges on +200 dogs often mean the model is poorly calibrated for tails.
- Reasoning that cites generic stats (RPG, win rate) rather than specific situational factors.
- Spread/total picks where the model's "expected margin" exceeds the spread by < 2 points (low margin of safety).
- Trace-vs-thesis mismatches.

═══ PROP-SPECIFIC kill signals (extra skepticism here — prop markets are noisier than ML) ═══
- **Fabricated modelProb**: prop picks MUST source modelProb from get_prop_projection. If the trace shows no get_prop_projection call for the player, or the modelProb doesn't match what the tool returned, KILL.
- **Thin projection sample**: if get_prop_projection returned nGames < 8, the projection is noisy. Either kill, or weaken to ≤0.5×.
- **Minutes / role risk not addressed**: NBA props in particular hinge on minutes played. If the thesis doesn't mention starter status, foul trouble risk, blowout/garbage-time exposure, or recent role changes, weaken or kill.
- **Stale opponent allowance**: get_prop_projection's opponentFactor is computed off the 10-day window. If the opponent has had a major lineup change inside that window (key defender out, traded for a stopper, etc.), the factor lies. Weaken.
- **Outlier projection**: projected far from the line in a way that contradicts the player's recentForm. If projected = 22 but recentForm = [12, 14, 11, 13, 15], the rolling mean is being yanked by old games. Kill.
- **Plus-money OVERs on low-volume stats**: blocks, steals, threes — small numbers mean variance dwarfs edge. Big modelProb advantages on these are usually projection artifacts. Strong kill.
- **Same-game prop stacking**: if multiple props on one game/player slipped past the bankroll guard, kill the weaker ones.

Your three verdicts:
- "kill": Drop the pick. Use when the thesis has a specific weakness (model overconfidence, ignored data, math error, trace mismatch, prop-specific risk above).
- "weaken": Keep the pick but cut the stake. Use when the edge is real but smaller than claimed. Provide suggestedStakeMultiplier 0.25-0.75.
- "keep": Approve as-is. Reserve for picks with specific, defensible theses that the trace corroborates.

Be honest. If 4 out of 4 picks should be killed, kill all 4. Discipline matters more than action. Apply EXTRA skepticism to prop picks — they're easier to invent edge for and harder to grade in real time.

Return ONLY a JSON object, no prose, no markdown:
{
  "decisions": [
    { "pickIndex": 0, "verdict": "keep|kill|weaken", "reason": "...", "suggestedStakeMultiplier": 0.5 }
  ]
}`;

// Cap the trace at ~30KB of serialized payload so the critic stays inside a
// healthy Sonnet context budget and per-call cost stays predictable.
const TRACE_PAYLOAD_BUDGET_BYTES = 30_000;

function trimTraceToBudget(trace: TraceStep[]): TraceStep[] {
  let bytes = 0;
  const out: TraceStep[] = [];
  // Most diagnostic value is at the tail (final tool results just before the
  // analyst wrote its picks). Walk from the end backwards, then reverse.
  for (let i = trace.length - 1; i >= 0; i--) {
    const step = trace[i];
    const stepBytes = JSON.stringify(step).length;
    if (bytes + stepBytes > TRACE_PAYLOAD_BUDGET_BYTES) break;
    bytes += stepBytes;
    out.unshift(step);
  }
  return out;
}

export async function critique(
  league: AgentLeague,
  picks: GradedPick[],
  trace?: TraceStep[]
): Promise<CritiqueResult> {
  if (picks.length === 0) return { decisions: [], rawText: "", parseFailed: false };

  const client = getAnthropic();

  const trimmedTrace = trace && trace.length > 0 ? trimTraceToBudget(trace) : [];

  const userPayload = JSON.stringify(
    {
      league,
      picks: picks.map((p, i) => ({
        index: i,
        matchup: p.matchup,
        market: p.market,
        selection: p.selection,
        oddsAmerican: p.oddsAmerican,
        modelProb: p.modelProb,
        marketProb: p.marketProb,
        edge: p.edge,
        kellyStakeUnits: p.kellyStakeUnits,
        confidence: p.confidence,
        thesis: p.thesis,
        invalidation: p.invalidation,
        signals: p.signals,
        // Prop-specific fields surfaced so the critic can audit against the
        // trace's get_prop_projection result for the same player + line.
        ...(p.market === "prop"
          ? { player: p.player, propType: p.propType, line: p.line, side: p.side }
          : {}),
      })),
      analystReasoningTrace: trimmedTrace,
      traceNote:
        trimmedTrace.length === 0
          ? "no trace available — judge picks on their own merits"
          : `${trimmedTrace.length} steps (most recent kept; older trimmed if budget exceeded)`,
    },
    null,
    2
  );

  const response = await client.messages.create({
    model: MODELS.analyst,
    max_tokens: 2048,
    system: CRITIC_SYSTEM,
    messages: [{ role: "user", content: userPayload }],
  });

  let text = "";
  for (const block of response.content) {
    if (block.type === "text") text += block.text;
  }

  const { decisions, parseFailed } = parseDecisions(text, picks.length);
  // Sanity check: if the critic returned fewer decisions than picks, that's
  // also a fail-closed scenario — we can't trust auto-keep on missing indexes.
  const undercount = decisions.length < picks.length;
  return {
    decisions,
    rawText: text,
    parseFailed: parseFailed || undercount,
  };
}

export function applyCritiqueToPicks(
  picks: GradedPick[],
  decisions: CritiqueDecision[]
): { kept: GradedPick[]; killed: Array<{ pick: GradedPick; reason: string }> } {
  const kept: GradedPick[] = [];
  const killed: Array<{ pick: GradedPick; reason: string }> = [];

  for (let i = 0; i < picks.length; i++) {
    const decision = decisions.find(d => d.pickIndex === i);
    if (!decision) {
      kept.push(picks[i]);
      continue;
    }
    if (decision.verdict === "kill") {
      killed.push({ pick: picks[i], reason: decision.reason });
      continue;
    }
    if (decision.verdict === "weaken") {
      // Clamp to system-prompt range (0.25-0.75). A returned 1.0 should be
      // treated as no-op weaken rather than silently kept at full stake.
      const mult = clamp(decision.suggestedStakeMultiplier ?? 0.5, 0.25, 0.75);
      kept.push({
        ...picks[i],
        kellyStakeUnits: +(picks[i].kellyStakeUnits * mult).toFixed(2),
        graderNotes: [...picks[i].graderNotes, `critic weakened: ${decision.reason} (×${mult})`],
      });
      continue;
    }
    kept.push(picks[i]);
  }
  return { kept, killed };
}

function parseDecisions(
  text: string,
  expectedCount: number
): { decisions: CritiqueDecision[]; parseFailed: boolean } {
  let cleaned = text.trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) cleaned = fence[1].trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) cleaned = cleaned.slice(first, last + 1);
  try {
    const parsed = JSON.parse(cleaned) as { decisions?: CritiqueDecision[] };
    const arr = Array.isArray(parsed.decisions) ? parsed.decisions.slice(0, expectedCount) : [];
    return { decisions: arr, parseFailed: !Array.isArray(parsed.decisions) };
  } catch {
    return { decisions: [], parseFailed: true };
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
