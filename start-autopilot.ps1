$workDir = "C:\Users\nbber\.openclaw\workspace-kalshi\sports-betting-trends"
$logFile = Join-Path $workDir "autopilot.log"
$pidFile = Join-Path $workDir "autopilot.pid"

# Compile TypeScript → JS so we always run fresh code (no tsx cache issues)
Push-Location $workDir
& npx esbuild scripts/run-kalshi-autopilot.ts --bundle --platform=node --target=node22 --outfile=scripts/run-kalshi-autopilot.js --log-level=warning
Pop-Location

$p = Start-Process -NoNewWindow -PassThru `
  -WorkingDirectory $workDir `
  -FilePath "cmd.exe" `
  -ArgumentList "/C node scripts/run-kalshi-autopilot.js >> `"$logFile`" 2>&1"

$p.Id | Out-File -Encoding ascii $pidFile -NoNewline
Write-Host "Autopilot started. PID=$($p.Id) logged to $pidFile"
