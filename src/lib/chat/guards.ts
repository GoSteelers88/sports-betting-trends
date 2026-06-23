// The hard safety guards for "The Sharp" public chat endpoint.
//
// This is a PUBLIC endpoint spending real Anthropic tokens, so every guard here
// is load-bearing. The guards are pure (or DB-only) and decision-from-effect
// separated so they unit-test without the route or the model:
//   1. Body-size cap            — reject oversized payloads before any work.
//   2. Distress interceptor     — bypass the model entirely on at-risk phrasing.
//   3. Injection pre-filter     — flag known prompt-injection patterns.
//   4. Spend governor           — GLOBAL daily token ceiling (DB-backed) +
//                                 per-session + per-IP/day caps (in-memory).

import { prisma } from "@/lib/prisma";

// ─── Config (env-overridable; validated-with-fallback, never hardcoded URLs) ──

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Max request body size in bytes. A chat turn + a few recent turns is tiny;
// 4KB is generous and matches the cron header guard's 4096 ceiling.
export const MAX_BODY_BYTES = intFromEnv("CHAT_MAX_BODY_BYTES", 4096);

// GLOBAL daily token ceiling across ALL sessions/users. Sized for Haiku-heavy
// traffic with occasional Sonnet Lane-B turns. When the day's recorded usage
// meets/exceeds this, the desk is closed for the night.
export const DAILY_TOKEN_CEILING = intFromEnv("CHAT_DAILY_TOKEN_CEILING", 2_000_000);

// Per-session message cap (signed session cookie). 15 turns is plenty for a
// real question; beyond it is almost always abuse or a loop.
export const SESSION_MSG_CAP = intFromEnv("CHAT_SESSION_MSG_CAP", 15);

// Per-IP/day message cap. Coarse abuse mitigation keyed on x-forwarded-for.
export const IP_DAY_CAP = intFromEnv("CHAT_IP_DAY_CAP", 40);

// ─── 1. Body-size cap ────────────────────────────────────────────────────────

export function isBodyWithinLimit(rawBody: string): boolean {
  return Buffer.byteLength(rawBody, "utf8") <= MAX_BODY_BYTES;
}

// ─── 2. Distress-phrase interceptor ──────────────────────────────────────────
//
// BEFORE the model. If the message trips any of these, we bypass the model
// ENTIRELY and return the responsible-gambling message. NEVER a bet read. This
// is a human-safety guard first and a brand guard second — it must fail safe.

// Word-boundary patterns so we catch the harmful intent without nuking benign
// uses. Tuned for recall on real distress phrasings.
const DISTRESS_PATTERNS: RegExp[] = [
  /\brent\b/i,
  /\bcan'?t afford\b/i,
  /\bcannot afford\b/i,
  /\blosing streak\b/i,
  /\bon a (?:bad |brutal |cold )?(?:streak|skid)\b/i,
  /\bchase\b/i,
  /\bchasing\b/i,
  /\baddict/i,
  /\ball[\s-]?in\b/i,
  /\bborrow/i,
  /\bmy last\b/i,
  /\bmade back\b/i,
  /\bwin it (?:all )?back\b/i,
  /\bget(?:ting)? (?:it |my money )?back\b/i,
  /\bdebt\b/i,
  /\bgambling problem\b/i,
  /\bmaxed out\b/i,
  /\bpaycheck\b/i,
  // Recall-over-precision additions: chasing/recovery language, life-money
  // stakes, and "sure thing" desperation. A false-positive hotline message is
  // far cheaper than a missed at-risk user.
  /\bget even\b/i,
  /\bwin .{0,12}back\b/i,
  /\blost it all\b/i,
  /\bmortgage\b/i,
  /\bsavings\b/i,
  /\bcollege fund\b/i,
  /\bdesperate\b/i,
  /\bsure thing\b/i,
  /\bdown bad\b/i,
];

export const RESPONSIBLE_GAMBLING_MESSAGE =
  "I'm going to stop you there, because this matters more than any game. " +
  "The discipline I live by starts with one rule: you only ever risk money you can lose without it touching your life. " +
  "Chasing a loss, betting the rent, going all-in to get even — that's the exact behavior a professional never does, because it's how you go broke and how this stops being a game. " +
  "There's no bet I'd give you here. Step away from it tonight. " +
  "If betting has stopped feeling like it's in your control, please talk to someone — Gambling problem? Call 1-800-GAMBLER.";

export function isDistress(message: string): boolean {
  return DISTRESS_PATTERNS.some((p) => p.test(message));
}

// ─── 3. Injection pre-filter ─────────────────────────────────────────────────
//
// Flags known prompt-injection / jailbreak patterns. We do NOT hard-block on a
// flag — the persona itself is built to refuse in character (declining to drop
// the discipline is on-brand), so a flagged message still goes to the model in
// Lane A with an extra reminder. The flag is used for logging + to force the
// cheap persona lane (never the expensive grounded lane) on an injection
// attempt, and to tag the response so the frontend can render it.

