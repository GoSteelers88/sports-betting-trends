# cron-common.ps1 -- shared helpers for the local scheduled-task scripts.
# Dot-source it:  . (Join-Path $PSScriptRoot 'lib\cron-common.ps1')
#
# NOTE: ASCII only. Windows PowerShell 5.1 reads a no-BOM UTF-8 .ps1 as
# Windows-1252, so non-ASCII punctuation breaks parsing. Enforced by
# src/lib/__tests__/ps1-scripts.test.ts and by the preflight in
# scripts/scheduled-task.ps1.

function Get-EnvValue([string]$name) {
  $root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
  if (-not (Test-Path (Join-Path $root 'package.json'))) { $root = (Get-Location).Path }
  foreach ($f in @('.env.local', '.env')) {
    $p = Join-Path $root $f
    if (Test-Path $p) {
      $line = Select-String -Path $p -Pattern "^$name=" | Select-Object -First 1
      if ($line) {
        # .env values may be wrapped in quotes (DISCORD_WEBHOOK_URL is).
        return ($line.Line -replace "^$name=", '').Trim().Trim('"').Trim("'")
      }
    }
  }
  return $null
}

# Discord has a 2000-char message cap; keep the tail, which is where errors are.
# -Alert routes to the alerts channel (DISCORD_ERROR_WEBHOOK_URL), falling back
# to the main webhook, mirroring notifyError() in src/lib/agent/notify.ts.
function Send-Discord([string]$msg, [switch]$Alert, [switch]$DryRun) {
  if ($msg.Length -gt 1900) { $msg = '...' + $msg.Substring($msg.Length - 1897) }
  if ($DryRun) { Write-Host "DISCORD (dry): $msg"; return }
  $webhook = $null
  if ($Alert) { $webhook = Get-EnvValue 'DISCORD_ERROR_WEBHOOK_URL' }
  if (-not $webhook) { $webhook = Get-EnvValue 'DISCORD_WEBHOOK_URL' }
  if (-not $webhook) { Write-Host "DISCORD_WEBHOOK_URL unset - not sent: $msg"; return }
  try {
    $body = @{ content = $msg } | ConvertTo-Json
    Invoke-RestMethod -Uri $webhook -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 15 | Out-Null
  } catch { Write-Host "discord notify failed: $_" }
}

# Helpers below RETURN a bool, so a caller's logger must never leak into the
# output stream: nfl-cron's Log uses Tee-Object, which passes its line through,
# and a returned @("some log line", $false) is TRUTHY - a failed push would
# read as success. Everything a logger emits goes to the host instead.
# The parameter is $Logger, never $Log: PowerShell names are case-insensitive,
# so a $Log parameter shadows a caller's $log (its log FILE path) inside the
# scriptblock and the caller's Tee-Object writes to a file named after the block.
function Invoke-Log([scriptblock]$Logger, [string]$Message) {
  & $Logger $Message | Out-Host
}

# A conflicted file is safe to resolve by taking origin's copy ONLY when origin's
# latest commit to it was made by a CI bot (every GitHub Actions job commits as
# "<name>-bot"): that file is machine-regenerated, origin's copy is newer, and a
# local run rewrites it on the next refresh anyway. A file a human last
# committed is real work and fails loud instead. This must never wedge a
# scheduled job again (it did 09-18 -> 09-23: 5 odds snapshots left unmerged,
# the daily loop failed every day, nothing alerted).
function Test-BotOwned([string]$Path) {
  $ErrorActionPreference = 'Continue'  # git writes progress to stderr; gate on $LASTEXITCODE
  $author = git log -1 --format=%an origin/master -- $Path 2>$null
  return ($author -match '-bot$')
}

