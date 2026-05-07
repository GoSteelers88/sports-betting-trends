export const dynamic = "force-dynamic";

import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

function authOk(req: NextRequest, secret: string): boolean {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const a = Buffer.from(auth.slice(7));
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }
  if (!authOk(req, cronSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const hookUrl = process.env.VERCEL_DEPLOY_HOOK_URL;
  if (!hookUrl) {
    return NextResponse.json({ error: "VERCEL_DEPLOY_HOOK_URL not set" }, { status: 500 });
  }
  // Validate the hook URL is actually a Vercel deploy hook — prevents SSRF
  // pivots via env-poisoning (defense in depth).
  if (!/^https:\/\/api\.vercel\.com\/v1\/integrations\/deploy\//.test(hookUrl)) {
    return NextResponse.json({ error: "VERCEL_DEPLOY_HOOK_URL invalid" }, { status: 500 });
  }

  const hookResponse = await fetch(hookUrl, { method: "POST" });

  return NextResponse.json(
    { triggered: true, hookStatus: hookResponse.status },
    { status: 200 },
  );
}
