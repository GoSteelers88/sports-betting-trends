// Client IP resolution for the chat rate limiters. Shared by POST /api/chat and
// GET /api/chat/session so the two can never key their counters differently —
// if they disagreed, the cookieless budget and the mint budget would be tracking
// two different notions of "this caller".
//
// Header order matters, and it is a trust ordering, not a preference:
//
//   1. x-vercel-forwarded-for — set by Vercel's edge from the real connecting
//      socket. A client cannot forge it; the platform overwrites whatever was
//      sent. This is the only header here that is trustworthy on its own.
//   2. x-forwarded-for — also overwritten by Vercel's edge in production, so it
//      is equally good there. We take the FIRST entry, which is the client
//      position: correct behind Vercel, and the standard convention elsewhere.
//      Behind a proxy that APPENDS rather than overwrites, this entry is
//      client-supplied and therefore spoofable — which is exactly why the
//      durable counters below it are also backed by the global spend ceiling.
//   3. x-real-ip — single-value fallback for non-Vercel hosting.
//
// "unknown" is a real bucket, not a bypass: every caller we cannot identify
// shares one counter, so an un-attributable flood throttles itself.

import type { NextRequest } from "next/server";

export function clientIp(req: NextRequest): string {
  const vercel = req.headers.get("x-vercel-forwarded-for")?.trim();
  if (vercel) return vercel.split(",")[0]?.trim() || "unknown";

  const fwd = req.headers.get("x-forwarded-for") ?? "";
  const first = fwd.split(",")[0]?.trim();
  return first || req.headers.get("x-real-ip")?.trim() || "unknown";
}
