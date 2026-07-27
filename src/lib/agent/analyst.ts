import crypto from "node:crypto";
import { getAnthropic, MODELS } from "./client";
import {
  TOOL_DEFINITIONS,
  buildToolHandlers,
  ToolName,
  AgentLeague,
  isInScope,
} from "./tools";
import {
  getActiveMemoriesForScope,
  formatMemoriesForPrompt,
  getRecentRecord,
  formatRecordForPrompt,
  getLatestDreamSummary,
  getRecentResultsByTeam,
  formatTeamRecordsForPrompt,
} from "./memory";
import { gradePicksWithDrops, GradedPick, type GraderDrop } from "./grader";
import { prisma } from "@/lib/prisma";

// ─── Pick shape returned by the analyst ────────────────────────────────────

export type AnalystPick = {
  matchup: string;
  market: "moneyline" | "spread" | "total" | "prop";
  selection: string;
  oddsAmerican: number;
  modelProb: number; // 0-1
  marketProb: number; // 0-1
  edge: number; // modelProb - marketProb
  kellyStakeUnits: number; // capped 1/4 Kelly, max 2u
  confidence: number; // 1-100
  thesis: string;
  invalidation: string;
  signals: string[];
  // ISO 8601 datetime for the actual game (commence_time from the odds feed).
  // Required so the autograder + idempotency unique key target the right game,
  // not the pick's persistence-time. Optional in older payloads — falls back
  // to today UTC midnight if missing (with a warning logged).
  gameTime?: string;
  // Stable per-game id (the Odds API event.id) copied from get_odds. Lets the
  // persist layer tell split doubleheaders apart (same matchup + commence_time).
  // Optional: when absent we derive a deterministic synthetic id from
  // matchup + gameTime, so idempotency still holds for non-doubleheader games.
  eventId?: string;
  // Prop-only structured fields. Required when market === "prop"; ignored
  // for moneyline. The autograder reads these to look up the player's box
  // score line and compare to `line` for over/under resolution.
  player?: string;
  propType?: string;
  line?: number;
  side?: "over" | "under";
};

// A single step in the analyst's reasoning loop. The critic uses this to
// audit upstream decisions (did the analyst gather the right data? did it
// ignore a tool result that contradicts the thesis?) rather than only
// judging the final JSON output.
export type TraceStep =
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call"; name: string; argsSummary: string }
  | { kind: "tool_result"; name: string; resultSummary: string };

export type AnalyzeResult = {
  runId: string;
  league: AgentLeague;
  modelId: string;
  picks: GradedPick[];
  // Number of picks the LLM proposed BEFORE the local grader filtered them.
  // Used by the orchestrator as the denominator for critic kill rate so the
  // metric isn't biased by grader rejections.
  rawAnalystPickCount: number;
  // Picks the grader rejected, with their failure notes. Surfaced so the
  // orchestrator can notify on silent drops — pre-2026-05-20 these vanished
  // without telemetry, masking model calibration drift.
  graderDropped: GraderDrop[];
  toolsUsed: ToolName[];
  rawResponseText: string;
  reasoningTrace: TraceStep[];
  iterations: number;
};

// ─── Prompts ───────────────────────────────────────────────────────────────

