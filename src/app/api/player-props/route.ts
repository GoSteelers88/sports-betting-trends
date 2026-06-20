import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { assessFreshness, MAX_AGE_HOURS } from "@/lib/data-freshness";

export const dynamic = "force-dynamic";

export async function GET() {
  const filePath = path.join(process.cwd(), "data", "processed", "latest-player-props.json");
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({
      ready: false,
      available: false,
      stale: false,
      generatedAt: null,
      topProps: [],
      note: "Player props file not found. Run npm run ingest:props.",
    });
  }
  // Parse defensively — a corrupt/half-written file previously threw an
  // unhandled exception and returned a raw 500 with a stack trace. Now a parse
  // failure degrades to an honest "not available" instead of leaking internals.
  let data: { available?: boolean; generatedAt?: string | null; topProps?: unknown[] };
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (e) {
    return NextResponse.json(
      {
        ready: false,
        available: false,
        stale: true,
        generatedAt: null,
        topProps: [],
        note: `Player props file unreadable: ${(e as Error).message}`,
      },
      { status: 200 },
    );
  }

  // FRESHNESS: the legacy props feed has gone stale before. Stamp the response
  // with age + a `stale` flag so a consumer never mistakes an old snapshot for
  // a live one. A stale file is also flipped to `available: false` so the
  // dashboard's existing `available` gate hides it rather than rendering
  // month-old prop "picks" as today's.
  const freshness = assessFreshness(data.generatedAt ?? null, MAX_AGE_HOURS.PROPS_QUOTE);
  return NextResponse.json({
    ...data,
    available: !!data.available && freshness.isFresh,
    stale: !freshness.isFresh,
    ageHours: freshness.ageHours,
    freshnessStatus: freshness.status,
  });
}
