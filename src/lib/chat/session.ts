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

// Resolve the session id from an incoming cookie, minting a new signed token
// when absent/invalid. Returns both the bare id (for rate-limiting) and the
// token to set back on the response (null when the existing one was valid).
export function resolveSession(cookieValue: string | undefined | null): {
  id: string;
  setCookie: string | null;
} {
  const existing = verifySession(cookieValue);
  if (existing) return { id: existing, setCookie: null };
  const token = mintSession();
  const id = token.slice(0, token.lastIndexOf("."));
  return { id, setCookie: token };
}
