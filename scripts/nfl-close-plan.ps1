# nfl-close-plan.ps1 -- (re)build the NFL-Closes-Dispatch triggers from the ledger.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\scheduled-task.ps1 `
#     -Name nfl-closes-plan -Script scripts\nfl-close-plan.ps1 [-ScriptArgs -DryRun]
#
# The weekly slots below cover the regular Thu/Sun/Mon kickoff clusters. Any
# pending ledger leg whose kickoff has no weekly slot in [kickoff-45m,
# kickoff-5m] (Saturday games, Thanksgiving, Christmas, a moved kickoff) gets a
# ONE-TIME trigger at kickoff-20m. The whole trigger set is rebuilt every run,
# so it is idempotent and past one-offs fall away. Also forces WakeToRun so a
# sleeping PC still fires (a signed-out PC does not - Healthchecks + the
# nfl-grade close-coverage alarm cover that).
#
# NOTE: ASCII only (see cron-common.ps1).

param(
  [switch]$DryRun,
  # Test hook: extra kickoffs (ISO UTC) treated as pending legs.
  [string[]]$ExtraKickoffUtc = @()
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$taskName = 'NFL-Closes-Dispatch'
$horizonDays = 9

# Local (ET) weekly slots - Task Scheduler applies DST itself.
$weekly = @(
  @('Thursday', '20:00'),  # TNF 8:15
  @('Sunday',   '09:10'),  # international 9:30
  @('Sunday',   '12:40'),  # early 1:00
  @('Sunday',   '15:45'),  # late 4:05/4:25
  @('Sunday',   '20:00'),  # SNF 8:20
  @('Monday',   '18:55'),  # MNF doubleheader 7:15
  @('Monday',   '20:00')   # MNF 8:15
)

# Newest ledger: origin/master (bots publish there), falling back to the tree.
$ErrorActionPreference = 'Continue'
git fetch -q origin master 2>&1 | Out-Null
$ledgerJson = (git show origin/master:data/processed/nfl-live/ledger.json 2>$null) -join "`n"
if ($LASTEXITCODE -ne 0 -or -not $ledgerJson) {
  Write-Host "WARN: could not read origin/master ledger - using the working tree copy"
  $ledgerJson = Get-Content 'data\processed\nfl-live\ledger.json' -Raw
}
$ErrorActionPreference = 'Stop'

# node, not ConvertFrom-Json: PS 5.1 turns ISO strings into DateTime objects.
# The JS goes in a file, not `node -e`: PS 5.1 mangles double quotes in
# native-exe arguments.
$tmp = [System.IO.Path]::GetTempFileName()
$tmpJs = "$tmp.js"
[System.IO.File]::WriteAllText($tmp, $ledgerJson)
$js = @'
const l = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
const now = Date.now(), end = now + Number(process.argv[3]) * 864e5;
const k = new Set(l.rows
  .filter((r) => r.status === "pending" && r.entryPriceAmerican != null)
  .map((r) => r.kickoffUtc)
  .filter((t) => { const x = Date.parse(t); return x > now && x <= end; }));
console.log([...k].sort().join("\n"));
'@
[System.IO.File]::WriteAllText($tmpJs, $js)
$kickoffs = @(& node $tmpJs $tmp $horizonDays | Where-Object { $_ })
$nodeCode = $LASTEXITCODE
Remove-Item $tmp, $tmpJs -Force
if ($nodeCode -ne 0) { Write-Host "FAIL: could not parse the ledger (node exit $nodeCode)"; exit 1 }
# -File passes a comma list as ONE string - split it.
$kickoffs += @($ExtraKickoffUtc | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })

$styles = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
$now = Get-Date
$oneOffs = @()
foreach ($iso in ($kickoffs | Sort-Object -Unique)) {
  $kLocal = [DateTime]::Parse($iso, [Globalization.CultureInfo]::InvariantCulture, $styles).ToLocalTime()
  if ($kLocal -le $now -or $kLocal -gt $now.AddDays($horizonDays)) { continue }
  $covered = $false
  foreach ($s in $weekly) {
    if ($kLocal.DayOfWeek.ToString() -ne $s[0]) { continue }
    $slot = [DateTime]::ParseExact("$($kLocal.ToString('yyyy-MM-dd')) $($s[1])", 'yyyy-MM-dd HH:mm', [Globalization.CultureInfo]::InvariantCulture)
    $lead = ($kLocal - $slot).TotalMinutes
    if ($lead -ge 5 -and $lead -le 45) { $covered = $true; break }
  }
  $at = $kLocal.AddMinutes(-20)
  if ($covered) {
    Write-Host ("covered  kickoff {0:ddd yyyy-MM-dd HH:mm} (weekly slot)" -f $kLocal)
  } elseif ($at -le $now) {
    Write-Host ("LATE     kickoff {0:ddd yyyy-MM-dd HH:mm} - T-20 already passed; dispatch manually NOW" -f $kLocal)
  } else {
    Write-Host ("ONE-OFF  kickoff {0:ddd yyyy-MM-dd HH:mm} -> trigger {1:ddd HH:mm}" -f $kLocal, $at)
    $oneOffs += $at
  }
}
$oneOffs = @($oneOffs | Sort-Object -Unique)

$triggers = @()
foreach ($s in $weekly) {
  $triggers += New-ScheduledTaskTrigger -Weekly -DaysOfWeek $s[0] -At ([DateTime]::ParseExact("2026-09-01 $($s[1])", 'yyyy-MM-dd HH:mm', [Globalization.CultureInfo]::InvariantCulture))
}
foreach ($t in $oneOffs) { $triggers += New-ScheduledTaskTrigger -Once -At $t }

Write-Host ("{0} pending kickoffs in {1}d -> {2} weekly + {3} one-time triggers" -f $kickoffs.Count, $horizonDays, $weekly.Count, $oneOffs.Count)
if ($DryRun) { Write-Host "DRY RUN - task not modified"; exit 0 }

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -WakeToRun -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Set-ScheduledTask -TaskName $taskName -Trigger $triggers -Settings $settings | Out-Null

$task = Get-ScheduledTask -TaskName $taskName
$info = $task | Get-ScheduledTaskInfo
if ($task.Triggers.Count -ne $triggers.Count -or -not $task.Settings.WakeToRun) {
  Write-Host "FAIL: task shows $($task.Triggers.Count) triggers / WakeToRun=$($task.Settings.WakeToRun) after update"
  exit 1
}
Write-Host "OK: $taskName has $($task.Triggers.Count) triggers, WakeToRun on, next run $($info.NextRunTime)"
exit 0
