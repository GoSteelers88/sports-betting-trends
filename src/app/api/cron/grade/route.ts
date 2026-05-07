export const dynamic = "force-dynamic";
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { autoGradeYesterday } from "@/lib/agent/autograder";
import { notifyGraderReport } from "@/lib/agent/notify";
import { assertCronAuth } from "@/lib/assertCronAuth";

export async function POST(req: NextRequest) {
  const authError = assertCronAuth(req);
  if (authError) return authError;

  try {
    const report = await autoGradeYesterday();
    await notifyGraderReport(report);
    return NextResponse.json(report);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export const GET = POST;
