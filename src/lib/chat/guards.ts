// The hard safety guards for "The Sharp" public chat endpoint.
//
// This is a PUBLIC endpoint spending real Anthropic tokens, so every guard here
// is load-bearing. The guards are pure (or DB-only) and decision-from-effect
// separated so they unit-test without the route or the model:
//   1. Body-size cap            — reject oversized payloads before any work.
//   2. Distress interceptor     — bypass the model entirely on at-risk phrasing.
//   3. Injection pre-filter     — flag known prompt-injection patterns.
//   4. Spend governor           — GLOBAL daily token ceiling (DB-backed,
//                                 reserved-before-spend) + per-session,
//                                 per-IP and cookieless caps (DB-backed).

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
//
// NOTE ON THE 20x RAISE (2M → 40M): this counter used to be fed a chars/4
// estimate that ignored the Lane B tool loop re-sending the system prompt, tool
// schemas, and the accumulated conversation on each of up to 4 iterations — it
// undercounted a real Lane B turn by roughly an order of magnitude, so the
// "2,000,000" was never 2M actual tokens. The counter is now fed REAL
// `response.usage` totals, so the ceiling was raised proportionally to keep the
// effective daily allowance where it already was in practice. Lower it if you
// want a genuinely tighter budget — the number finally means what it says.
export const DAILY_TOKEN_CEILING = intFromEnv("CHAT_DAILY_TOKEN_CEILING", 40_000_000);

// Pessimistic per-turn reservations, taken against the ceiling BEFORE the model
// call and reconciled to real usage after. Sized to the worst case each lane can
// actually reach so a burst of concurrent callers can't collectively overshoot.
export const RESERVE_LANE_A = intFromEnv("CHAT_RESERVE_LANE_A", 4_000);
export const RESERVE_LANE_B = intFromEnv("CHAT_RESERVE_LANE_B", 120_000);
export const RESERVE_REGROUND = intFromEnv("CHAT_RESERVE_REGROUND", 30_000);
export const RESERVE_TIEBREAK = intFromEnv("CHAT_RESERVE_TIEBREAK", 2_000);

// Per-session message cap (signed session cookie). 15 turns is plenty for a
// real question; beyond it is almost always abuse or a loop.
export const SESSION_MSG_CAP = intFromEnv("CHAT_SESSION_MSG_CAP", 15);

// Per-IP/day message cap. Coarse abuse mitigation keyed on x-forwarded-for.
export const IP_DAY_CAP = intFromEnv("CHAT_IP_DAY_CAP", 40);

// Per-IP/day cap on requests that arrive with NO valid session cookie.
//
// This is the cap that closes the actual hole. The route used to call
// resolveSession(), which minted a brand-new signed id inline whenever the
// cookie was absent — so a client that simply never sent a cookie got a fresh
// identity on every request and SESSION_MSG_CAP could never fire. Cookieless
// requests are now their own small, IP-keyed budget: enough that a first-time
// visitor whose cookie fetch failed still gets served, nowhere near enough to
// be a free lane around the session cap.
export const COOKIELESS_DAY_CAP = intFromEnv("CHAT_COOKIELESS_DAY_CAP", 3);

// Per-IP/day cap on session-cookie ISSUANCE (GET /api/chat/session). Without
// this, minting is a free endpoint an attacker can loop to farm fresh session
// ids and reset the per-session cap at will.
export const MINT_DAY_CAP = intFromEnv("CHAT_MINT_DAY_CAP", 10);

// How many days of ChatRateLimit rows to keep. They are pure abuse counters with
// no analytical value past their window.
export const RATE_LIMIT_RETENTION_DAYS = intFromEnv("CHAT_RATE_LIMIT_RETENTION_DAYS", 3);

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
// model call.
//
// FAILS CLOSED on a DB error. This used to fail open, on the reasoning that the
// ceiling is a cost guard rather than a security boundary and the per-IP/session
// caps still applied. Both halves of that were wrong: those caps lived in
// per-lambda memory (so they were not a backstop at all), and "cost guard"
// understates it — this counter is the only thing bounding what an anonymous
// caller can spend against ANTHROPIC_API_KEY. A Turso blip closing the desk for
// a few minutes is strictly cheaper than a Turso blip removing the budget.
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
    console.error("[chat/guards] checkDailySpend DB error (failing CLOSED):", err);
    return { open: false, tokensUsed: DAILY_TOKEN_CEILING, ceiling: DAILY_TOKEN_CEILING };
  }
}

