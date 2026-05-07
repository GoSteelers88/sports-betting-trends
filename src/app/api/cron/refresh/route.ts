export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { assertCronAuth } from "@/lib/assertCronAuth";

export async function POST(req: NextRequest) {
  const authError = assertCronAuth(req);
  if (authError) return authError;

  const hookUrl = process.env.VERCEL_DEPLOY_HOOK_URL;
  if (!hookUrl) {
    return NextResponse.json({ error: "VERCEL_DEPLOY_HOOK_URL not set" }, { status: 500 });
  }
  // Defense-in-depth SSRF: validate the hook URL is actually a Vercel deploy hook.
  if (!/^https:\/\/api\.vercel\.com\/v1\/integrations\/deploy\//.test(hookUrl)) {
    return NextResponse.json({ error: "VERCEL_DEPLOY_HOOK_URL invalid" }, { status: 500 });
  }

  const hookResponse = await fetch(hookUrl, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
  });

  return NextResponse.json(
    { triggered: true, hookStatus: hookResponse.status },
    { status: 200 },
  );
}
