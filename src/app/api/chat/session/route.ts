// GET /api/chat/session — the ONLY place a chat session cookie is issued.
//
// Why this endpoint exists: POST /api/chat used to mint a session identity
// inline whenever the request arrived without a valid cookie. That made the
// per-session message cap unreachable — omit the cookie and you are a brand-new
// session on every request. Issuance is now a separate, explicitly rate-limited
// step, and the chat route only ever VERIFIES what was issued here.
//
// This endpoint is still public (the chat is public by design), but minting is
// capped per IP/day, so farming fresh identities to reset the per-session cap
// costs an attacker the same IP budget as just sending the messages.
//
// Response contract:
//   200 {ok:true}                    — cookie set (or already valid, no reissue)
//   429 {ok:false, error:"..."}      — this IP has minted too many sessions today

export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { allowMint } from "@/lib/chat/guards";
import {
  mintSession,
  verifySession,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
} from "@/lib/chat/session";
import { clientIp } from "@/lib/chat/client-ip";

export async function GET(req: NextRequest) {
  // Already holding a valid cookie? Don't spend mint budget reissuing one. This
  // also means a normal user refreshing the page all evening never trips the cap.
  const existing = verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (existing) {
    return NextResponse.json({ ok: true, issued: false });
  }

  if (!(await allowMint(clientIp(req)))) {
    return NextResponse.json(
      { ok: false, error: "Too many sessions from this connection today." },
      { status: 429 }
    );
  }

  const res = NextResponse.json({ ok: true, issued: true });
  res.cookies.set(SESSION_COOKIE, mintSession(), SESSION_COOKIE_OPTIONS);
  return res;
}