// Reserve tokens against today's ceiling BEFORE making a model call.
//
// The old shape was check-then-act: read the counter, decide, call the model,
// increment afterwards. Every request in flight at the same moment read the same
// pre-ceiling value and every one of them passed, so N concurrent callers could
// overshoot by N turns' worth of Sonnet spend. Here the increment IS the check —
// one atomic upsert whose returned count decides — and an over-ceiling reservation
// is refunded immediately, so a rejected caller doesn't hold budget it never spent.
//
// Fails CLOSED, same reasoning as checkDailySpend.
export async function reserveSpend(
  tokens: number,
  now: Date = new Date()
): Promise<SpendStatus> {
  const utcDate = utcDateKey(now);
  const amount = Math.max(0, Math.ceil(tokens));
  try {
    const row = await prisma.chatSpendCounter.upsert({
      where: { utcDate },
      create: { utcDate, tokensUsed: amount, modelCalls: 1 },
      update: { tokensUsed: { increment: amount }, modelCalls: { increment: 1 } },
    });
    // The reservation itself may be what crosses the line. Compare the balance
    // BEFORE this reservation so a single expensive turn can still run when the
    // day is otherwise untouched — the ceiling bounds the day, not the turn.
    const priorTokens = row.tokensUsed - amount;
    if (priorTokens >= DAILY_TOKEN_CEILING) {
      await reconcileSpend(amount, 0, now); // refund — we are not calling the model
      return { open: false, tokensUsed: priorTokens, ceiling: DAILY_TOKEN_CEILING };
    }
    return { open: true, tokensUsed: row.tokensUsed, ceiling: DAILY_TOKEN_CEILING };
  } catch (err) {
    console.error("[chat/guards] reserveSpend DB error (failing CLOSED):", err);
    return { open: false, tokensUsed: DAILY_TOKEN_CEILING, ceiling: DAILY_TOKEN_CEILING };
  }
}

// Settle a reservation against what the model actually reported. The delta may be
// negative (the common case — reservations are deliberately pessimistic), which
// hands the unused budget back to the rest of the day. modelCalls was already
// counted by reserveSpend, so it is NOT incremented again here.
export async function reconcileSpend(
  reservedTokens: number,
  actualTokens: number,
  now: Date = new Date()
): Promise<void> {
  const delta = Math.ceil(actualTokens) - Math.ceil(reservedTokens);
  if (delta === 0) return;
  const utcDate = utcDateKey(now);
  try {
    await prisma.chatSpendCounter.update({
      where: { utcDate },
      data: { tokensUsed: { increment: delta } },
    });
  } catch (err) {
    console.error("[chat/guards] reconcileSpend DB error (budget left reserved):", err);
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

// ─── 4b. Per-session / per-IP / cookieless caps (DB-backed, durable) ─────────
//
// These are NOT the money ceiling — that's the counter above. These are the
// abuse brakes, and they are now durable.
//
// They used to be in-process Maps with a comment conceding that "on a cold start
// the worst case is a fresh window". In serverless that isn't a worst case, it's
// the normal case: every concurrent lambda holds its own window and every cold
// start hands out a clean one, so neither cap meaningfully bound anything. They
// are keyed in Turso now, shared across instances and surviving cold starts.
//
// The counter is incremented and read in ONE atomic upsert, and the returned
// count is what we compare — so two requests racing for the last slot cannot
// both win it.

export type CapScope = "session" | "ip" | "cookieless" | "mint";

// Atomic increment-then-compare. Returns true if this hit is within the cap.
//
// Fails CLOSED on a DB error, matching the spend governor: an unavailable
// counter must not become an unlimited one.
async function hitDurable(
  scope: CapScope,
  key: string,
  limit: number,
  now: Date
): Promise<boolean> {
  const utcDate = utcDateKey(now);
  try {
    const row = await prisma.chatRateLimit.upsert({
      where: { scope_key_utcDate: { scope, key, utcDate } },
      create: { scope, key, utcDate, count: 1 },
      update: { count: { increment: 1 } },
    });
    return row.count <= limit;
  } catch (err) {
    console.error(`[chat/guards] ${scope} cap DB error (failing CLOSED):`, err);
    return false;
  }
}

// Per-session message cap, keyed on the verified signed session id.
export async function allowSession(
  sessionId: string,
  now: Date = new Date()
): Promise<boolean> {
  return hitDurable("session", sessionId, SESSION_MSG_CAP, now);
}

// Per-IP/day message cap.
export async function allowIp(ip: string, now: Date = new Date()): Promise<boolean> {
  return hitDurable("ip", ip, IP_DAY_CAP, now);
}

// Per-IP/day cap on requests arriving WITHOUT a valid session cookie. This is
// the brake that makes the session cap reachable at all — see COOKIELESS_DAY_CAP.
export async function allowCookieless(
  ip: string,
  now: Date = new Date()
): Promise<boolean> {
  return hitDurable("cookieless", ip, COOKIELESS_DAY_CAP, now);
}

// Per-IP/day cap on session-cookie issuance, so minting fresh identities is not
// itself a free lane around the per-session cap.
export async function allowMint(ip: string, now: Date = new Date()): Promise<boolean> {
  return hitDurable("mint", ip, MINT_DAY_CAP, now);
}

// Drop rate-limit rows older than the retention window. Best-effort housekeeping
// called from the daily cron — these are abuse counters, not analytics, and an
// unbounded table of per-IP keys is its own slow-motion problem.
export async function pruneRateLimits(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RATE_LIMIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  try {
    const { count } = await prisma.chatRateLimit.deleteMany({
      where: { utcDate: { lt: utcDateKey(cutoff) } },
    });
    return count;
  } catch (err) {
    console.error("[chat/guards] pruneRateLimits DB error (rows retained):", err);
    return 0;
  }
}