function systemPrompt(
  league: AgentLeague,
  memoryBlock: string,
  recordBlock: string,
  teamRecordsBlock: string,
  dreamBlock: string
): string {
  return `You are a sharp, disciplined sports-betting analyst working on ${league}.

Your recent record:
${recordBlock}

Per-team recent results (last 14 days, moneyline only):
${teamRecordsBlock}

Latest dream consolidation:
${dreamBlock}

Your job: produce a small ranked list of bets for today's slate, each with explicit reasoning, EV, and an invalidation level. Quality over quantity. Pass on slates with no edge.

You have tools that read today's odds, in-house model probabilities, injuries, player props, league trend summaries, a deterministic prop projector, and your own consolidated memory from prior runs. Always start by calling tools — never invent numbers. Call multiple tools in parallel when independent.

═══ REQUIRED FIRST STEP ═══
Before any other tool call, you MUST call get_dream_memory(). This returns the active rules consolidated by your weekly dream-self plus the latest dream notes. The critic will audit your reasoning trace — if get_dream_memory is missing from your tool calls, the critic will kill ALL your picks. This is not optional.

After get_dream_memory, also call get_team_recent_records() before producing any moneyline pick — it surfaces teams you've been cold on so you don't repeat the same losing read.

You can produce TWO kinds of picks: moneyline picks and player-prop picks. Different rules apply to each.

═══ INJURIES (REQUIRED for every game you evaluate) ═══
Before committing to ANY moneyline or prop pick on a game, call get_injuries(league, teams=[homeTeam, awayTeam]) for THAT matchup, using the full team names from get_odds. It returns only the two teams' decision-relevant players (OUT / DOUBTFUL / IL / QUESTIONABLE), worst-first, plus a keyAbsences list of OUT/IL players.
- A key player OUT or on the IL must move your modelProb. If a team's best player (or, in MLB, a relevant reliever) is OUT/IL, lower that team's win probability and SAY SO in your thesis (cite the player + status from keyAbsences).
- If the slate-scoped injury feed shows nothing for both teams, state that you checked and found no material absences — don't silently skip the step. The critic audits whether you called get_injuries with the matchup's teams and whether your thesis reflects the absences it returned.

═══ QUANT DESK ALIGNMENT (MLB only) ═══
For any MLB game you're evaluating, call get_quant_desk_analysis({league:"MLB"}) alongside get_odds and get_model_probabilities — it shows what the deterministic quant desk model has already flagged.

The quant desk is a separate, code-only Benter/Benham/Bloom engine: model fair value → 3% edge floor → sharp-direction agreement (Pinnacle de-vig) → ¼-Kelly. It's a corroborating signal, not a replacement for your analysis.

Reading the result:
- openPlays: Live open bets the desk placed on today's slate. Each has matchup, selection, edge (modelFairProb − devigMarketProb), modelFairProb, and priceAmerican. These cleared 3% + sharp-direction agreement — the deterministic model sees mispricing here.
- recentStats: The desk's CLV track record. If clvBeatRatePct ≥55% and avgClvProbPoints ≥+0.45pp at settledCount ≥50, the model is demonstrably getting edge vs the close; weight open plays more heavily.

How to use it:
1. A quant desk open play on a game you were already leaning toward is STRONG corroborating evidence — mention the desk's edge in your thesis.
2. A quant desk open play on a game you hadn't planned to pick is worth evaluating — don't pick it on the flag alone, but do check model probs and injuries.
3. Zero open plays is a mild bearish signal for the MLB slate — don't force a pick, but your tools can still surface edge the deterministic model missed (the analyst uses injury + form adjustments the static model doesn't have).
4. You CANNOT substitute quant desk edge for your own modelProb. You still MUST call get_model_probabilities(MLB) and get_injuries for any game you pick.

═══ MONEYLINE PICKS (market = "moneyline") ═══
- Only recommend a bet if your modelProb exceeds the market's implied prob by ≥ 6% (600 bps). This clears the vig (~2-5%) plus a safety margin. Edges below 6% are net-negative after juice. Otherwise pass.
- **Always use the BEST PRICE across books, not consensus.** get_odds returns bestPrice.{home,away}.{book,american,impliedProb}. Set oddsAmerican = bestPrice.american and marketProb = bestPrice.impliedProb. Mention the book in your signals (e.g. "best line: DraftKings +145").
- If bookSpread.{home|away} > 15 cents, that's a strong off-market signal — highlight in your thesis.
- Use 1/4 Kelly for stake sizing, capped at 2 units. Kelly = (b·p - q)/b where b = decimal odds - 1, p = modelProb, q = 1-p.
- Required fields: matchup, market="moneyline", selection (a team name), oddsAmerican, modelProb, marketProb, edge, kellyStakeUnits, confidence (1-100), thesis (≥80 chars), invalidation (one sentence), signals (array; first signal = "best line: BOOK PRICE"), gameTime (ISO 8601 from commence_time), eventId (from get_odds).

═══ PROP PICKS (market = "prop") — NBA, MLB + WNBA ═══
**modelProb for a prop MUST come from the get_prop_projection tool. Never invent a modelProb from reasoning alone — LLMs are not reliable at prop math.**
(WNBA props only appear once a WNBA props feed exists; until then get_player_props(WNBA) returns available:false and you simply skip props for WNBA — never fabricate one.)

Workflow:
1. Call get_player_props to see what props are available with their consensus lines + over/under prices. **For MLB, also call get_home_run_likes(MLB)** — it returns batter_home_runs OVER props whose de-vigged sharp (Pinnacle) fair prob already beats the soft book by the playable edge floor (evPct). A flagged HR like is a market-validated candidate: the sharp line says the soft book is mispricing the over. Consider these alongside get_player_props — a flagged HR like can become a prop pick.
2. For any prop you're considering — including a flagged HR like — call get_prop_projection(league, player, propType, line, side, opponent). It returns: projected, stddev, modelProb, nGames, rollingMean, opponentFactor, recentForm, notes. get_home_run_likes gives the SHARP-MARKET edge; get_prop_projection gives the modelProb. You need both: never ship an HR like on the board flag alone.
3. If get_prop_projection returns { available: false }, SKIP the prop. Do not back-fill with reasoning.
4. Set the pick's modelProb = projection.modelProb (verbatim, do not adjust). Set marketProb = the implied prob of the chosen side's price (americanToImplied: positive odds → 100/(odds+100); negative odds → -odds/(-odds+100)).
5. Apply the SAME ≥6% edge floor as moneyline picks. Most props will NOT have 6% edge — that's expected.
6. Use 1/4 Kelly capped at 2u, same as ML.

Required fields for a prop pick:
- matchup: "Player Team @ Opponent" or "Player vs Opponent" (so the game is identifiable)
- market: "prop"
- selection: human-readable, e.g. "Anthony Edwards OVER 27.5 pts"
- player: full display name as returned by get_player_props
- propType: the key from get_player_props (player_points, player_rebounds, batter_hits, etc.)
- line: numeric prop line
- side: "over" or "under"
- oddsAmerican: the price of the side you're picking (overPrice if side=over, underPrice if side=under)
- modelProb: VERBATIM from get_prop_projection
- marketProb: implied prob of your side's price
- edge: modelProb − marketProb
- kellyStakeUnits, confidence, thesis (mention opponentFactor + recentForm + any injury/usage angle), invalidation, signals (include "projection: X.X over/under L (n=N games)"), gameTime, eventId (from get_odds)

Use thesis to explain WHY you're picking this prop — what changed (opponent matchup, recent form, role change, injury filling minutes, FanGraphs xwOBA gap, FB velocity bump). The projection number alone is not a thesis.

Prop-specific risk: at most one prop per player per slate. Avoid stacking high-correlation legs (e.g. Anthony Edwards' points + Anthony Edwards' rebounds — these are correlated).

═══ COMMON RULES (both pick types) ═══
- Round modelProb and marketProb to 4 decimals; round kellyStakeUnits to 2 decimals.
- Always copy gameTime exactly from the get_odds tool's commenceTime for that event. This is critical for grading.
- Always copy eventId exactly from the get_odds tool's eventId for that event. This distinguishes split doubleheaders (same teams, same day) so the right game gets graded.

═══ MEMORY RULES (HARD GUARDRAILS) ═══
Active rules from prior weekly dream consolidations:
${memoryBlock}

Enforcement (the critic checks this):
- Rules with **weight ≥ 0.5** are HARD GUARDRAILS. If you produce a pick that matches a hard rule, either drop the pick OR include in your thesis: (a) the rule id you're overriding, and (b) a SPECIFIC, evidence-backed reason why today's data overrides it. Generic statements ("today is different", "the matchup is favorable") are NOT acceptable overrides — the critic will kill those picks.
- Rules with weight 0.3-0.5 are soft signals. Weight your thesis accordingly but no override justification required.
- If a rule references a per-team pattern (e.g. "Pistons are cold as heavy chalk") and the team-records tool confirms it, that's compound evidence — be especially careful.

When you are done analyzing, return ONLY a JSON object on the final assistant turn with this exact shape — no prose, no markdown fences:
{ "picks": [ ...AnalystPick objects... ] }

If you find no qualifying bets, return { "picks": [] }.`;
}

