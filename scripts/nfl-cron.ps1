# nfl-cron.ps1 -- daily driver for Experiment No. 5 (the private NFL backtest loop).
#
# One run = ONE NFL week: pick -> grade -> learn -> advance the cursor, then
# regenerate the public dashboard summary and commit ONLY that one tracked file.
#
#   Registered as the "NFL-Exp5-DailyLoop" Windows scheduled task (5:00 AM daily).
#   Run by hand any time: powershell -ExecutionPolicy Bypass -File scripts\nfl-cron.ps1
#
# WHY LOCAL: the loop's state (games.csv spine, cursor, picks log, ~9 MB) lives
# under data/private/nfl-loop/ and is GITIGNORED by design. A cloud runner can't
# see it or persist the advanced cursor, so the job has to run on this machine.
#
# WHAT LEAVES THE MACHINE: only data/processed/nfl-exp5.json (the settled-bet
# aggregate the dashboard reads). Everything else stays private + local.
#
# CAUGHT-UP IS NORMAL: once the cursor reaches the end of the loaded seasons the
# loop re-processes the same final week to an identical record, so only the
# generatedAt timestamp moves. Step 3 detects that and skips the commit, so no
# Vercel build is burned. It resumes for real once a new season is ingested
# (npm run nfl:ingest).
#
# NOTE: ASCII only. Windows PowerShell 5.1 reads a no-BOM UTF-8 .ps1 as
# Windows-1252, so non-ASCII punctuation (em-dash, curly quotes) breaks parsing.

$ErrorActionPreference = 'Stop'
$repo = 'C:\Users\Nate\source\repos\GoSteelers88\sports-betting-trends'
Set-Location $repo

# Belt-and-suspenders: Task Scheduler launches with a reduced environment, so
# make sure git + node tooling resolve even if a PATH entry is missing.
$extraPaths = @('C:\Program Files\Git\cmd', "$env:ProgramFiles\nodejs", "$env:APPDATA\npm")
foreach ($p in $extraPaths) { if ((Test-Path $p) -and ($env:Path -notlike "*$p*")) { $env:Path = "$p;$env:Path" } }

$logDir = Join-Path $repo 'data\private\nfl-loop\cron-logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
$log = Join-Path $logDir ("cron-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))

function Log($msg) {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  $line | Tee-Object -FilePath $log -Append
}

$branch = (git rev-parse --abbrev-ref HEAD)
Log "=== NFL Exp5 daily cron START (branch: $branch) ==="

# From here on we call native tools (tsx/node, git). In Windows PowerShell 5.1,
# 'Stop' turns any line a native exe writes to stderr (node warnings, git push
# progress) into a TERMINATING error -- even on exit 0. Switch to 'Continue' and
# gate real failures on $LASTEXITCODE instead (checked after every native call).
$ErrorActionPreference = 'Continue'

# 1) Process one week. The nfl:week npm script does NOT load .env, so invoke tsx
#    with --env-file directly (mirrors nfl:seed). Needs ANTHROPIC_API_KEY.
#
# WALK-FORWARD: each week is processed exactly ONCE, advancing chronologically
# through the LOOP_SEASONS training window (2015-2024). No loop-back -- re-running
# the same data is data-snooping and adds no out-of-sample evidence. When the
# cursor reaches the end of 2024 the loop reports "caught up" and idles; 2025 is
# the held-out validation season and is intentionally never walked here.
Log "step 1/3: nfl:week"
npx --no-install tsx --env-file=.env scripts/nfl-week.ts *>&1 | Tee-Object -FilePath $log -Append
if ($LASTEXITCODE -ne 0) { Log "FAIL: nfl:week exit $LASTEXITCODE -- aborting"; exit 1 }

# 2) Regenerate the one public file the dashboard reads (no network, no key).
Log "step 2/3: nfl:exp5-summary"
npx --no-install tsx scripts/nfl-exp5-summary.ts *>&1 | Tee-Object -FilePath $log -Append
if ($LASTEXITCODE -ne 0) { Log "FAIL: nfl:exp5-summary exit $LASTEXITCODE -- aborting"; exit 1 }

# 3) Commit + push ONLY the public summary (path-scoped, so unrelated working-tree
#    changes are never swept in). Skip when nothing changed, or when ONLY the
#    generatedAt timestamp moved (the steady offseason state) -- avoids burning a
#    daily Vercel build for no content change.
$dirty = git status --porcelain -- data/processed/nfl-exp5.json
if ([string]::IsNullOrWhiteSpace($dirty)) {
  Log "step 3/3: nfl-exp5.json unchanged -- nothing to commit"
} else {
  $meaningful = git diff -U0 -- data/processed/nfl-exp5.json |
    Where-Object { $_ -match '^[+-]' -and $_ -notmatch '^[+-]{3} ' -and $_ -notmatch '"generatedAt"' }
  if (-not $meaningful) {
    git restore -- data/processed/nfl-exp5.json
    Log "step 3/3: only generatedAt moved (caught up) -- reverted, no commit, no deploy"
  } else {
    $branch = git rev-parse --abbrev-ref HEAD
    Log "step 3/3: committing nfl-exp5.json on '$branch'"
    git add -- data/processed/nfl-exp5.json
    git commit -m ("chore(nfl-exp5): daily loop summary {0}" -f (Get-Date -Format 'yyyy-MM-dd')) *>&1 | Tee-Object -FilePath $log -Append
    git push origin HEAD *>&1 | Tee-Object -FilePath $log -Append
    if ($LASTEXITCODE -ne 0) { Log "WARN: git push exit $LASTEXITCODE (commit is local; goes out on next push)"; exit 1 }
    if ($branch -ne 'master') { Log "NOTE: on '$branch', not master -- dashboard won't redeploy until merged." }
  }
}

Log "=== NFL Exp5 daily cron DONE ==="
