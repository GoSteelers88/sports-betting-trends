export const dynamic = "force-dynamic";
// Vercel Hobby caps at 300s. Note: this route's orchestrator uses spawnSync
// to run npm ingest scripts, which won't work on Vercel serverless. The real
// schedule lives in .github/workflows/agent-run.yml. This HTTP entry point
// only works locally / in environments with shell access.
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { assertServiceAuth } from "@/lib/assertServiceAuth";
import { orchestrate } from "@/lib/agent/orchestrator";
import type { AgentLeague } from "@/lib/agent/tools";

const ALLOWED: AgentLeague[] = ["NBA", "MLB", "NCAAB"];

export async function POST(req: NextRequest) {
  const authError = assertServiceAuth(req);
  if (authError) return authError;

  let body: { league?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const league = (body.league ?? "").toUpperCase() as AgentLeague;
  if (!ALLOWED.includes(league)) {
    return NextResponse.json(
      { error: `league must be one of ${ALLOWED.join(", ")}` },
      { status: 400 }
    );
  }

  try {
    const result = await orchestrate(league);
    return NextResponse.json({
      runId: result.runId,
      league: result.league,
      finalPicks: result.finalPicks,
      rawAnalystPickCount: result.rawAnalystPickCount,
      analystRunId: result.analystRunId,
      killedByCriticCount: result.killedByCritic.length,
      droppedByBankrollCount: result.droppedByBankroll.length,
      bankrollFlags: result.bankrollFlags,
      totalUnits: result.totalUnits,
      trace: result.trace,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
