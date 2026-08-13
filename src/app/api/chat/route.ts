// POST /api/chat — "The Sharp" public chatbot.
//
// Thin wrapper: parse + validate the request, enforce the cheap pre-model caps
// (body size, signed session cap, per-IP/day cap), then hand off to the testable
// core in src/lib/chat/sharp.ts which runs the guards, router, and lanes.
//
// Response contract (stable; documented in src/lib/chat/sharp.ts ChatResponse):
//   { reply: string, lane: "A" | "B", closed?: boolean,
//     intercepted?: "distress" | "injection" | "out_of_scope",
//     toolsUsed?: string[] }

export const dynamic = "force-dynamic";
// 120s: even without the (now single no-tools) regen, a first loop alone on a fat
// slate can approach 60s. This is load-bearing headroom; 120 is under the plan cap
// (this repo already deploys maxDuration=300 on /api/agent/analyze and 120 on
// /api/cron/grade).
export const maxDuration = 120;

import { NextRequest, NextResponse } from "next/server";
import { answer } from "@/lib/chat/sharp";
import {
  isBodyWithinLimit,
  isDistress,
  allowSession,
  allowIp,
  allowCookieless,
  MAX_BODY_BYTES,
  RESPONSIBLE_GAMBLING_MESSAGE,
} from "@/lib/chat/guards";
import {
  mintSession,
  verifySession,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
} from "@/lib/chat/session";
import { clientIp } from "@/lib/chat/client-ip";

type IncomingTurn = { role: unknown; content: unknown };

// Sanitize the client-supplied recent turns: single-session, in-memory only —
// the client echoes back the conversation, we never durably store it. We accept
// only well-formed {role, content} pairs and cap the count + size.
function sanitizeTurns(raw: unknown): Array<{ role: "user" | "assistant"; content: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const t of raw as IncomingTurn[]) {
    const role = t?.role;
    const content = t?.content;
    if ((role === "user" || role === "assistant") && typeof content === "string") {
      out.push({ role, content: content.slice(0, 2000) });
    }
    if (out.length >= 12) break;
  }
  return out;
}

export async function POST(req: NextRequest) {
  // ── Body-size cap (GUARD 1, cheapest first) ──
  const rawBody = await req.text();
  if (!isBodyWithinLimit(rawBody)) {
    return NextResponse.json(
      { error: `Request too large (max ${MAX_BODY_BYTES} bytes).` },
      { status: 413 }
    );
  }

  let parsed: {
    message?: unknown;
    messages?: unknown;
    recentTurns?: unknown;
    history?: unknown;
  };
  try {
    parsed = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const message = typeof parsed.message === "string" ? parsed.message.trim() : "";
  if (!message) {
    return NextResponse.json({ error: "Missing 'message' string." }, { status: 400 });
  }

  // The frontend posts `history`; older callers used `recentTurns`/`messages`.
  // Read `history` FIRST so multi-turn context actually reaches the model —
  // without this, every follow-up ("what about the over?") is a cold start.
  const recentTurns = sanitizeTurns(
    parsed.history ?? parsed.recentTurns ?? parsed.messages
  );

  // ── Distress interceptor — BEFORE the rate caps ──
  // Human-safety guard must fire regardless of cap state: a distressed user who
  // has hit the per-session/per-IP cap still needs the hotline message, not a
  // generic 429. This is the cheap, model-free check; the same interceptor runs
  // again inside answer() for non-route callers.
  if (isDistress(message)) {
    return NextResponse.json(
      {
        reply: RESPONSIBLE_GAMBLING_MESSAGE,
        lane: "A",
        intercepted: "distress",
      },
      { status: 200 }
    );
  }

  const ip = clientIp(req);

  // ── Session identity: VERIFY ONLY. Never mint here. ──
  //
  // The old code called resolveSession(), which minted a fresh signed id inline
  // when the cookie was missing. Since the rate limiter admits any first-seen
  // key, dropping the cookie made every request a new session and the cap below
  // was unreachable dead code. A request without a valid cookie is now charged
  // against a small per-IP cookieless budget instead of being handed a free
  // identity — see COOKIELESS_DAY_CAP in guards.ts.
  const sessionId = verifySession(req.cookies.get(SESSION_COOKIE)?.value);

  // Cookies are issued by GET /api/chat/session, which the client calls before
  // its first send. A cookieless POST is therefore either a first-timer whose
  // issuance call failed, or a bot. We serve a few of them (so a real visitor is
  // never hard-broken by a blocked cookie) and attach a cookie to the response so
  // an honest client converges onto session tracking from its second turn on.
  let issueCookie = false;
  if (!sessionId) {
    if (!(await allowCookieless(ip))) {
      return NextResponse.json(
        {
          reply:
            "I don't take questions from behind a curtain. Reload the page and ask me again — the desk needs to know it's the same person it's already talking to.",
          lane: "A",
          closed: true,
        },
        { status: 429 }
      );
    }
    issueCookie = true;
  } else if (!(await allowSession(sessionId))) {
    return NextResponse.json(
      {
        reply:
          "That's enough for one session. I don't run a hotline — take what we covered, sleep on it, and come back fresh.",
        lane: "A",
        closed: true,
      },
      { status: 429 }
    );
  }

  // ── Per-IP/day cap — applies to cookied and cookieless callers alike ──
  if (!(await allowIp(ip))) {
    return NextResponse.json(
      {
        reply:
          "You've hit the daily limit from this connection. The discipline keeps — value over action — and it'll still be here tomorrow.",
        lane: "A",
        closed: true,
      },
      { status: 429 }
    );
  }

  try {
    const result = await answer(message, recentTurns);
    const res = NextResponse.json(result);
    if (issueCookie) {
      res.cookies.set(SESSION_COOKIE, mintSession(), SESSION_COOKIE_OPTIONS);
    }
    return res;
  } catch (err) {
    console.error("[api/chat] handler error:", err);
    // Fail closed in character — never leak a stack trace over the wire.
    return NextResponse.json(
      {
        reply:
          "Something glitched on my end — not your question, my desk. Try that again in a moment.",
        lane: "A",
      },
      { status: 500 }
    );
  }
}
