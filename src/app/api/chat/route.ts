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
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { answer } from "@/lib/chat/sharp";
import {
  isBodyWithinLimit,
  isDistress,
  allowSession,
  allowIp,
  MAX_BODY_BYTES,
  RESPONSIBLE_GAMBLING_MESSAGE,
} from "@/lib/chat/guards";
import { resolveSession, SESSION_COOKIE } from "@/lib/chat/session";

type IncomingTurn = { role: unknown; content: unknown };

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  const first = fwd.split(",")[0]?.trim();
  return first || req.headers.get("x-real-ip") || "unknown";
}

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

  // ── Session identity (signed cookie) + per-session cap ──
  const { id: sessionId, setCookie } = resolveSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!allowSession(sessionId)) {
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

  // ── Per-IP/day cap ──
  if (!allowIp(clientIp(req))) {
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
    if (setCookie) {
      res.cookies.set(SESSION_COOKIE, setCookie, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 60 * 60 * 24, // 1 day — matches the per-session abuse window
      });
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
