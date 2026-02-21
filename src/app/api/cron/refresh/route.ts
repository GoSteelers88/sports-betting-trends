export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }

  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const hookUrl = process.env.VERCEL_DEPLOY_HOOK_URL;
  if (!hookUrl) {
    return NextResponse.json({ error: "VERCEL_DEPLOY_HOOK_URL not set" }, { status: 500 });
  }

  const hookResponse = await fetch(hookUrl, { method: "POST" });

  return NextResponse.json(
    { triggered: true, hookStatus: hookResponse.status },
    { status: 200 },
  );
}
