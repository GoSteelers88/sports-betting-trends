# nfl-dream-cron.ps1 -- weekly driver for the Experiment No. 5 "dream".
#
# Runs the Opus consolidation: read the FULL graded record + parlay backtest and
# distill durable cross-season doctrine into the private doctrine file. The next
# nfl:week pick prompt injects that doctrine -- BUT only for weeks strictly AFTER
# the doctrine's coverage window (the leak guard). So this matters most once the
# loop is picking forward/live weeks (the 2026 season); in the offseason it just
# re-derives the same doctrine from the same record.
#
#   Registered as the "NFL-Exp5-WeeklyDream" Windows scheduled task (Tue 6:00 AM).
#   Run by hand: powershell -ExecutionPolicy Bypass -File scripts\nfl-dream-cron.ps1
#
# WHY LOCAL + NO GIT: like the daily loop, the inputs (picks logs) and the output
# (data/private/nfl-loop/lessons/nfl-doctrine.md) are GITIGNORED and live only on
# this machine. The doctrine is read locally by the next pick run -- nothing is
# committed or deployed.
#
# NOTE: ASCII only. Windows PowerShell 5.1 reads a no-BOM UTF-8 .ps1 as
# Windows-1252, so non-ASCII punctuation breaks parsing.

$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\Nate\source\repos\GoSteelers88\sports-betting-trends'
Set-Location $repo

$extraPaths = @('C:\Program Files\Git\cmd', "$env:ProgramFiles\nodejs", "$env:APPDATA\npm")
foreach ($p in $extraPaths) { if ((Test-Path $p) -and ($env:Path -notlike "*$p*")) { $env:Path = "$p;$env:Path" } }

$logDir = Join-Path $repo 'data\private\nfl-loop\cron-logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
$log = Join-Path $logDir ("dream-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))

function Log($msg) {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  $line | Tee-Object -FilePath $log -Append
}

Log "=== NFL Exp5 weekly dream START ==="

# Native tools past here -- 'Continue' so a stderr line on exit 0 doesn't abort;
# real failures are caught on $LASTEXITCODE. nfl:dream's npm script already loads
# .env, but invoke tsx directly with --env-file for a stable, PATH-light launch.
$ErrorActionPreference = 'Continue'

npx --no-install tsx --env-file=.env scripts/nfl-dream.ts *>&1 | Tee-Object -FilePath $log -Append
if ($LASTEXITCODE -ne 0) { Log "FAIL: nfl:dream exit $LASTEXITCODE"; exit 1 }

$doctrine = Join-Path $repo 'data\private\nfl-loop\lessons\nfl-doctrine.md'
if (Test-Path $doctrine) {
  $age = (Get-Item $doctrine).LastWriteTime
  Log "doctrine refreshed: $doctrine (mtime $age)"
} else {
  Log "WARN: doctrine file not found after run -- check the log above"
}

Log "=== NFL Exp5 weekly dream DONE ==="
