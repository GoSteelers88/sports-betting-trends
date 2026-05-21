export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { captureClv } from "@/lib/clv-tracker";
import { assertCronAuth } from "@/lib/assertCronAuth";

// Pre-tip-off CLV capture. Designed for ad-hoc / manual invocations.
//
// The primary production path is the agent-clv.yml GitHub Action, which
// scrapes FanDuel + Bovada immediately before each capture. This route
// reads the same scraped files (data/processed/latest-odds-api-*.json) and
// will warn if they're stale (>30 min old).
//
// Scraped odds become in-play prices after commence_time, which would give
// a structurally negative CLV — so the default window is `[10, 90]` minutes
// pre-tip-off. Pass ?min=&max= query params to override for ad-hoc backfills.
export async function POST(req: NextRequest) {
  const authError = assertCronAuth(req);
  if (authError) return authError;

  const url = new URL(req.url);
  const minParam = url.searchParams.get("min");
  const maxParam = url.searchParams.get("max");
  const minBeforeStart = minParam ? parseInt(minParam, 10) : undefined;
  const maxBeforeStart = maxParam ? parseInt(maxParam, 10) : undefined;

  try {
    const result = await captureClv({ minBeforeStart, maxBeforeStart });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}

export const GET = POST;
