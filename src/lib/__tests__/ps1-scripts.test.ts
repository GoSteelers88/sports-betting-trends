// ps1-scripts.test.ts — the local scheduled tasks must be able to START.
//
// 2026-09-22: NFL-Weekly-Publish died at parse time. The .ps1 is UTF-8 without
// a BOM; Windows PowerShell 5.1 reads that as cp1252, so an em-dash inside a
// string became "â€”" and its trailing U+201D was parsed as a closing quote.
// The script never reached its own try/catch, so no log and no alert. The rule
// ("ASCII only") had been written in the header comments of the other two
// scripts for weeks - a comment enforces nothing. This does.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPTS = path.resolve(__dirname, "../../../scripts");

function listPs1(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return listPs1(p);
    return e.name.endsWith(".ps1") ? [p] : [];
  });
}

/** Line numbers (1-based) containing a byte > 0x7F. */
export function nonAsciiLines(buf: Buffer): number[] {
  const out: number[] = [];
  let line = 1;
  let flagged = false;
  for (const b of buf) {
    if (b === 0x0a) { line++; flagged = false; continue; }
    if (b > 0x7f && !flagged) { out.push(line); flagged = true; }
  }
  return out;
}

const files = listPs1(SCRIPTS);

describe("scheduled-task .ps1 scripts", () => {
  it("finds the scripts the scheduled tasks run", () => {
    const names = files.map((f) => path.basename(f));
    for (const n of ["scheduled-task.ps1", "nfl-cron.ps1", "nfl-dream-cron.ps1", "nfl-publish-day.ps1", "cron-common.ps1"]) {
      expect(names).toContain(n);
    }
  });

  it("negative control: the checker flags an em-dash and passes plain ASCII", () => {
    expect(nonAsciiLines(Buffer.from('ok\nWrite-Host "a — b"\n', "utf8"))).toEqual([2]);
    expect(nonAsciiLines(Buffer.from('Write-Host "a - b"\n', "utf8"))).toEqual([]);
  });

  it.each(files.map((f) => [path.relative(SCRIPTS, f), f]))("%s is ASCII-only", (_rel, file) => {
    expect(nonAsciiLines(fs.readFileSync(file)), "non-ASCII on these lines - PS 5.1 will misparse them").toEqual([]);
  });

  // Only Windows has the PS 5.1 parser the tasks actually run under.
  it.runIf(process.platform === "win32")("every script parses under Windows PowerShell 5.1", () => {
    const list = files.map((f) => `'${f.replace(/'/g, "''")}'`).join(",");
    const cmd =
      `$bad = @(); foreach ($f in @(${list})) { $e = $null; ` +
      `[void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$null, [ref]$e); ` +
      `foreach ($x in $e) { $bad += "$($f):$($x.Extent.StartLineNumber) $($x.Message)" } }; ` +
      `$bad -join [char]10`;
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  }, 60_000);
});