const MAX_ITERATIONS = 8;

// ─── Analyst run ───────────────────────────────────────────────────────────

export async function analyze(league: AgentLeague): Promise<AnalyzeResult> {
  if (!isInScope(league)) {
    throw new Error(`analyze: league ${league} is out of scope (allowed: NBA, MLB, WNBA)`);
  }

  const client = getAnthropic();
  const runId = `run_${crypto.randomBytes(8).toString("hex")}`;

  // Pull all per-run state (memory rules, latest dream notes, team records,
  // recent record) once up front. These get passed to the LLM via the system
  // prompt AND injected into the get_dream_memory / get_team_recent_records
  // tool handlers — so the analyst sees them in two places and the critic
  // can audit which tools were actually called.
  const [memories, record, latestDream, teamRecords] = await Promise.all([
    getActiveMemoriesForScope(league),
    getRecentRecord(league, 7),
    getLatestDreamSummary(),
    getRecentResultsByTeam(league, 14),
  ]);

  const sys = systemPrompt(
    league,
    formatMemoriesForPrompt(memories),
    formatRecordForPrompt(record),
    formatTeamRecordsForPrompt(teamRecords),
    latestDream?.notes
      ? `Dream ${latestDream.startedAt.slice(0, 10)} reviewed ${latestDream.picksReviewed} picks (added ${latestDream.memoriesAdded}, retired ${latestDream.memoriesRetired}). Notes: ${latestDream.notes}`
      : "(no completed dream consolidation yet)"
  );

  const toolHandlers = buildToolHandlers({
    activeMemories: memories,
    latestDream,
    teamRecords,
  });

  const messages: Array<{
    role: "user" | "assistant";
    content: unknown;
  }> = [
    {
      role: "user",
      content: `Analyze today's ${league} slate and return your picks as JSON.`,
    },
  ];

  const toolsUsed: ToolName[] = [];
  const reasoningTrace: TraceStep[] = [];
  let iterations = 0;
  let finalText = "";

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    const response = await client.messages.create({
      model: MODELS.analyst,
      max_tokens: 4096,
      system: sys,
      tools: TOOL_DEFINITIONS,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: messages as any,
    });

    // Push assistant turn so the next iteration sees it
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "tool_use") {
      // Capture any inter-turn narrative the analyst wrote before invoking tools
      for (const block of response.content) {
        if (block.type === "text" && block.text.trim()) {
          reasoningTrace.push({ kind: "reasoning", text: block.text.slice(0, 800) });
        }
      }

      const toolResults: Array<{
        type: "tool_result";
        tool_use_id: string;
        content: string;
      }> = [];

      for (const block of response.content) {
        if (block.type === "tool_use") {
          const name = block.name as ToolName;
          toolsUsed.push(name);
          reasoningTrace.push({
            kind: "tool_call",
            name,
            argsSummary: JSON.stringify(block.input ?? {}).slice(0, 300),
          });
          const handler = toolHandlers[name];
          let result: unknown = { error: `unknown tool: ${name}` };
          if (handler) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              result = handler(block.input as any);
            } catch (err) {
              result = { error: err instanceof Error ? err.message : String(err) };
            }
          }
          const serialized = JSON.stringify(result);
          reasoningTrace.push({
            kind: "tool_result",
            name,
            resultSummary: serialized.slice(0, 1500),
          });
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: serialized.slice(0, 200_000),
          });
        }
      }

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // Final turn — collect text
    for (const block of response.content) {
      if (block.type === "text") finalText += block.text;
    }
    break;
  }

  const parsed = parsePicks(finalText);
  const graded = gradePicksWithDrops(parsed);

  // NOTE: persistence intentionally moved to the orchestrator's persistFinalPicks()
  // call, which runs AFTER the critic + bankroll guard. This prevents picks the
  // critic killed (or bankroll dropped) from polluting the dream agent's
  // training data and the dashboard's pick count.
  return {
    runId,
    league,
    modelId: MODELS.analyst,
    picks: graded.kept,
    rawAnalystPickCount: parsed.length,
    graderDropped: graded.dropped,
    toolsUsed,
    rawResponseText: finalText,
    reasoningTrace,
    iterations,
  };
}