const INJECTION_PATTERNS: RegExp[] = [
  /ignore (?:all |any |the )?(?:previous|above|prior|earlier) (?:instructions?|prompts?|rules?)/i,
  /disregard (?:all |any |the )?(?:previous|above|prior) (?:instructions?|rules?)/i,
  /forget (?:all |everything |your )?(?:instructions?|the rules?|what you were told)/i,
  /system prompt/i,
  /your (?:initial |original )?(?:instructions?|prompt|rules?)/i,
  /reveal (?:your |the )?(?:prompt|instructions?|rules?|system)/i,
  /repeat (?:the |everything )?(?:above|your instructions|the prompt)/i,
  /(?:print|show|output|recite) (?:your |the )?(?:prompt|instructions?|system)/i,
  /you are (?:now |no longer )(?:a |an )?(?:dan|jailbroken|unfiltered|developer mode)/i,
  /\bdeveloper mode\b/i,
  /\bjailbreak/i,
  /pretend (?:you (?:are|have)|there are) no (?:rules?|restrictions?|limits?|discipline)/i,
  /act as (?:a |an )?(?:reckless|degenerate|unfiltered|uncensored)/i,
  /\bDAN\b/,
  /override (?:your |the )?(?:rules?|instructions?|discipline)/i,
  /drop (?:the |your )?(?:edge floor|discipline|rules?)/i,
  /lock of the day/i,
  /give me a lock\b/i,
];

export function isInjection(message: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(message));
}

// ─── 4a. Spend governor — GLOBAL daily token ceiling (DB-backed) ─────────────
//
// The source of truth for the day's money budget. Global, not per-process, so
// every serverless instance shares it. The pre-call check is a single read; the
// post-call record is a single atomic UPDATE (increment), no read-modify-write.

export function utcDateKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

export type SpendStatus = {
  open: boolean;
  tokensUsed: number;
  ceiling: number;
};

// Read today's usage and decide whether the desk is open. Called BEFORE every
// model call. Fails OPEN on a DB error (a transient DB blip shouldn't take the
// whole feature down) but logs loudly — the daily ceiling is a cost guard, not
// a security boundary, and the per-IP/session caps still apply.
export async function checkDailySpend(now: Date = new Date()): Promise<SpendStatus> {
  const utcDate = utcDateKey(now);
  try {
    const row = await prisma.chatSpendCounter.findUnique({ where: { utcDate } });
    const tokensUsed = row?.tokensUsed ?? 0;
    return {
      open: tokensUsed < DAILY_TOKEN_CEILING,
      tokensUsed,
      ceiling: DAILY_TOKEN_CEILING,
    };
  } catch (err) {
    console.error("[chat/guards] checkDailySpend DB error (failing open):", err);
    return { open: true, tokensUsed: 0, ceiling: DAILY_TOKEN_CEILING };
  }
}

// Record tokens charged against today's ceiling. Atomic increment via upsert —
// the increment in the UPDATE branch is a single SQL statement, so concurrent
// requests can't lose a write. Best-effort: a failure here over-counts nothing
// and under-counts at most one request's tokens, logged.
export async function recordSpend(
  tokens: number,
  now: Date = new Date()
): Promise<void> {
  if (tokens <= 0) return;
  const utcDate = utcDateKey(now);
  try {
    await prisma.chatSpendCounter.upsert({
      where: { utcDate },
      create: { utcDate, tokensUsed: tokens, modelCalls: 1 },
      update: {
        tokensUsed: { increment: tokens },
        modelCalls: { increment: 1 },
      },
    });
  } catch (err) {
    console.error("[chat/guards] recordSpend DB error (token undercount):", err);
  }
}

// ─── 4b. Per-session + per-IP caps (in-memory, best-effort abuse mitigation) ──
//
// These are NOT the money ceiling — that's the DB counter above. These are
// cheap abuse brakes. In-memory is acceptable: on a cold start the worst case
// is a fresh window, and the global token ceiling is the real backstop. We say
// so explicitly rather than pretending these are durable.

type Window = { count: number; resetAt: number };
const sessionWindows = new Map<string, Window>();
const ipWindows = new Map<string, Window>();

const DAY_MS = 24 * 60 * 60 * 1000;

function hit(store: Map<string, Window>, key: string, limit: number, windowMs: number, now: number): boolean {
  const entry = store.get(key);
  if (!entry || now > entry.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

// Per-session cap. windowMs is long (a session cookie's life); the count is the
// real gate. Returns true if the message is allowed.
export function allowSession(sessionId: string, now: number = Date.now()): boolean {
  return hit(sessionWindows, sessionId, SESSION_MSG_CAP, DAY_MS, now);
}

// Per-IP/day cap.
export function allowIp(ip: string, now: number = Date.now()): boolean {
  return hit(ipWindows, ip, IP_DAY_CAP, DAY_MS, now);
}

// Test seam — clear the in-memory windows between tests.
export function _resetCaps(): void {
  sessionWindows.clear();
  ipWindows.clear();
}
