# scheduled-task.ps1 -- the ONE entry point every local NFL scheduled task runs.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\scheduled-task.ps1 `
#     -Name nfl-daily -Script scripts\nfl-cron.ps1 [-ScriptArgs a,b] [-DryNotify]
#
# WHY THIS EXISTS: 2026-09-18 -> 09-23 all three local NFL tasks failed and
# nothing told anyone. The daily loop wedged on a git conflict (WARN in a log),
# the dream crashed on a missing import (FAIL in a log), and publish-day could
# not even PARSE, so it died before its own try/catch and never sent its
# failure notice. Earlier, 07-09 -> 07-27, the loop's push failed 18 days
# straight the same way. A job cannot report its own death, so the reporting
# lives here, outside the job:
#
#   1. preflight: the job script must be ASCII and must parse (PS 5.1)
#   2. run it as a CHILD process, so a crash/parse error is just an exit code
#   3. exit != 0  -> Discord alert (alerts channel) with the output tail
#   4. every run pings Healthchecks.io (start + exit code). A run that never
#      happens at all - PC off, task disabled, this file broken - sends NO
#      ping, and Healthchecks alerts on the missing ping. That is the one
#      failure nothing on this machine can report. Setup: scripts/healthchecks-setup.ts
#
# NOTE: ASCII only (see cron-common.ps1).

param(
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $true)][string]$Script,
  [string[]]$ScriptArgs = @(),
  [switch]$DryNotify
)

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
. (Join-Path $PSScriptRoot 'lib\cron-common.ps1')

$extraPaths = @('C:\Program Files\Git\cmd', "$env:ProgramFiles\nodejs", "$env:APPDATA\npm")
foreach ($p in $extraPaths) { if ((Test-Path $p) -and ($env:Path -notlike "*$p*")) { $env:Path = "$p;$env:Path" } }

$logDir = Join-Path $repo 'data\private\nfl-loop\cron-logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
$log = Join-Path $logDir ("task-{0}-{1}.log" -f $Name, (Get-Date -Format 'yyyy-MM-dd-HHmmss'))
function Log([string]$msg) {
  $line = "{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
  Write-Host $line
  $line | Out-File -FilePath $log -Append -Encoding utf8
}

# --- Healthchecks.io pings (no-op until HEALTHCHECKS_PING_KEY is set) --------
$pingKey = Get-EnvValue 'HEALTHCHECKS_PING_KEY'
$rid = [guid]::NewGuid().ToString()
function Ping-Health([string]$suffix, [string]$body = '') {
  if (-not $pingKey) { return }
  $url = "https://hc-ping.com/$pingKey/$Name$suffix" + "?rid=$rid"
  if ($DryNotify) { Write-Host "HEALTHCHECK (dry): $suffix"; return }
  try {
    Invoke-RestMethod -Uri $url -Method Post -Body $body -ContentType 'text/plain; charset=utf-8' -TimeoutSec 15 | Out-Null
  } catch { Log "healthchecks ping failed (non-fatal): $_" }
}
if (-not $pingKey) { Log "HEALTHCHECKS_PING_KEY unset - missed-run detection is OFF (run: npm run healthchecks:setup)" }

$started = Get-Date
Log "=== task $Name START: $Script $($ScriptArgs -join ' ') ==="
Ping-Health '/start'

$code = 0
$tail = @()
$scriptPath = Join-Path $repo $Script

# --- 1. preflight -------------------------------------------------------------
if (-not (Test-Path $scriptPath)) {
  $code = 2; $tail = @("script not found: $scriptPath")
} else {
  $bytes = [System.IO.File]::ReadAllBytes($scriptPath)
  $bad = @(); for ($i = 0; $i -lt $bytes.Length; $i++) { if ($bytes[$i] -gt 127) { $bad += $i; if ($bad.Count -ge 3) { break } } }
  $tokens = $null; $parseErrors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors) | Out-Null
  if ($parseErrors.Count -gt 0) {
    $code = 3
    $tail = @($parseErrors | Select-Object -First 5 | ForEach-Object { "PARSE ERROR line $($_.Extent.StartLineNumber): $($_.Message)" })
    if ($bad.Count -gt 0) { $tail += "file has non-ASCII bytes (first at byte $($bad[0])) - PS 5.1 reads no-BOM UTF-8 as cp1252; replace em-dashes/curly quotes" }
  }
}

# --- 2. run as a child process -----------------------------------------------
if ($code -eq 0) {
  $out = @(& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath @ScriptArgs 2>&1 | ForEach-Object { "$_" })
  $code = $LASTEXITCODE
  if ($null -eq $code) { $code = 1 }
  $out | Out-File -FilePath $log -Append -Encoding utf8
  $tail = @($out | Where-Object { $_.Trim() } | Select-Object -Last 25)
}

$mins = [math]::Round(((Get-Date) - $started).TotalMinutes, 1)
$tailText = ($tail -join "`n")

# --- 3/4. report ---------------------------------------------------------------
if ($code -eq 0) {
  Log "=== task $Name OK (exit 0, $mins min) ==="
  Ping-Health '/0' $tailText
} else {
  Log "=== task $Name FAILED (exit $code, $mins min) ==="
  $tail | ForEach-Object { Log "  | $_" }
  Ping-Health "/$code" $tailText
  $fence = '```'
  $msg = "SCHEDULED TASK FAILED: **$Name** ($Script) exit $code on $env:COMPUTERNAME after $mins min.`nLog: $log`n$fence`n$tailText`n$fence"
  Send-Discord $msg -Alert -DryRun:$DryNotify
}
exit $code