// Persist the final picks (post-critic, post-bankroll). Idempotent across
// retries via @@unique([league, gameDate, market, selection]) — duplicate
// inserts are silently skipped. Counts of inserted vs skipped returned for
// observability.
export async function persistFinalPicks(args: {
  runId: string;
  league: string;
  finalPicks: GradedPick[];
  toolsUsed: ToolName[];
}): Promise<{ ids: number[]; skipped: number; skippedNoGameTime: number }> {
  const ids: number[] = [];
  let skipped = 0;
  let skippedNoGameTime = 0;
  for (const p of args.finalPicks) {
    // gameDate is load-bearing: the autograder's 36h proximity match and CLV's
    // tip-window both key off it, and it's part of the @@unique idempotency key.
    // A missing-gameTime pick used to be pinned to today UTC-noon, which could
    // collide two genuinely different games on the unique key (dropping one as a
    // false idempotent skip) and mis-target the grader. An ungradeable pick is
    // worse than a missing one, so we refuse to persist it and count it instead.
    let gameDate: Date;
    if (p.gameTime) {
      const parsed = new Date(p.gameTime);
      if (Number.isFinite(parsed.getTime())) {
        gameDate = parsed;
      } else {
        console.warn(`persistFinalPicks: pick has invalid gameTime (${p.gameTime}), skipping: ${p.matchup}`);
        skippedNoGameTime++;
        continue;
      }
    } else {
      console.warn(`persistFinalPicks: pick missing gameTime, skipping: ${p.matchup}`);
      skippedNoGameTime++;
      continue;
    }
    try {
      const created = await prisma.agentPick.create({
        data: {
          runId: args.runId,
          league: args.league,
          gameDate,
          eventId: deriveEventId(p, gameDate),
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
          signals: JSON.stringify(p.signals),
          toolsUsed: JSON.stringify(args.toolsUsed),
          modelId: MODELS.analyst,
          // Prop-only structured fields; null for moneyline picks. The
          // autograder reads these to look up the player's box-score line.
          player: p.market === "prop" ? p.player ?? null : null,
          propType: p.market === "prop" ? p.propType ?? null : null,
          line: p.market === "prop" ? p.line ?? null : null,
          side: p.market === "prop" ? p.side ?? null : null,
        },
      });
      ids.push(created.id);
    } catch (err) {
      // Idempotency working as intended: a duplicate pick from a re-run.
      // Prisma's classic engine surfaces this as P2002, but the libSQL
      // adapter often passes through the raw SQLite ConnectorError without
      // mapping to user_facing_error — so we also string-match the message.
      const code = (err as { code?: string })?.code;
      const message = err instanceof Error ? err.message : String(err);
      if (code === "P2002" || /UNIQUE constraint failed/i.test(message)) {
        skipped++;
        continue;
      }
      throw err;
    }
  }
  return { ids, skipped, skippedNoGameTime };
}

