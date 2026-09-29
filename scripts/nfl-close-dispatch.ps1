# nfl-close-dispatch.ps1 -- fire the nfl-closes workflow ON TIME and wait for it.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\scheduled-task.ps1 `
#     -Name nfl-closes -Script scripts\nfl-close-dispatch.ps1
#
# WHY THIS EXISTS: nfl-closes.yml targets T-20min before each kickoff cluster,
# but GitHub's cron fired it a median 159 min late (max 331; 2 of 48 inside the
# 20-min lead, measured 2026-08-30 -> 09-29). The capture only takes legs that
# kick off within 3h AND have not started, so every run arrived after kickoff
# and the ledger held ZERO closes across 149 legs. workflow_dispatch starts
# immediately, so Windows Task Scheduler (local time, DST-correct) fires the
# dispatch and this script waits for the run so a red capture exits non-zero
# and the launcher alerts Discord.
#
# NOTE: ASCII only (see cron-common.ps1).

$ErrorActionPreference = 'Continue'
$repoSlug = 'GoSteelers88/sports-betting-trends'
$workflow = 'nfl-closes.yml'

$gh = 'C:\Program Files\GitHub CLI\gh.exe'
if (-not (Test-Path $gh)) { $gh = 'gh' }

$dispatchedAt = (Get-Date).ToUniversalTime()
Write-Host "dispatching $workflow on $repoSlug at $($dispatchedAt.ToString('u'))"
& $gh workflow run $workflow -R $repoSlug --ref master
if ($LASTEXITCODE -ne 0) {
  Write-Host "FAIL: gh workflow run exited $LASTEXITCODE (auth? network?)"
  exit 10
}

# The dispatch API returns no run id -- find the run it created.
$runId = $null
for ($i = 0; $i -lt 24 -and -not $runId; $i++) {
  Start-Sleep -Seconds 5
  # Plain text, not ConvertFrom-Json: PS 5.1 turns ISO strings into DateTime
  # objects whose string form then fails to re-parse. The jq filter must hold
  # no double quotes - PS 5.1 mangles them when passing args to a native exe.
  $lines = @(& $gh run list -R $repoSlug --workflow $workflow --event workflow_dispatch --limit 5 --json databaseId,createdAt --jq '.[] | [.databaseId, .createdAt] | @tsv')
  if ($LASTEXITCODE -ne 0) { continue }
  $styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
  foreach ($line in $lines) {
    $parts = "$line".Trim() -split "`t"
    if ($parts.Count -ne 2) { continue }
    $created = [DateTime]::Parse($parts[1], [Globalization.CultureInfo]::InvariantCulture, $styles)
    if ($created -ge $dispatchedAt.AddSeconds(-30)) { $runId = $parts[0]; break }
  }
}
if (-not $runId) {
  Write-Host "FAIL: dispatched, but no workflow_dispatch run appeared within 2 min"
  exit 11
}
Write-Host "run $($runId): https://github.com/$repoSlug/actions/runs/$runId"

# --exit-status makes a failed capture a non-zero exit here.
& $gh run watch $runId -R $repoSlug --exit-status --interval 20 | Select-Object -Last 15
$code = $LASTEXITCODE
if ($code -ne 0) {
  Write-Host "FAIL: run $runId did not succeed (gh exit $code)"
  exit 12
}
Write-Host "OK: run $runId succeeded"
exit 0
