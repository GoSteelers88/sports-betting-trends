export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { autoGradeYesterday } from "@/lib/agent/autograder";
import { notifyGraderReport } from "@/lib/agent/notify";
import { assertCronAuth } from "@/lib/assertCronAuth";
import { pruneRateLimits } from "@/lib/chat/guards";

export async function POST(req: NextRequest) {
  const authError = assertCronAuth(req);
  if (authError) return authError;

  try {
    const report = await autoGradeYesterday();
    await notifyGraderReport(report);
    // Housekeeping: drop expired chat rate-limit rows. Best-effort and
    // deliberately AFTER the grader report — a pruning failure must never cost
    // us the grading run, and pruneRateLimits swallows its own errors.
    const pruned = await pruneRateLimits();
    return NextResponse.json({ ...report, chatRateLimitRowsPruned: pruned });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export const GET = POST;
