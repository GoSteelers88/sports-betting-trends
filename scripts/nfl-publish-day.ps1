# nfl-publish-day.ps1 - the weekly NFL publish, end to end, unattended.
# Registered as Windows scheduled task "NFL-Weekly-Publish" (Tue 10:07 AM ET),
# launched through scripts\scheduled-task.ps1 so that a crash - or a parse
# error, which kills this file before its own try/catch - still alerts.
# Deterministic by design: every step is a script that hard-fails loudly; no
# agent judgment mid-flow. Reports success/failure to Discord.
#
# NOTE: ASCII only. The 09-22 run never started: an em-dash in a string made
# PS 5.1 (which reads no-BOM UTF-8 as cp1252) fail to parse the file.
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
#   4b. props (non-fatal): refresh box scores, grade weeks N-1 and N-2 (N-2
#       mops up late box scores), capture week N's prop market
#   5. ONE commit of board + snapshot + ledger + prop receipts, push (auto-deploys /nfl)
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
    if ($DryRun) {
      # a dry run should still exercise the full wiring incl. the Discord ping
      $Week = 1
    } else {
      Write-Host "computed week $Week is outside the regular season (1-18) - nothing to publish"
      exit 0
    }
  }
}

$ErrorActionPreference = "Stop"
$repo = "C:\Users\Nate\source\repos\GoSteelers88\sports-betting-trends"
Set-Location $repo
$log = Join-Path $repo ("publish-day-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
Start-Transcript -Path $log | Out-Null
. (Join-Path $PSScriptRoot 'lib\cron-common.ps1')

function Notify([string]$msg, [switch]$Alert) {
  Write-Host "NOTIFY: $msg"
  Send-Discord $msg -Alert:$Alert
}
$gitLog = { param($m) Write-Host $m }

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
    if (-not (Sync-Branch 'master' $gitLog)) { throw "git sync failed (see log)" }
    Notify "NFL publish-day DRY RUN ok: env keys present, repo current, Discord wiring live. Real runs fire Tuesdays 10:07 AM ET starting Sept 8."
    Stop-Transcript | Out-Null
    exit 0
  }

  # This tree is allowed to hold unrelated WIP; the receipt commit is
  # path-scoped. Sync-Branch auto-resolves conflicts only on CI-bot-owned data.
  Write-Host "== git sync"
  if (-not (Sync-Branch 'master' $gitLog)) { throw "git sync failed (see log)" }
  Run "refresh nflverse inputs" { npm run nfl:ingest }
  Run "refresh injuries" { npm run nfl:ingest-injuries }
  # 2026-09-10: the live-week inputs the backtest gets for free but a live
  # board does not - ESPN injuries (nflverse week-N reports don't exist until
  # Wednesday; the board publishes Tuesday), kickoff weather forecasts, EPA
  # features, stadium geocodes. All free APIs, no credits. Non-fatal by
  # design: the model board must still publish on a feed outage - the board
  # then records which inputs were missing (inputs.* coverage block).
  Write-Host "== refresh ESPN injuries (non-fatal)"
  npm run ingest:injuries
  if ($LASTEXITCODE -ne 0) { Write-Host "ingest:injuries failed (non-fatal) - board will use whatever injuries-nfl.json holds" }
  # Grade LAST week's private model board into the live calibration record
  # (live-graded.jsonl). Record only - the fit reads it solely behind
  # --with-live-calibration on nfl-live-week.ts, which this runbook does NOT
  # pass. Non-fatal: a missing board or an unrefreshed spine just logs.
  if ($Week -gt 1) {
    Write-Host "== grade last week's live reads into live-graded.jsonl (non-fatal)"
    npm run nfl:grade-live -- $Season ($Week - 1)
    if ($LASTEXITCODE -ne 0) { Write-Host "nfl:grade-live failed (non-fatal) - calibration record not updated this week" }
  }
  Write-Host "== refresh live inputs: weather / EPA / stadiums / referees (non-fatal)"
  npm run nfl:ingest-live -- $Season $Week
  if ($LASTEXITCODE -ne 0) { Write-Host "nfl:ingest-live failed (non-fatal) - board will record missing inputs" }
  # Snap counts BEFORE the board: its calibration fit keeps in-game exits (a
  # starter who left hurt) out, and needs last week's snaps to see them.
  Write-Host "== snap counts (non-fatal)"
  npm run nfl:ingest-snaps
  if ($LASTEXITCODE -ne 0) { Write-Host "nfl:ingest-snaps failed (non-fatal) - calibration uses cached snap counts" }
  Run "regenerate model board (final doctrine)" {
    npx tsx --env-file-if-exists=.env.local --env-file=.env scripts/nfl-live-week.ts $Season $Week --force
  }
  Run "publish board" {
    npx tsx --env-file-if-exists=.env.local --env-file=.env scripts/nfl-publish-board.ts $Season $Week
  }

  # 2026-09-23: props. Until today nothing scheduled any of this - the week 2
  # market was captured and graded by hand ONCE, before kickoff, so all 476
  # rows sat at no-data for a week and week 3 was never captured. Non-fatal:
  # the model board is the product; props must never block it.
  $propRels = @()
  $propNote = ""
  Write-Host "== props: refresh box scores (non-fatal)"
  npm run nfl:ingest-props-stats
  if ($LASTEXITCODE -ne 0) { $propNote += " props: BOX-SCORE REFRESH FAILED." }
  foreach ($w in @(($Week - 1), ($Week - 2))) {
    if ($w -lt 1) { continue }
    if (-not (Test-Path ("data/private/nfl-loop/live-props/{0}-REG-wk{1}.json" -f $Season, $w))) { continue }
    Write-Host "== props: grade week $w (non-fatal)"
    npm run nfl:props-grade -- $Season $w
    if ($LASTEXITCODE -ne 0) { $propNote += " props wk${w}: GRADE FAILED."; continue }
    $rel = "data/processed/nfl-live/props-{0}-wk{1:d2}.json" -f $Season, $w
    if (Test-Path $rel) {
      $propRels += $rel
      $pb = Get-Content $rel -Raw | ConvertFrom-Json
      $propNote += " props wk${w}: $($pb.totals.settled) settled / $($pb.totals.pending) pending."
      # A graded week with nothing settled is the exact silent failure above.
      if ($w -eq ($Week - 1) -and $pb.totals.settled -eq 0) { $propNote += " WARN: 0 settled - box scores missing?" }
    }
  }
  if (-not (Test-Path ("data/private/nfl-loop/live-props/{0}-REG-wk{1}.json" -f $Season, $Week))) {
    Write-Host "== props: capture week $Week market (non-fatal, ~64 odds credits)"
    npm run nfl:props-week -- $Season $Week
    if ($LASTEXITCODE -ne 0) { $propNote += " props wk${Week}: CAPTURE FAILED." }
  }
  $relN = "data/processed/nfl-live/props-{0}-wk{1:d2}.json" -f $Season, $Week
  if (Test-Path $relN) {
    $propRels += $relN
    $pn = Get-Content $relN -Raw | ConvertFrom-Json
    $propNote += " props wk${Week}: $($pn.totals.lines) lines captured."
  }

  $wk = "{0:d2}" -f $Week
  $boardRel = "data/processed/nfl-live/board-$Season-wk$wk.json"
  $snapRel = "data/processed/nfl-live/snapshots/entry-$Season-wk$wk.json"
  $ledgerRel = "data/processed/nfl-live/ledger.json"

  # ONE path-scoped commit = the notary event; push with retries. MUST land.
  Write-Host "== commit + push receipts"
  # play-record.json is rewritten by nfl:grade-live above and nothing else
  # commits it: until 09-23 the public record sat at week 1 (1-1, 3 pending)
  # while the settled local copy said 2-3.
  $receipts = @($boardRel, $snapRel, $ledgerRel, "data/processed/nfl-live/play-record.json") + $propRels
  if (-not (Push-Paths $receipts "nfl: publish $Season week $Week board (immutable receipt)" 'master' $gitLog)) {
    throw "commit/push failed after 3 attempts - board is NOT public"
  }

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
  Notify ("NFL WEEK $Week PUBLISHED ($sha): $($plays.Count) PLAY / $($board.legs.Count) legs, $($board.dropped.Count) dropped by kickoff gate. Notary verified vs origin/master.$propNote Site deploying now - verify /nfl, then post to X. Draft:`n$xDraft")
  Stop-Transcript | Out-Null
  exit 0
}
catch {
  Notify "NFL WEEK $Week PUBLISH FAILED: $_ - see $log. Boards unpublished until this is fixed; kickoff is Thu 8:20pm ET." -Alert
  Stop-Transcript | Out-Null
  exit 1
}
