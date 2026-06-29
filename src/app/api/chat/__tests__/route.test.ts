// Route-level tests for POST /api/chat. We mock the chat core (answer), the
// session resolver, and prisma so nothing touches a real model or DB. The point
// of these tests is the ROUTE's responsibilities: reading `history` (FIX 2),
// running the distress interceptor BEFORE the rate caps (FIX 4), and basic
// validation.

import { describe, it, expect, beforeEach, vi } from "vitest";

// The core is mocked — we assert on what the route HANDS it, not what it does.
const answerMock = vi.fn();
vi.mock("@/lib/chat/sharp", () => ({
  answer: (...a: unknown[]) => answerMock(...a),
}));

// Stable session (no signing/crypto in tests).
vi.mock("@/lib/chat/session", () => ({
  SESSION_COOKIE: "sharp_sess",
  resolveSession: () => ({ id: "test-session", setCookie: null }),
}));

// prisma is pulled in transitively via guards; no-op it.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    chatSpendCounter: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
  },
}));

import { NextRequest } from "next/server";
import { POST } from "../route";
import { _resetCaps } from "@/lib/chat/guards";

beforeEach(() => {
  _resetCaps();
  answerMock.mockReset();
  answerMock.mockResolvedValue({ reply: "ok", lane: "A" });
});

function post(body: unknown): NextRequest {
  // The route uses req.text(), req.headers, and req.cookies.get(); NextRequest
  // provides all three. No cookies are set, so resolveSession (mocked) handles
  // the empty case.
  return new NextRequest("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "5.5.5.5" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/chat — history threading (FIX 2)", () => {
  it("passes a posted `history` array through to answer() as recentTurns", async () => {
    const history = [
      { role: "user", content: "do you like the Lakers tonight?" },
      { role: "assistant", content: "Model has them at 58% — small edge." },
    ];
    const res = await POST(post({ message: "what about the over?", history }));
    expect(res.status).toBe(200);
    expect(answerMock).toHaveBeenCalledTimes(1);
    const [msg, turns] = answerMock.mock.calls[0];
    expect(msg).toBe("what about the over?");
    expect(turns).toEqual(history);
  });

  it("still accepts legacy `recentTurns` when `history` is absent", async () => {
    const recentTurns = [{ role: "user", content: "hi" }];
    await POST(post({ message: "next", recentTurns }));
    const [, turns] = answerMock.mock.calls[0];
    expect(turns).toEqual(recentTurns);
  });

  it("prefers `history` over `recentTurns`/`messages` when both are present", async () => {
    const history = [{ role: "user", content: "from history" }];
    const recentTurns = [{ role: "user", content: "from recentTurns" }];
    await POST(post({ message: "q", history, recentTurns }));
    const [, turns] = answerMock.mock.calls[0];
    expect(turns).toEqual(history);
  });
});

describe("POST /api/chat — distress before rate caps (FIX 4)", () => {
  it("returns the hotline message even after the per-session cap is exhausted", async () => {
    // Burn the per-session cap with benign messages first.
    for (let i = 0; i < 20; i++) {
      await POST(post({ message: `benign question ${i}` }));
    }
    answerMock.mockClear();

    // Now a distressed message that WOULD hit the 429 cap if checked first.
    const res = await POST(
      post({ message: "I'm down bad and need a sure thing to win my money back" })
    );
    const json = (await res.json()) as { reply: string; intercepted?: string };
    expect(res.status).toBe(200);
    expect(json.intercepted).toBe("distress");
    expect(json.reply).toContain("1-800-GAMBLER");
    // The model core is never called for a distress turn.
    expect(answerMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/chat — validation", () => {
  it("rejects a missing message", async () => {
    const res = await POST(post({ history: [] }));
    expect(res.status).toBe(400);
  });
});