// Derive a stable per-game id for a pick. Prefers the analyst-copied Odds API
// event.id, which uniquely identifies a game and so distinguishes split
// doubleheaders that share a matchup AND a commence_time. When absent, falls
// back to a deterministic synthetic id from normalized matchup + game time, so
// cross-run idempotency still holds for ordinary games (same game → same id
// across reruns; distinct-time doubleheaders → distinct ids). The only case
// this synthetic cannot separate is two games with identical matchup AND
// identical commence_time and no model-supplied eventId — which the prompt
// makes the analyst supply. Exported for testing.
export function deriveEventId(
  pick: { eventId?: string; matchup: string },
  gameDate: Date,
): string {
  const fromModel = pick.eventId?.trim();
  if (fromModel) return fromModel;
  const normMatchup = pick.matchup
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");
  return `syn:${normMatchup}@${gameDate.toISOString()}`;
}

// Strip optional ```json fences and parse
function parsePicks(text: string): AnalystPick[] {
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  // Find first '{' to last '}' to isolate JSON if model added stray text
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) cleaned = cleaned.slice(first, last + 1);

  try {
    const parsed = JSON.parse(cleaned) as { picks?: AnalystPick[] };
    return Array.isArray(parsed.picks) ? parsed.picks : [];
  } catch {
    return [];
  }
}
