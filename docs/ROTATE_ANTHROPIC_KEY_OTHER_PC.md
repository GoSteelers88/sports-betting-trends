# Rotate the Anthropic key on the other computer

The old Anthropic key (`sk-ant-api03-p81…rQAA`) was revoked on 2026-10-23. Everything
that still uses it fails with `401 invalid x-api-key`. The cloud side is already done
(GitHub Actions secret, Vercel site, Honeywell bridge, this laptop's `.env` files). This
page covers the other computer, where the Discord bot runs.

The new key is **not** in this repo, which is public. Have it ready to paste.

## Steps

1. Open PowerShell in the bot's folder (the copy of this repo on that computer, likely
   `C:\Users\nbber\.openclaw\workspace-kalshi\sports-betting-trends`) and pull:

   ```powershell
   git pull
   ```

   If that folder isn't a git checkout, download the script instead:

   ```powershell
   iwr https://raw.githubusercontent.com/GoSteelers88/sports-betting-trends/master/scripts/rotate-anthropic-key.ps1 -OutFile rotate-anthropic-key.ps1
   ```

2. Optional: see what it would change, without changing anything:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\rotate-anthropic-key.ps1 -DryRun
   ```

3. Run it for real:

   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\rotate-anthropic-key.ps1
   ```

   It will:
   - find every config file and Windows environment variable under your user folder
     that still holds the old key (it prints file paths only, never keys);
   - ask for the new key with the input hidden, and check it with Anthropic before
     touching anything;
   - swap the new key in for the old one, leaving everything else in those files alone;
   - offer to restart the Discord bot, which only reads the key when it starts.

4. Test it: post `parlay: Lakers ML -150, Celtics -120` in the picks channel. You should
   get leg-by-leg verdicts back.

## Also check Railway

The repo docs say the bot runs on Railway (project `sports-betting-bot`). If an old copy is
still deployed there, delete it or stop it. Otherwise two bots answer every message, and
that copy's settings (Discord token, `GH_PAT`, Turso token) may have been exposed in
Railway's 2026-10-21 security incident. If anything was still on Railway in October,
rotate those secrets too.

## Notes

- The Kalshi autopilot on that computer doesn't use Claude. It needs nothing.
- Machine-level environment variables need an admin PowerShell to change. The script
  says so if it hits one.
