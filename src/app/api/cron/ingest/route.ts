export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { assertCronAuth } from "@/lib/assertCronAuth";

const ROOT = process.cwd();

export async function POST(req: NextRequest) {
  const authError = assertCronAuth(req);
  if (authError) return authError;

  const body = await req.json().catch(() => ({}));
  const script = (body.script as string) ?? "ingest:all";

  // Allowed scripts whitelist (script names only — no shell metacharacters allowed)
  const allowed = ["ingest:odds", "ingest:free", "ingest:all", "ingest:props", "ingest:injuries"];
  if (!allowed.includes(script)) {
    return NextResponse.json({ error: "Script not allowed" }, { status: 400 });
  }

  return new Promise<NextResponse>((resolve) => {
    // shell: false — script names are an allowlist of literals, defense in depth.
    const isWin = process.platform === "win32";
    const child = spawn(isWin ? "npm.cmd" : "npm", ["run", script], {
      cwd: ROOT,
      shell: false,
      timeout: 300_000,
    });

    // Bound stdout/stderr to prevent unbounded buffer growth on misbehaving scripts.
    const MAX_BUF = 1_000_000; // 1MB cap per stream
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < MAX_BUF) stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < MAX_BUF) stderr += d.toString();
    });

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
