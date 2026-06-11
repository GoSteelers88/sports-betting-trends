// The conductor. Single Sonnet agent with three tools:
//   - check_data_health: pure-code freshness + sanity per league
//   - run_ingest: spawnSync wrapper around npm run ingest:* (90-min cooldown)
//   - delegate_to_analyst: runs our existing analyze() and returns picks
//
// After the analyst returns picks, the orchestrator runs the critic
// (devil's advocate) and bankroll guard locally — those are non-LLM steps in
// the orchestrator's view.
//
// Final return: the post-pipeline picks plus a structured trace of what was
// done.

import crypto from "node:crypto";
import { getAnthropic, MODELS } from "./client";
import { checkHealth, type DataHealth } from "./health";
import { runIngest, ALLOWED_SCRIPTS, type IngestScript, type IngestResult } from "./runners";
import { analyze, persistFinalPicks, type TraceStep } from "./analyst";
import { critique, applyCritiqueToPicks, type CritiqueResult } from "./critic";
import { applyBankrollGuard, type BankrollGuardResult } from "./bankroll";
import { notifyPicks, notifyError } from "./notify";
import type { GradedPick } from "./grader";
import { isInScope, type AgentLeague } from "./tools";
import { getActiveMemoriesForScope } from "./memory";
import { prisma } from "@/lib/prisma";

export class OutOfScopeLeagueError extends Error {
  constructor(league: string) {
    super(`league ${league} is out of scope (allowed: NBA, MLB)`);
    this.name = "OutOfScopeLeagueError";
  }
}

export type OrchestratorTrace = {
  step: string;
  detail: unknown;
  at: string;
};

export type OrchestratorResult = {
  runId: string;
  league: AgentLeague;
  finalPicks: GradedPick[];
  rawAnalystPickCount: number;
  analystRunId: string | null;
  analystToolsUsed: string[];
  killedByCritic: Array<{ pick: GradedPick; reason: string }>;
  droppedByBankroll: Array<{ pick: GradedPick; reason: string }>;
  bankrollFlags: string[];
  trace: OrchestratorTrace[];
  totalUnits: number;
};

const ORCHESTRATOR_SYSTEM = `You are the orchestrator for a sports-betting analysis pipeline. Your job is to ensure the analyst has fresh, complete data before delegating, and to skip running it when the data is unfixable.

Tools available:
- check_data_health(league): pure-code freshness/sanity. Returns staleReasons[]. CHEAP — call freely.
- run_ingest({ scripts }): runs npm scripts to refresh data. EXPENSIVE — each invocation has a 90-min cooldown and may consume Odds API quota. Only run scripts that the most recent health check actually flagged as needed.
- delegate_to_analyst({ league }): runs the analyst on currently available data. CALL EXACTLY ONCE per orchestrator run.

Operating procedure:
1. Call check_data_health(league) first.
2. If healthy, immediately delegate_to_analyst.
3. If stale, identify the minimum set of ingest scripts to fix the staleReasons. Call run_ingest with only those. Pay attention to skipped_cooldown — if a needed script is on cooldown, you cannot fix that issue this run.
4. Call check_data_health again to verify. If still stale despite the ingest, delegate anyway only if the staleness is minor (e.g. injuries 24h+ but not critical). For severe staleness (odds 12h+ that we couldn't refresh), return without delegating.
5. delegate_to_analyst. Then immediately respond with your final summary text — do not call more tools after delegate_to_analyst.

Map of staleReasons → ingest scripts:
- "odds file …" → ingest:odds
- "model file …" / "model has 0 games" → ingest:nba-efficiency + ingest:nba-model (NBA), or ingest:mlb-model (MLB; also requires ingest:mlb-pitchers, ingest:mlb-bullpen, ingest:mlb-batting if those are also flagged)
- "injury file …" → ingest:injuries

Respond with a brief plain-text summary at the end (1-3 sentences). The picks themselves are returned out-of-band — your text is just for the run log.`;

