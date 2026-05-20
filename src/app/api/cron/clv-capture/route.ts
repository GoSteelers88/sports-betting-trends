export const dynamic = "force-dynamic";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { captureClv } from "@/lib/clv-tracker";
import { assertCronAuth } from "@/lib/assertCronAuth";

// Pre-tip-off CLV capture. Fires every 5 minutes via Vercel Cron.
//
// The Odds API still returns h2h prices after a game starts, but those are
// in-play live prices, not the close. Capturing them gives a structurally
// negative CLV and corrupts the funding-gate signal — so we scan a tight
// window of "games starting in the next 2–12 minutes" and capture only
// those. At 5-min cadence with a 10-min window, each pick has two chances
// to be captured before going in-play.
//
// Default window is captureClv's default (2–12 min). Pass ?min=&max= query
// params to override for ad-hoc backfills (e.g. ?min=2&max=30 after a
// scheduler outage). Default cron schedule lives in vercel.json.
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
