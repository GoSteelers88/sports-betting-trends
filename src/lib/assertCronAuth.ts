// Constant-time bearer-token check for cron-protected API routes.
// Reads CRON_SECRET (separate from ASSISTANT_SECRET used for agent endpoints).

import crypto from "node:crypto";

const MAX_HEADER_LEN = 4096;

export function assertCronAuth(req: Request): Response | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return new Response("Server misconfigured", { status: 500 });
  const auth = req.headers.get("authorization") ?? "";
  if (auth.length > MAX_HEADER_LEN) return new Response("Unauthorized", { status: 401 });
  if (!auth.startsWith("Bearer ")) return new Response("Unauthorized", { status: 401 });
  const provided = Buffer.from(auth.slice(7));
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!crypto.timingSafeEqual(provided, expected)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}