const TOOL_DEFS = [
  {
    name: "check_data_health",
    description: "Check freshness and sanity of odds/model/injury snapshots for a league. Pure code, no API cost.",
    input_schema: {
      type: "object" as const,
      properties: { league: { type: "string", enum: ["NBA", "MLB"] } },
      required: ["league"],
    },
  },
  {
    name: "run_ingest",
    description:
      "Run one or more npm ingest scripts to refresh data. Each script has a 90-min cooldown to protect API quota. Only run what's actually needed.",
    input_schema: {
      type: "object" as const,
      properties: {
        scripts: {
          type: "array",
          items: { type: "string", enum: [...ALLOWED_SCRIPTS] },
          minItems: 1,
        },
      },
      required: ["scripts"],
    },
  },
  {
    name: "delegate_to_analyst",
    description:
      "Hand off to the analyst agent. Returns the analyst's picks (already grader-checked). Call this exactly once after data is healthy.",
    input_schema: {
      type: "object" as const,
      properties: { league: { type: "string", enum: ["NBA", "MLB"] } },
      required: ["league"],
    },
  },
];

const MAX_ITERATIONS = 8;

export async function orchestrate(league: AgentLeague): Promise<OrchestratorResult> {
  if (!isInScope(league)) {
    await notifyError("orchestrate.outOfScope", `requested league=${league} is out of scope`, {
      league,
      allowed: ["NBA", "MLB"],
    });
    throw new OutOfScopeLeagueError(league);
  }

  const client = getAnthropic();
  const runId = `orc_${crypto.randomBytes(8).toString("hex")}`;
  const trace: OrchestratorTrace[] = [];

  // State the orchestrator's "delegate_to_analyst" tool actually populates
  let analystPicks: GradedPick[] | null = null;
  let analystRunId: string | null = null;
  let analystToolsUsed: string[] = [];
  let analystTrace: TraceStep[] = [];
  let rawAnalystPickCount = 0; // pre-grader count for accurate kill-rate denominator

  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [
    {
      role: "user",
      content: `Run the pipeline for ${league}. Today's date: ${new Date().toISOString().slice(0, 10)}.`,
    },
  ];

  let iterations = 0;
  let analystDone = false;

  while (iterations < MAX_ITERATIONS && !analystDone) {
    iterations++;
    const response = await client.messages.create({
      model: MODELS.analyst,
      max_tokens: 2048,
      system: ORCHESTRATOR_SYSTEM,
      tools: TOOL_DEFS,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: messages as any,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "tool_use") {
      const toolResults: Array<{ type: "tool_result"; tool_use_id: string; content: string }> = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;

        const name = block.name;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const input = block.input as any;
        let result: unknown;
        const at = new Date().toISOString();

        try {
          if (name === "check_data_health") {
            const health: DataHealth = checkHealth(input.league);
            trace.push({ step: "check_data_health", detail: health, at });
            result = health;
          } else if (name === "run_ingest") {
            const scripts = (input.scripts as string[]).filter((s): s is IngestScript =>
              (ALLOWED_SCRIPTS as readonly string[]).includes(s)
            );
            const results: IngestResult[] = [];
            for (const s of scripts) results.push(runIngest(s));
            trace.push({ step: "run_ingest", detail: results, at });
            result = results;
          } else if (name === "delegate_to_analyst") {
            if (analystPicks !== null) {
              result = { error: "delegate_to_analyst already called this run" };
            } else {
              const out = await analyze(input.league);
              analystPicks = out.picks;
              analystRunId = out.runId;
              analystToolsUsed = out.toolsUsed;
              analystTrace = out.reasoningTrace;
              rawAnalystPickCount = out.rawAnalystPickCount;

              // Notify on every grader drop so silent rejections show up in
              // Discord telemetry. Particularly important for "edge below
              // floor" drops where the analyst's claimed edge passed but the
              // recompute fell short — that's a model calibration signal,
              // not a routine filter.
              if (out.graderDropped.length > 0) {
                trace.push({
                  step: "grader_drops",
                  detail: out.graderDropped.map(d => ({
                    matchup: d.pick.matchup,
                    market: d.pick.market,
                    selection: d.pick.selection,
                    claimedEdge: d.pick.edge,
                    notes: d.notes,
                  })),
                  at,
                });
                await notifyError(
                  "grader.drops",
                  `analyst produced ${out.graderDropped.length} pick(s) the grader rejected`,
                  {
                    runId: out.runId,
                    league: input.league,
                    drops: out.graderDropped.map(d => ({
                      matchup: d.pick.matchup,
                      selection: d.pick.selection,
                      claimedEdge: +(d.pick.edge * 100).toFixed(2),
                      notes: d.notes.filter(n => n.startsWith("HARD:")),
                    })),
                  }
                );
              }

              trace.push({
                step: "delegate_to_analyst",
                detail: {
                  runId: out.runId,
                  rawAnalystPicks: out.rawAnalystPickCount,
                  graderKept: out.picks.length,
                  graderDropped: out.graderDropped.length,
                  tools: out.toolsUsed,
                  iterations: out.iterations,
                },
                at,
              });
              result = {
                runId: out.runId,
                pickCount: out.picks.length,
                picks: out.picks,
              };
              // Hard-stop the orchestrator loop after a successful analyst
              // delegation. The system prompt asks for this, but we don't
              // rely on LLM compliance for safety-critical control flow.
              analystDone = true;
            }
          } else {
            result = { error: `unknown tool: ${name}` };
          }
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
          trace.push({ step: `${name} (error)`, detail: result, at });
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result).slice(0, 200_000),
        });
      }
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // end_turn
    let finalText = "";
    for (const block of response.content) {
      if (block.type === "text") finalText += block.text;
    }
    trace.push({ step: "orchestrator_final_text", detail: finalText, at: new Date().toISOString() });
    break;
  }

  // Post-analyst pipeline (no more LLM tool calls in the orchestrator loop)
  let critique_: CritiqueResult = { decisions: [], rawText: "" };
  let killed: OrchestratorResult["killedByCritic"] = [];
  let dropped: BankrollGuardResult["dropped"] = [];
  let flags: string[] = [];
  let finalPicks: GradedPick[] = [];

  if (analystPicks && analystPicks.length > 0) {
    // Pass the same active memory rules to the critic so it can audit each
    // pick against them. The analyst's reasoning trace shows whether it
    // called get_dream_memory; the rules list lets the critic actually
    // judge compliance.
    const activeMemories = await getActiveMemoriesForScope(league);
    critique_ = await critique(league, analystPicks, analystTrace, activeMemories);
    trace.push({ step: "critic", detail: critique_, at: new Date().toISOString() });

    // Fail-closed: if critic JSON failed to parse (parseFailed flag set, or
    // empty decisions when there were picks to review), drop ALL picks rather
    // than auto-approving them. The critic is a safety layer; silent failure
    // = system disabled, not "everyone passes".
    if (critique_.parseFailed) {
      trace.push({
        step: "critic_failed_closed",
        detail: "critic JSON parse failed — dropping all picks (fail-closed)",
        at: new Date().toISOString(),
      });
      killed = analystPicks.map(p => ({ pick: p, reason: "critic JSON parse failure (fail-closed)" }));
      finalPicks = [];
      await notifyError("critic.parseFailed", "JSON parse failure", {
        runId,
        league,
        droppedPicks: analystPicks.length,
        rawText: critique_.rawText.slice(0, 400),
      });
    } else {
      const afterCritique = applyCritiqueToPicks(analystPicks, critique_.decisions);
      killed = afterCritique.killed;

      // Critic floor: if the analyst produced ≥3 grader-kept picks AND the
      // critic killed everything that survived the grader, the pipeline becomes
      // a brick wall. On weak slates this is fine, but losing every pick across
      // many runs in a row is more consistent with critic over-eagerness than
      // with the slate. As a safety net we rescue the highest-edge analyst pick
      // (only if it's at the 6%+ grader floor) at half stake, and tag it so the
      // dashboard and Discord show it was the floor pick rather than a normal
      // approval. Set CRITIC_FLOOR=off env var to disable. Threshold (3) chosen
      // to avoid kicking in on 1-2 pick slates which are noisier.
      const CRITIC_FLOOR_ENABLED = (process.env.CRITIC_FLOOR ?? "on").toLowerCase() !== "off";
      const CRITIC_FLOOR_MIN_RAW = 3;
      const CRITIC_FLOOR_STAKE_MULT = 0.5;
      if (
        CRITIC_FLOOR_ENABLED &&
        analystPicks.length >= CRITIC_FLOOR_MIN_RAW &&
        afterCritique.kept.length === 0 &&
        killed.length === analystPicks.length
      ) {
        const rescue = [...analystPicks].sort((a, b) => b.edge - a.edge)[0];
        if (rescue.edge >= 0.06) {
          const floored: GradedPick = {
            ...rescue,
            kellyStakeUnits: +(rescue.kellyStakeUnits * CRITIC_FLOOR_STAKE_MULT).toFixed(2),
            graderNotes: [
              ...rescue.graderNotes,
              `critic floor: rescued (×${CRITIC_FLOOR_STAKE_MULT}) — critic killed all ${analystPicks.length} picks`,
            ],
          };
          afterCritique.kept.push(floored);
          killed = killed.filter(k => k.pick !== rescue);
          trace.push({
            step: "critic_floor_engaged",
            detail: {
              rawPicks: analystPicks.length,
              rescued: { matchup: rescue.matchup, selection: rescue.selection, edge: rescue.edge, stake: floored.kellyStakeUnits },
            },
            at: new Date().toISOString(),
          });
          await notifyError(
            "critic.floorEngaged",
            `critic killed all ${analystPicks.length} picks — rescued highest-edge pick at ${CRITIC_FLOOR_STAKE_MULT}× stake`,
            { runId, league, matchup: rescue.matchup, selection: rescue.selection, edge: rescue.edge }
          );
        }
      }

      const guard = applyBankrollGuard(afterCritique.kept);
      trace.push({
        step: "bankroll_guard",
        detail: { kept: guard.kept.length, dropped: guard.dropped.length, flags: guard.flags, totalUnits: guard.totalUnits },
        at: new Date().toISOString(),
      });
      dropped = guard.dropped;
      flags = guard.flags;
      finalPicks = guard.kept;
    }
  } else {
    finalPicks = analystPicks ?? [];
  }

  // Persist run-level metadata FIRST, with persistOk=false. This is the fix for
  // the orphan-picks hole: the old order (picks, THEN run) could die mid-persist
  // and leave AgentPick rows with NO AgentRun row — silently desyncing the
  // kill-rate / sample-size denominators (the funding-gate math reads AgentRun).
  // Every count below is known before persistence; only persistOk flips after.
  // Writing the marker up front means any crash leaves a discoverable partial
  // run (persistOk=false) whose denominators already match the picks that land.
  const weakened = critique_.decisions.filter(d => d.verdict === "weaken").length;
  // When critic JSON parse fails we drop ALL picks defensively, but those aren't
  // real critic kills — track them separately so the kill-rate metric reflects
  // actual critic decisions.
  const realCriticKills = critique_.parseFailed ? 0 : killed.length;
  const agentRunRunId = analystRunId ?? runId;
  let agentRunExists = false;
  try {
    await prisma.agentRun.create({
      data: {
        runId: agentRunRunId,
        league,
        rawAnalystPicks: rawAnalystPickCount, // pre-grader count
        graderKept: analystPicks?.length ?? 0,
        criticKilled: realCriticKills,
        criticWeakened: weakened,
        bankrollDropped: dropped.length,
        finalPickCount: finalPicks.length,
        totalUnits: +finalPicks.reduce((s, p) => s + p.kellyStakeUnits, 0).toFixed(2),
        bankrollFlags: JSON.stringify(flags),
        parseFailed: critique_.parseFailed === true,
        persistOk: false,
        modelId: MODELS.analyst,
      },
    });
    agentRunExists = true;
    trace.push({ step: "persist_run", detail: "created (persistOk=false)", at: new Date().toISOString() });
  } catch (err) {
    // P2002 / UNIQUE means duplicate runId — re-run of the same session. The row
    // already exists, so picks can still (re)persist idempotently and we flip
    // persistOk below. Any other error is logged; we do NOT persist picks
    // without a run marker (that's the desync we're preventing).
    const code = (err as { code?: string })?.code;
    const message = err instanceof Error ? err.message : String(err);
    const isDup = code === "P2002" || /UNIQUE constraint failed/i.test(message);
    agentRunExists = isDup;
    trace.push({
      step: isDup ? "persist_run_duplicate" : "persist_run_failed",
      detail: message,
      at: new Date().toISOString(),
    });
    if (!isDup) {
      await notifyError("persistAgentRun", err, { runId, league });
    }
  }

  // Persist ONLY the post-pipeline survivors. Killed/dropped picks never reach
  // the DB, so they don't pollute dream training data or the dashboard count.
  // If persistence fails, we DO NOT send the Discord notification — picks shown
  // in Discord but missing from the DB would break grading — and we leave the
  // AgentRun marker at persistOk=false so the partial run is discoverable.
  let persistOk = false;
  if (!agentRunExists) {
    // No run marker landed (a non-duplicate AgentRun write failure). Refuse to
    // persist picks without it rather than recreate the orphan-row hole.
    trace.push({
      step: "persist_picks_skipped",
      detail: "no AgentRun marker — refusing to persist picks without it",
      at: new Date().toISOString(),
    });
  } else if (finalPicks.length > 0) {
    try {
      const persistResult = await persistFinalPicks({
        runId: agentRunRunId,
        league,
        finalPicks,
        toolsUsed: analystToolsUsed as Parameters<typeof persistFinalPicks>[0]["toolsUsed"],
      });
      persistOk = true;
      trace.push({
        step: "persist_picks",
        detail: { inserted: persistResult.ids.length, skipped_idempotent: persistResult.skipped },
        at: new Date().toISOString(),
      });
    } catch (err) {
      trace.push({
        step: "persist_picks_failed",
        detail: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString(),
      });
      await notifyError("persistFinalPicks", err, { runId, league, count: finalPicks.length });
    }
  } else {
    persistOk = true; // nothing to persist — proceed to notify "no picks"
  }

  // Commit the run marker: flip persistOk=true now that picks have landed.
  // updateMany keyed on runId is idempotent and a no-op if the row is somehow
  // missing. Failure here is non-fatal — picks already landed and the marker
  // exists; the trace records that the flip didn't take.
  if (persistOk && agentRunExists) {
    try {
      await prisma.agentRun.updateMany({
        where: { runId: agentRunRunId },
        data: { persistOk: true },
      });
      trace.push({ step: "persist_run_committed", detail: "persistOk=true", at: new Date().toISOString() });
    } catch (err) {
      trace.push({
        step: "persist_run_commit_failed",
        detail: err instanceof Error ? err.message : String(err),
        at: new Date().toISOString(),
      });
    }
  }

  // Discord notification: only send if persistence worked. A failed persist
  // means picks shown in chat but missing from DB → grading divergence.
  if (persistOk) {
    await notifyPicks(league, finalPicks, runId, killed.length);
  } else {
    trace.push({
      step: "discord_skipped",
      detail: "persistence failed — refusing to broadcast unpersisted picks",
      at: new Date().toISOString(),
    });
  }

  return {
    runId,
    league,
    finalPicks,
    rawAnalystPickCount: analystPicks?.length ?? 0,
    analystRunId,
    analystToolsUsed,
    killedByCritic: killed,
    droppedByBankroll: dropped,
    bankrollFlags: flags,
    trace,
    totalUnits: finalPicks.reduce((s, p) => s + p.kellyStakeUnits, 0),
  };
}
