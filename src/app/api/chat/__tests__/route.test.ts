// Route-level tests for POST /api/chat. We mock the chat core (answer), the
// session verifier, and prisma so nothing touches a real model or DB. The point
// of these tests is the ROUTE's responsibilities: reading `history` (FIX 2),
// running the distress interceptor BEFORE the rate caps (FIX 4), basic
// validation, and — the security fix — that identity is VERIFIED here and never
// minted inline, so the per-session cap is actually reachable.

import { describe, it, expect, beforeEach, vi } from "vitest";

// The core is mocked — we assert on what the route HANDS it, not what it does.
const answerMock = vi.fn();
vi.mock("@/lib/chat/sharp", () => ({
  answer: (...a: unknown[]) => answerMock(...a),
}));

// Session identity: VERIFY only — the route must never mint inline. The fake
// treats the literal cookie "good" as a valid signed token and anything else as
// invalid, so tests can exercise the cookied and cookieless paths without crypto.
vi.mock("@/lib/chat/session", () => ({
  SESSION_COOKIE: "sharp_sess",
  SESSION_COOKIE_OPTIONS: { httpOnly: true, path: "/" },
  verifySession: (v: string | undefined | null) => (v === "good" ? "test-session" : null),
  mintSession: () => "minted.sig",
}));

// prisma is pulled in transitively via guards. The rate-limit counter has to
// actually count — the caps are increment-then-compare on the RETURNED count.
const rateLimitCounts = new Map<string, number>();
vi.mock("@/lib/prisma", () => ({
  prisma: {
    chatSpendCounter: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ tokensUsed: 0, modelCalls: 0 }),
      update: vi.fn().mockResolvedValue({}),
    },
    chatRateLimit: {
      upsert: vi.fn(async (arg: unknown) => {
        const { scope, key, utcDate } = (
          arg as { where: { scope_key_utcDate: { scope: string; key: string; utcDate: string } } }
        ).where.scope_key_utcDate;
        const id = `${scope}|${key}|${utcDate}`;
        const next = (rateLimitCounts.get(id) ?? 0) + 1;
        rateLimitCounts.set(id, next);
        return { scope, key, utcDate, count: next };
      }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  },
}));

import { NextRequest } from "next/server";
import { POST } from "../route";
import { COOKIELESS_DAY_CAP, SESSION_MSG_CAP } from "@/lib/chat/guards";

beforeEach(() => {
  rateLimitCounts.clear();
  answerMock.mockReset();
  answerMock.mockResolvedValue({ reply: "ok", lane: "A" });
});

// A request carrying a VALID session cookie — the normal path for a real user,
// who is handed one by GET /api/chat/session before their first send.
function post(body: unknown, opts: { cookie?: string | null; ip?: string } = {}): NextRequest {
  const { cookie = "good", ip = "5.5.5.5" } = opts;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": ip,
  };
  if (cookie) headers.cookie = `sharp_sess=${cookie}`;
  return new NextRequest("http://localhost/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

// A request with no cookie at all — what a scripted caller sends.
function postCookieless(body: unknown, ip = "6.6.6.6"): NextRequest {
  return post(body, { cookie: null, ip });
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

// ─── The regression these caps exist for ─────────────────────────────────────
//
// The route used to call resolveSession(), which minted a fresh signed id inline
// whenever the cookie was absent. Since the rate limiter admits any first-seen
// key, a caller who simply never sent a cookie was a brand-new session on every
// request and the per-session cap was unreachable dead code. These tests pin the
// fix: cookieless callers get a small IP-keyed budget, not a free identity.
describe("POST /api/chat — cookieless callers cannot mint their way past the cap", () => {
  it("blocks a cookieless caller after the small cookieless budget", async () => {
    const ip = "9.1.1.1";
    for (let i = 0; i < COOKIELESS_DAY_CAP; i++) {
      const ok = await POST(postCookieless({ message: `q${i}` }, ip));
      expect(ok.status).toBe(200);
    }
    const blocked = await POST(postCookieless({ message: "one too many" }, ip));
    expect(blocked.status).toBe(429);
    const json = (await blocked.json()) as { closed?: boolean };
    expect(json.closed).toBe(true);
  });

  it("does not reset the budget when the caller drops the cookie every time", async () => {
    // The old behaviour: each of these was a new session, so all 50 sailed
    // through. Now they share one IP-keyed cookieless counter.
    const ip = "9.2.2.2";
    let served = 0;
    for (let i = 0; i < 50; i++) {
      const res = await POST(postCookieless({ message: `loop ${i}` }, ip));
      if (res.status === 200) served++;
    }
    expect(served).toBe(COOKIELESS_DAY_CAP);
    expect(answerMock).toHaveBeenCalledTimes(COOKIELESS_DAY_CAP);
  });

  it("attaches a cookie to a served cookieless response so honest clients converge", async () => {
    const res = await POST(postCookieless({ message: "first ever question" }, "9.3.3.3"));
    expect(res.status).toBe(200);
    expect(res.cookies.get("sharp_sess")?.value).toBe("minted.sig");
  });

  it("does not reissue a cookie to a caller who already has a valid one", async () => {
    const res = await POST(post({ message: "hello" }));
    expect(res.status).toBe(200);
    expect(res.cookies.get("sharp_sess")).toBeUndefined();
  });

  it("enforces the per-session cap on a cookied caller", async () => {
    let served = 0;
    for (let i = 0; i < SESSION_MSG_CAP + 5; i++) {
      const res = await POST(post({ message: `turn ${i}` }));
      if (res.status === 200) served++;
    }
    expect(served).toBe(SESSION_MSG_CAP);
  });

  it("counts cookied and cookieless callers against the SAME per-IP budget", async () => {
    // Rotating between "with cookie" and "without" must not buy extra turns.
    const ip = "9.4.4.4";
    await POST(post({ message: "a" }, { ip }));
    await POST(postCookieless({ message: "b" }, ip));
    const ipKey = [...rateLimitCounts.keys()].find((k) => k.startsWith(`ip|${ip}|`));
    expect(rateLimitCounts.get(ipKey!)).toBe(2);
  });
});
