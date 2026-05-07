export const dynamic = "force-dynamic";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { dream } from "@/lib/agent/dream";
import { assertCronAuth } from "@/lib/assertCronAuth";

export async function POST(req: NextRequest) {
  const authError = assertCronAuth(req);
  if (authError) return authError;

  try {
    const result = await dream();
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

// Vercel Cron only sends POST; we allow GET as a fallback for manual testing.
export const GET = POST;
