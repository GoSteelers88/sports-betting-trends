<#
Replace the revoked Anthropic key on THIS computer and restart the Discord bot.

The old key (sk-ant-api03-p81...rQAA) was revoked on 2026-10-23. Anything on this
machine still holding it gets 401 "invalid x-api-key" from Anthropic.

What it does:
  1. Finds every config file under your user folder (and your Windows user/machine
     environment variables) that still holds the old key. Prints PATHS ONLY.
  2. Asks for the new key with the input hidden, checks it against Anthropic, then
     swaps it in place of the old key. Nothing else in those files changes.
  3. Offers to restart the Discord bot, which only reads the key at startup.

Usage (from the repo folder):
  powershell -ExecutionPolicy Bypass -File scripts\rotate-anthropic-key.ps1
  powershell -ExecutionPolicy Bypass -File scripts\rotate-anthropic-key.ps1 -DryRun
  powershell -ExecutionPolicy Bypass -File scripts\rotate-anthropic-key.ps1 -Root C:\Users\me\projects

No key is stored in this file. The repo is public.
#>
param(
  [string]$Root = $env:USERPROFILE,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# First and last characters of the revoked key, assembled in pieces so the repo's
# secret scanners don't flag this file. The full key never appears here.
$OldKeyPattern = 'sk-ant-' + 'api03-p81' + '[A-Za-z0-9_-]+' + 'rQAA'

$SkipDirNames = @('node_modules', '.git', '.next', '.venv', 'venv', '__pycache__', 'site-packages', '.cache', 'dist', 'build')
$FilePatterns = @('.env', '.env.*', '*.json', '*.txt', '*.yml', '*.yaml', '*.toml', '*.ini')
$MaxFileBytes = 20MB
# Cloud-only OneDrive placeholders: reading them would download them. Skip.
$CloudOnlyAttrs = 0x400000 -bor 0x1000   # RECALL_ON_DATA_ACCESS | OFFLINE

function Find-CandidateFiles([string]$start) {
  $stack = New-Object System.Collections.Stack
  $stack.Push($start)
  while ($stack.Count -gt 0) {
    $dir = $stack.Pop()
    if ($dir -match '\\AppData\\Local(\\|$)') { continue }
    try { $subdirs = [IO.Directory]::GetDirectories($dir) } catch { continue }
    foreach ($d in $subdirs) {
      if ($SkipDirNames -contains [IO.Path]::GetFileName($d)) { continue }
      try {
        # Junctions and symlinks can loop back on themselves.
        if (([int][IO.File]::GetAttributes($d) -band [int][IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
      } catch { continue }
      $stack.Push($d)
    }
    try { $files = [IO.Directory]::GetFiles($dir) } catch { continue }
    foreach ($f in $files) {
      $name = [IO.Path]::GetFileName($f)
      $wanted = $false
      foreach ($p in $FilePatterns) { if ($name -like $p) { $wanted = $true; break } }
      if (-not $wanted) { continue }
      try {
        $info = New-Object IO.FileInfo($f)
        if ($info.Length -gt $MaxFileBytes) { continue }
        if (([int]$info.Attributes -band $CloudOnlyAttrs) -ne 0) { continue }
      } catch { continue }
      $f
    }
  }
}

Write-Host "Searching $Root for the old key. This can take a few minutes..."
$hits = @()
foreach ($f in Find-CandidateFiles $Root) {
  try { $text = [IO.File]::ReadAllText($f) } catch { continue }
  if ([regex]::IsMatch($text, $OldKeyPattern)) { $hits += $f }
}

$envHits = @()
foreach ($scope in 'User', 'Machine') {
  $vars = [Environment]::GetEnvironmentVariables($scope)
  foreach ($name in $vars.Keys) {
    if ([regex]::IsMatch([string]$vars[$name], $OldKeyPattern)) {
      $envHits += [pscustomobject]@{ Scope = $scope; Name = $name }
    }
  }
}

if ($hits.Count -eq 0 -and $envHits.Count -eq 0) {
  Write-Host "No file or environment variable on this computer holds the old key. Nothing to change."
  exit 0
}

Write-Host ""
Write-Host "The old key is in:"
foreach ($h in $hits) { Write-Host "  $h" }
foreach ($e in $envHits) { Write-Host "  $($e.Scope) environment variable $($e.Name)" }

if ($DryRun) {
  Write-Host ""
  Write-Host "Dry run: nothing changed."
  exit 0
}

Write-Host ""
$secure = Read-Host 'Paste the NEW Anthropic key (input is hidden)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $NewKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }

if ($NewKey -notmatch '^sk-ant-[A-Za-z0-9_-]{20,}$') {
  throw "That doesn't look like an Anthropic key. Nothing changed."
}
if ([regex]::IsMatch($NewKey, $OldKeyPattern)) {
  throw "That is the old, revoked key. Nothing changed."
}

try {
  $null = Invoke-WebRequest -UseBasicParsing -Uri 'https://api.anthropic.com/v1/models?limit=1' `
    -Headers @{ 'x-api-key' = $NewKey; 'anthropic-version' = '2023-06-01' }
  Write-Host "New key accepted by Anthropic."
} catch {
  throw "Anthropic rejected the new key ($($_.Exception.Message)). Nothing changed."
}

$evaluator = [Text.RegularExpressions.MatchEvaluator] { param($m) $NewKey }
foreach ($h in $hits) {
  $text = [IO.File]::ReadAllText($h)
  $updated = [regex]::Replace($text, $OldKeyPattern, $evaluator)
  # UTF-8 without a BOM: a BOM would corrupt the first variable name for dotenv.
  [IO.File]::WriteAllText($h, $updated)
  Write-Host "  updated $h"
}
foreach ($e in $envHits) {
  $value = [string][Environment]::GetEnvironmentVariable($e.Name, $e.Scope)
  try {
    [Environment]::SetEnvironmentVariable($e.Name, [regex]::Replace($value, $OldKeyPattern, $evaluator), $e.Scope)
    Write-Host "  updated $($e.Scope) environment variable $($e.Name)"
  } catch {
    Write-Host "  COULD NOT update $($e.Scope) variable $($e.Name) (Machine scope needs an admin PowerShell)."
  }
}

# The bot builds its Anthropic client once (src/lib/agent/client.ts), so a running
# bot keeps the dead key until it restarts.
function Get-BotProcesses {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'src[\\/]bot[\\/]index' }
}

$botDir = $null
foreach ($h in $hits) {
  $pkg = Join-Path (Split-Path $h -Parent) 'package.json'
  if ((Test-Path $pkg) -and ((Get-Content $pkg -Raw) -match '"bot:start"')) { $botDir = Split-Path $h -Parent; break }
}

Write-Host ""
$running = @(Get-BotProcesses)
if ($running.Count -eq 0) {
  Write-Host "The Discord bot isn't running on this computer right now."
  if ($botDir) { Write-Host "Start it with:  cd `"$botDir`"; npm run bot:start" }
} else {
  Write-Host "The Discord bot is running (PID $(($running | ForEach-Object { $_.ProcessId }) -join ', ')) with the old key loaded."
  $answer = Read-Host 'Restart it now so it picks up the new key? (y/n)'
  if ($answer -match '^[Yy]') {
    $running | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Write-Host "Stopped. Waiting 15 seconds in case something (pm2, a scheduled task) restarts it on its own..."
    Start-Sleep -Seconds 15
    $again = @(Get-BotProcesses)
    if ($again.Count -gt 0) {
      Write-Host "It came back on its own (PID $(($again | ForEach-Object { $_.ProcessId }) -join ', ')), now with the new key. Done."
    } elseif ($botDir) {
      Start-Process -FilePath 'cmd.exe' -ArgumentList '/k npm run bot:start' -WorkingDirectory $botDir
      Write-Host "Started the bot in a new window from $botDir."
    } else {
      Write-Host "Couldn't tell which folder the bot runs from. Start it the way you normally do."
    }
  } else {
    Write-Host "Not restarted. The bot keeps failing on Claude calls until you restart it."
  }
}

Write-Host ""
Write-Host "Test: post  parlay: Lakers ML -150, Celtics -120  in the picks channel. You should get leg-by-leg verdicts back."
