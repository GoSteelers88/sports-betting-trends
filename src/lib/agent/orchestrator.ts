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
import { analyze, persistFinalPicks } from "./analyst";
import { critique, applyCritiqueToPicks, type CritiqueResult } from "./critic";
import { applyBankrollGuard, type BankrollGuardResult } from "./bankroll";
import { notifyPicks } from "./notify";
import type { GradedPick } from "./grader";
import type { AgentLeague } from "./tools";
import { prisma } from "@/lib/prisma";

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
- "model file …" / "model has 0 games" → ingest:nba-efficiency (NBA) or ingest:mlb-model (MLB; also requires ingest:mlb-pitchers, ingest:mlb-bullpen, ingest:mlb-batting if those are also flagged)
- "injury file …" → ingest:injuries

Respond with a brief plain-text summary at the end (1-3 sentences). The picks themselves are returned out-of-band — your text is just for the run log.`;

const TOOL_DEFS = [
  {
    name: "check_data_health",
    description: "Check freshness and sanity of odds/model/injury snapshots for a league. Pure code, no API cost.",
    input_schema: {
      type: "object" as const,
      properties: { league: { type: "string", enum: ["NBA", "MLB", "NCAAB"] } },
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
      properties: { league: { type: "string", enum: ["NBA", "MLB", "NCAAB"] } },
      required: ["league"],
    },
  },
];

const MAX_ITERATIONS = 8;

export async function orchestrate(league: AgentLeague): Promise<OrchestratorResult> {
  const client = getAnthropic();
  const runId = `orc_${crypto.randomBytes(8).toString("hex")}`;
  const trace: OrchestratorTrace[] = [];

  // State the orchestrator's "delegate_to_analyst" tool actually populates
  let analystPicks: GradedPick[] | null = null;
  let analystRunId: string | null = null;
  let analystToolsUsed: string[] = [];

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
              trace.push({
                step: "delegate_to_analyst",
                detail: { runId: out.runId, picks: out.picks.length, tools: out.toolsUsed, iterations: out.iterations },
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
    critique_ = await critique(league, analystPicks);
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
    } else {
      const afterCritique = applyCritiqueToPicks(analystPicks, critique_.decisions);
      killed = afterCritique.killed;
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

  // Persist ONLY the post-pipeline survivors. Killed/dropped picks never reach
  // the DB, so they don't pollute dream training data or the dashboard count.
  // If persistence fails, we DO NOT send the Discord notification — picks
  // shown in Discord but missing from the DB would break grading.
  let persistOk = false;
  if (finalPicks.length > 0) {
    try {
      const persistResult = await persistFinalPicks({
        runId: analystRunId ?? runId,
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
    }
  } else {
    persistOk = true; // nothing to persist — proceed to notify "no picks"
  }

  // Discord notification: only send if persistence worked. A failed persist
  // means picks shown in chat but missing from DB → grading divergence.
  if (persistOk) {
    await notifyPicks(league, finalPicks, runId);
  } else {
    trace.push({
      step: "discord_skipped",
      detail: "persistence failed — refusing to broadcast unpersisted picks",
      at: new Date().toISOString(),
    });
  }

  // Persist run-level metadata so the dashboard can compute critic kill rate
  // and other paper-trial criteria. Failure is non-fatal — picks already
  // landed; this is just observability.
  try {
    const weakened = critique_.decisions.filter(d => d.verdict === "weaken").length;
    await prisma.agentRun.create({
      data: {
        runId: analystRunId ?? runId,
        league,
        rawAnalystPicks: analystPicks?.length ?? 0,
        graderKept: analystPicks?.length ?? 0,
        criticKilled: killed.length,
        criticWeakened: weakened,
        bankrollDropped: dropped.length,
        finalPickCount: finalPicks.length,
        totalUnits: +finalPicks.reduce((s, p) => s + p.kellyStakeUnits, 0).toFixed(2),
        bankrollFlags: JSON.stringify(flags),
        parseFailed: critique_.parseFailed === true,
        persistOk,
        modelId: MODELS.analyst,
      },
    });
    trace.push({ step: "persist_run", detail: "ok", at: new Date().toISOString() });
  } catch (err) {
    // P2002 means duplicate runId — re-run of same orchestrator session.
    // Other errors get logged but don't block the response.
    const code = (err as { code?: string })?.code;
    trace.push({
      step: code === "P2002" ? "persist_run_duplicate" : "persist_run_failed",
      detail: err instanceof Error ? err.message : String(err),
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
