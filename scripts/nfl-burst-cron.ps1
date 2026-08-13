# nfl-burst-cron.ps1 -- budget-capped OVERNIGHT BURST for Experiment No. 5.
#
# One run = as many NFL weeks as ~$20 of real Claude spend covers (roughly 45
# regular-season weeks / ~2 seasons), then stops. The budget is enforced by
# nfl-week.ts `burst` mode against data/private/nfl-loop/spend-log.jsonl, which
# records each call's ACTUAL response.usage priced at list rates -- not an
# estimate. Override the cap with the NFL_BURST_DAILY_USD env var.
#
#   Registered as the "NFL-Exp5-Burst" Windows scheduled task (1:00 AM daily).
#   Run by hand any time: powershell -ExecutionPolicy Bypass -File scripts\nfl-burst-cron.ps1
#
# PURPOSE: walk the 2019-2025 backtest before the 2026 season opens, ~$20/night,
# so the doctrine trains on modern-era football. The burst runs the Opus dream
# automatically at each season boundary and once more when the walk completes.
# When the walk is caught up, a burst run costs $0 (one cursor check, no model
# calls) -- safe to leave scheduled, but the task should be deleted and
# NFL-Exp5-DailyLoop re-enabled once the walk finishes.
#
# NO COMMIT STEP on purpose: the dashboard's nfl-exp5.json is generated from the
# quant dry-run book, which this walk doesn't touch. The daily cron (currently
# disabled during the walk) owns summary + commit.
#
# NOTE: ASCII only. Windows PowerShell 5.1 reads a no-BOM UTF-8 .ps1 as
# Windows-1252, so non-ASCII punctuation (em-dash, curly quotes) breaks parsing.

$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\Nate\source\repos\GoSteelers88\sports-betting-trends'
Set-Location $repo

# Task Scheduler launches with a reduced environment -- make node tooling resolve.
$extraPaths = @('C:\Program Files\Git\cmd', "$env:ProgramFiles\nodejs", "$env:APPDATA\npm")
foreach ($p in $extraPaths) { if ((Test-Path $p) -and ($env:Path -notlike "*$p*")) { $env:Path = "$p;$env:Path" } }

$logDir = Join-Path $repo 'data\private\nfl-loop\cron-logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
$log = Join-Path $logDir ("burst-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))

function Log($msg) {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  $line | Tee-Object -FilePath $log -Append
}

Log "=== NFL Exp5 BURST START (cap: $(if ($env:NFL_BURST_DAILY_USD) { $env:NFL_BURST_DAILY_USD } else { '20' }) USD) ==="

# Native calls from here. In PS 5.1, 'Stop' turns any native stderr line into a
# terminating error even on exit 0 -- switch to 'Continue', gate on $LASTEXITCODE.
$ErrorActionPreference = 'Continue'

npx --no-install tsx --env-file=.env scripts/nfl-week.ts burst *>&1 | Tee-Object -FilePath $log -Append
if ($LASTEXITCODE -ne 0) { Log "FAIL: burst exit $LASTEXITCODE"; exit 1 }

Log "=== NFL Exp5 BURST DONE ==="