function Resolve-GeneratedConflicts([scriptblock]$Logger) {
  $ErrorActionPreference = 'Continue'  # git writes progress to stderr; gate on $LASTEXITCODE
  $unmerged = @(git diff --name-only --diff-filter=U 2>$null | Where-Object { $_ })
  if ($unmerged.Count -eq 0) { return $true }
  $foreign = @($unmerged | Where-Object { -not (Test-BotOwned $_) })
  if ($foreign.Count -gt 0) {
    Invoke-Log $Logger ("unmerged files that CI does not own (refusing to touch): " + ($foreign -join ', '))
    return $false
  }
  git checkout HEAD -- @unmerged 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Invoke-Log $Logger "git checkout HEAD failed on generated conflicts"; return $false }
  Invoke-Log $Logger ("resolved generated-data conflicts by taking the committed version: " + ($unmerged -join ', '))
  return $true
}

# Pull origin/$Branch into the current checkout. Returns $true on success.
# Handles the two ways the shared checkout wedged in the past:
#   1. unmerged generated files left over from an earlier run
#   2. `--autostash` re-applying local generated-file edits on top of newer
#      origin versions, which leaves them unmerged AND strands the stash
# Anything else unmerged (real work in progress) fails loud instead.
function Sync-Branch([string]$Branch, [scriptblock]$Logger) {
  $ErrorActionPreference = 'Continue'  # git writes progress to stderr; gate on $LASTEXITCODE
  if (-not (Resolve-GeneratedConflicts $Logger)) { return $false }
  $out = @(git pull --rebase --autostash origin $Branch 2>&1 | ForEach-Object { "$_" })
  $code = $LASTEXITCODE
  $out | ForEach-Object { Invoke-Log $Logger "  git: $_" }
  if ($code -ne 0) {
    git rebase --abort 2>&1 | Out-Null
    Invoke-Log $Logger "git pull --rebase failed (exit $code)"
    return $false
  }
  if ($out -match 'Applying autostash resulted in conflicts') {
    if (-not (Resolve-GeneratedConflicts $Logger)) { return $false }
    # Every non-conflicting stashed change was already applied to the tree, and
    # the conflicting ones were generated data we just discarded - so the kept
    # stash holds nothing that is not already on disk or on origin.
    $top = git stash list -1 --format=%gs 2>$null
    if ($top -eq 'autostash') {
      git stash drop 2>&1 | Out-Null
      Invoke-Log $Logger "dropped the stranded autostash (its changes are applied or were generated data)"
    }
  }
  return $true
}

# Commit exactly $Paths (never whatever else happens to be staged), then
# pull-rebase + push with retries. Returns $true once origin has the commit.
function Push-Paths([string[]]$Paths, [string]$Message, [string]$Branch, [scriptblock]$Logger) {
  $ErrorActionPreference = 'Continue'  # git writes progress to stderr; gate on $LASTEXITCODE
  # git refuses ANY commit while unmerged paths exist, even a path-scoped one.
  if (-not (Resolve-GeneratedConflicts $Logger)) { return $false }
  git add -- @Paths 2>&1 | Out-Null
  $staged = @(git diff --cached --name-only -- @Paths | Where-Object { $_ })
  if ($staged.Count -gt 0) {
    git commit -m $Message -- @Paths 2>&1 | ForEach-Object { Invoke-Log $Logger "  git: $_" }
    if ($LASTEXITCODE -ne 0) { Invoke-Log $Logger "git commit failed"; return $false }
  }
  foreach ($attempt in 1..3) {
    if (Sync-Branch $Branch $Logger) {
      git push origin "HEAD:$Branch" 2>&1 | ForEach-Object { Invoke-Log $Logger "  git: $_" }
      if ($LASTEXITCODE -eq 0) {
        # A CI bot may push right after us, so require "origin contains our
        # commit", not "origin == our commit".
        git fetch -q origin $Branch 2>&1 | Out-Null
        git merge-base --is-ancestor HEAD FETCH_HEAD
        if ($LASTEXITCODE -eq 0) { return $true }
        Invoke-Log $Logger "push reported success but origin/$Branch does not contain HEAD"
      }
    }
    Invoke-Log $Logger "sync/push attempt $attempt failed - retrying"
    Start-Sleep -Seconds 5
  }
  return $false
}
