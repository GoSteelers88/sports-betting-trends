// Signed session identity for "The Sharp" chat. The session id is a random
// UUID, HMAC-signed with a server secret so the per-session message cap can't
// be reset by a client editing the cookie. No durable storage — the id only
// keys an in-memory abuse window and is forgotten when that window expires.
//
// We DON'T store any user message under this id. It is purely a rate-limit
// handle (Hickey: the state is narrow, explicit, and owned in one place).

import crypto from "node:crypto";
import { getOptionalEnv } from "@/lib/server-env";

export const SESSION_COOKIE = "sharp_sid";

// Use a dedicated secret if set, else fall back to CRON_SECRET (already a
// required server secret in this repo). Never hardcoded.
function sessionSecret(): string {
  return (
    getOptionalEnv("CHAT_SESSION_SECRET") ??
    getOptionalEnv("CRON_SECRET") ??
    getOptionalEnv("ASSISTANT_SECRET") ??
    // Last-resort dev fallback so local runs work without extra env. NOT used
    // when any of the above are present (which they are in every deployed env).
    "dev-only-sharp-session-secret"
  );
}

function sign(id: string): string {
  return crypto.createHmac("sha256", sessionSecret()).update(id).digest("hex");
}

// Mint a fresh signed session token: "<uuid>.<hmac>".
export function mintSession(): string {
  const id = crypto.randomUUID();
  return `${id}.${sign(id)}`;
}

// Verify a cookie value, returning the bare session id if the signature checks
// out (timing-safe), else null. A null result means "mint a new one".
export function verifySession(token: string | undefined | null): string | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = sign(id);
  // Length check before timingSafeEqual (it throws on length mismatch).
  if (sig.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return id;
}

// Cookie attributes, shared by every issuer so the mint endpoint and the chat
// route can never drift apart on scope or lifetime.
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60 * 24, // 1 day — matches the per-session abuse window
} as const;

// DELIBERATELY REMOVED: resolveSession().
//
// It took an incoming cookie and, when the cookie was absent or invalid, minted
// a brand-new signed id INLINE and returned it as though it were an established
// identity. Because the per-session rate limiter admits any first-seen key, a
// client that simply never sent a cookie got a fresh identity on every request
// and the session cap could never fire — the HMAC stopped cookie *tampering*
// while cookie *omission* walked straight past it.
//
// Identity is now issued in one place only (GET /api/chat/session, itself
// per-IP capped) and the chat route VERIFIES rather than resolves. A request
// with no valid cookie is not given a free identity; it is charged against the
// cookieless per-IP budget. Do not reintroduce a mint-on-read helper.
