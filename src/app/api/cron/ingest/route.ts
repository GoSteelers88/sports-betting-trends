export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const ROOT = process.cwd();

// Constant-time bearer token check; fail-closed if no secret configured.
function authOk(req: NextRequest, secret: string | undefined): boolean {
  if (!secret) return false;
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const provided = auth.slice(7);
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500 });
  }
  if (!authOk(req, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const script = (body.script as string) ?? "ingest:all";

  // Allowed scripts whitelist (script names only — no shell metacharacters allowed)
  const allowed = ["ingest:odds", "ingest:free", "ingest:all", "ingest:props", "ingest:injuries"];
  if (!allowed.includes(script)) {
    return NextResponse.json({ error: "Script not allowed" }, { status: 400 });
  }

  return new Promise<NextResponse>((resolve) => {
    // shell: false — script names are an allowlist of literals, but defense
    // in depth: never give the spawned process a shell.
    const isWin = process.platform === "win32";
    const child = spawn(isWin ? "npm.cmd" : "npm", ["run", script], {
      cwd: ROOT,
      shell: false,
      timeout: 300_000,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("close", (code) => {
      resolve(NextResponse.json({
        ok: code === 0,
        script,
        exitCode: code,
        stdout: stdout.slice(-2000),
        stderr: stderr.slice(-1000),
      }));
    });

    child.on("error", (err) => {
      resolve(NextResponse.json({ ok: false, script, error: err.message }, { status: 500 }));
    });
  });
}
