#!/usr/bin/env node
// PreToolUse hook for Bash. Fires on every Bash invocation; only inspects
// `git commit*` commands. Mirrors the secret-grep regex from
// .github/workflows/agent-run.yml so credentials are caught before they ever
// reach the workflow-side guard.
//
// Stdin contract (Claude Code PreToolUse): JSON with shape
//   { tool_name: "Bash", tool_input: { command: "...", ... }, ... }
// Exit 0 = allow tool call. Exit 2 = block tool call with stderr shown to model.

import { execSync } from "node:child_process";

const PATTERNS = [
  { name: "Anthropic API key", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "Generic sk- secret", re: /\bsk-[A-Za-z0-9]{40,}\b/ },
  { name: "GitHub PAT", re: /ghp_[A-Za-z0-9]{20,}/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Slack bot token", re: /xoxb-[A-Za-z0-9-]{20,}/ },
  { name: "Slack user token", re: /xoxp-[A-Za-z0-9-]{20,}/ },
  { name: "Turso auth token", re: /eyJ[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{20,}/ },
];

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function isGitCommit(cmd) {
  if (!cmd) return false;
  return /(^|\s|&&\s*|;\s*)git\s+commit\b/.test(cmd);
}

try {
  const raw = await readStdin();
  if (!raw.trim()) process.exit(0);

  const payload = JSON.parse(raw);
  if (payload.tool_name !== "Bash") process.exit(0);

  const cmd = payload?.tool_input?.command ?? "";
  if (!isGitCommit(cmd)) process.exit(0);

  let staged = "";
  try {
    staged = execSync("git diff --cached --no-color", {
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 32 * 1024 * 1024,
    }).toString("utf8");
  } catch {
    // No staged changes or not in a repo; let the underlying git command speak.
    process.exit(0);
  }

  if (!staged) process.exit(0);

  // Only inspect added/changed lines.
  const added = staged
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .join("\n");

  for (const { name, re } of PATTERNS) {
    const m = added.match(re);
    if (m) {
      console.error(`\n[secret-grep] Blocked git commit — staged changes contain a ${name}.`);
      console.error(`[secret-grep] Matched pattern: ${re}`);
      console.error(`[secret-grep] Unstage the offending hunk, scrub the secret, then re-commit.\n`);
      process.exit(2);
    }
  }

  process.exit(0);
} catch (err) {
  // Hook errors must not block the user. Log and pass.
  console.error(`[secret-grep] hook error (allowing commit): ${err?.message ?? err}`);
  process.exit(0);
}
