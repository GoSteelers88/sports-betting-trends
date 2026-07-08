#!/usr/bin/env bash
# Vercel "Ignored Build Step" (vercel.json ignoreCommand).
# Exit 0 → SKIP the build · exit 1 → BUILD.
#
# Several cron workflows commit pure measurement data back to the repo
# (board/convergence logs, turso backups, weekly memos). Nothing on the site
# renders those files, so rebuilding production for them wastes builds — and
# the bot-authored commits get BLOCKED by Vercel's unknown-author check.
# Skip the build when a commit touches ONLY such files.
#
# CAUTION: data/processed odds snapshots and devig-paper-book.json ARE
# rendered (bundled into the serverless functions), so any commit touching
# files outside the skip-list below must still build.

set -u

CHANGED=$(git diff --name-only HEAD^ HEAD 2>/dev/null)
if [ -z "$CHANGED" ]; then
  exit 1 # can't tell (shallow clone edge case) — build to be safe
fi

SKIP_RE='^(data/backups/|data/processed/pead-memos/|data/processed/(props-board-log|convergence-log|clv-proof-log|flb-backtest)\.json$)'

if echo "$CHANGED" | grep -qvE "$SKIP_RE"; then
  exit 1 # at least one file outside the skip-list → build
fi

echo "only measurement-log files changed — skipping build"
exit 0
