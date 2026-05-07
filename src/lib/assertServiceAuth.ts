// Constant-time bearer-token check for protected API routes.

import crypto from "node:crypto";

export function assertServiceAuth(req: Request): Response | null {
  const secret = process.env.ASSISTANT_SECRET;
  if (!secret) return new Response("Server misconfigured", { status: 500 });
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return new Response("Unauthorized", { status: 401 });
  }
  const provided = Buffer.from(auth.slice(7));
  const expected = Buffer.from(secret);
  if (provided.length !== expected.length) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!crypto.timingSafeEqual(provided, expected)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null; // pass
}
