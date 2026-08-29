# nfl-publish-day.ps1 - the Sept 8 week-1 publish, end to end, unattended.
# Registered as one-time Windows scheduled task "NFL-Wk1-Publish" (Sept 8
# 10:07 AM ET). Deterministic by design: every step is a script that hard-fails
# loudly; no agent judgment mid-flow. Reports success/failure to Discord.
#
#   powershell -ExecutionPolicy Bypass -File scripts\nfl-publish-day.ps1 [-DryRun] [-Season 2026] [-Week 1]
#
# Steps:
#   1. git pull --rebase (bots commit constantly)
#   2. refresh loop inputs (nfl:ingest + nfl:ingest-injuries)
#   3. regenerate the model board under final doctrine (nfl-live-week --force)
#   4. publish (nfl-publish-board: real entry snapshot, kickoff gate, control
#      arm, SHA256 registration; refuses if the board already exists - so a
#      double-fire of this task is safe)
#   5. ONE commit of board + snapshot + ledger, push (auto-deploys /nfl)
#   6. notary with remote verification
#   7. Discord: result + a drafted X post
# A -DryRun stops after env checks and pings Discord so the wiring can be
# tested without publishing.

param(
  [switch]$DryRun,
  [int]$Season = 2026,
  # 0 = compute from the calendar (weekly scheduled runs); pass explicitly to
  # override. Week N's publish Tuesday = Sept 8 + 7*(N-1).
  [int]$Week = 0
)

if ($Week -eq 0) {
  $week1Tuesday = Get-Date "2026-09-08"
  $Week = [math]::Floor(((Get-Date) - $week1Tuesday).TotalDays / 7) + 1
  if ($Week -lt 1 -or $Week -gt 18) {
    Write-Host "computed week $Week is outside the regular season (1-18) - nothing to publish"
    exit 0
  }
}

$ErrorActionPreference = "Stop"
$repo = "C:\Users\Nate\source\repos\GoSteelers88\sports-betting-trends"
Set-Location $repo
$log = Join-Path $repo ("publish-day-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
Start-Transcript -Path $log | Out-Null

function Get-EnvValue([string]$name) {
  foreach ($f in @(".env.local", ".env")) {
    if (Test-Path $f) {
      $line = Select-String -Path $f -Pattern "^$name=" | Select-Object -First 1
      if ($line) { return ($line.Line -replace "^$name=", "").Trim() }
    }
  }
  return $null
}

$webhook = Get-EnvValue "DISCORD_WEBHOOK_URL"
function Notify([string]$msg) {
  Write-Host "NOTIFY: $msg"
  if ($webhook) {
    try {
      $body = @{ content = $msg } | ConvertTo-Json
      Invoke-RestMethod -Uri $webhook -Method Post -ContentType "application/json" -Body $body | Out-Null
    } catch { Write-Host "discord notify failed: $_" }
  }
}

function Run([string]$desc, [scriptblock]$block) {
  Write-Host "== $desc"
  & $block
  if ($LASTEXITCODE -ne 0) { throw "$desc failed (exit $LASTEXITCODE)" }
}

try {
  # env sanity before anything mutates
  foreach ($k in @("THE_ODDS_API_KEY", "ANTHROPIC_API_KEY")) {
    if (-not (Get-EnvValue $k)) { throw "$k missing from .env/.env.local" }
  }

  if ($DryRun) {
    Run "git pull" { git pull --rebase origin master }
    Notify "NFL publish-day DRY RUN ok: env keys present, repo current. Live run fires Sept 8, 10:07 AM."
    Stop-Transcript | Out-Null
    exit 0
  }

  Run "git pull" { git pull --rebase origin master }
  Run "refresh nflverse inputs" { npm run nfl:ingest }
  Run "refresh injuries" { npm run nfl:ingest-injuries }
  Run "regenerate model board (final doctrine)" {
    npx tsx --env-file-if-exists=.env.local --env-file=.env scripts/nfl-live-week.ts $Season $Week --force
  }
  Run "publish board" {
    npx tsx --env-file-if-exists=.env.local --env-file=.env scripts/nfl-publish-board.ts $Season $Week
  }

  $wk = "{0:d2}" -f $Week
  $boardRel = "data/processed/nfl-live/board-$Season-wk$wk.json"
  $snapRel = "data/processed/nfl-live/snapshots/entry-$Season-wk$wk.json"
  $ledgerRel = "data/processed/nfl-live/ledger.json"

  Run "stage receipts" { git add $boardRel $snapRel $ledgerRel }
  Run "commit (one commit = the notary event)" {
    git commit -m "nfl: publish $Season week $Week board (immutable receipt)"
  }
  # push with rebase retries; MUST land or we fail loud
  $pushed = $false
  foreach ($i in 1..3) {
    git pull --rebase --autostash origin master
    if ($LASTEXITCODE -eq 0) {
      git push origin master
      if ($LASTEXITCODE -eq 0) { $pushed = $true; break }
    }
    Start-Sleep -Seconds 5
  }
  if (-not $pushed) { throw "push failed after 3 attempts - board is committed locally but NOT public" }

  Run "notary (remote-verified)" {
    npx tsx scripts/verify-notary.ts --require-remote
  }

  # Compose the result + a drafted X post from the published board.
  $board = Get-Content $boardRel -Raw | ConvertFrom-Json
  $plays = @($board.legs | Where-Object { $_.role -eq "play" })
  $sha = (git log -1 --format=%h)
  if ($plays.Count -eq 0) {
    $xDraft = "NFL week $Week, 2026: our pre-registered model board is published - and it's EMPTY. 48 candidate legs, 0 cleared the post-holdout doctrine floors. An empty board published on time is the product. Receipts, methodology, and the negative holdout: sports-betting-trends.vercel.app/nfl"
  } else {
    $legLines = ($plays | ForEach-Object { "$($_.selection) $($_.entryPriceAmerican)" }) -join "; "
    $xDraft = "NFL week $Week, 2026 board is live: $($plays.Count) play(s) - $legLines. Real entry prices, devigged CLV vs the sharp close, control arm, no ROI claims. Receipts: sports-betting-trends.vercel.app/nfl"
  }
  Notify ("NFL WEEK $Week PUBLISHED ($sha): $($plays.Count) PLAY / $($board.legs.Count) legs, $($board.dropped.Count) dropped by kickoff gate. Notary verified vs origin/master. Site deploying now - verify /nfl, then post to X. Draft:`n$xDraft")
  Stop-Transcript | Out-Null
  exit 0
}
catch {
  Notify "NFL WEEK $Week PUBLISH FAILED: $_ - see $log. Boards unpublished until this is fixed; kickoff is Thu 8:20pm ET."
  Stop-Transcript | Out-Null
  exit 1
}
