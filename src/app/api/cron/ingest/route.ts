export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = process.cwd();

export async function POST(req: NextRequest) {
  // Simple bearer token check
  const auth = req.headers.get("authorization") ?? "";
  const secret = process.env.CRON_SECRET ?? "natestacks";
  if (!auth.startsWith("Bearer ") || auth.slice(7) !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const script = (body.script as string) ?? "ingest:all";

  // Allowed scripts whitelist
  const allowed = ["ingest:odds", "ingest:free", "ingest:all", "ingest:props", "ingest:injuries"];
  if (!allowed.includes(script)) {
    return NextResponse.json({ error: "Script not allowed" }, { status: 400 });
  }

  return new Promise<NextResponse>((resolve) => {
    const child = spawn("npm", ["run", script], {
      cwd: ROOT,
      shell: true,
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
