// Discord webhook notifier. No-ops when DISCORD_WEBHOOK_URL is unset.

import type { GradedPick } from "./grader";
import type { AgentLeague } from "./tools";
import type { AutoGradeReport } from "./autograder";

function fmtAmerican(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

function pickLine(p: GradedPick): string {
  return (
    `• **${p.matchup}** | ${p.market} | ${p.selection} @ \`${fmtAmerican(p.oddsAmerican)}\`\n` +
    `  edge **${(p.edge * 100).toFixed(1)}%**, stake **${p.kellyStakeUnits}u**, conf **${p.confidence}**\n` +
    `  > ${p.thesis.slice(0, 350)}`
  );
}

// Validate webhook URL points at Discord (defense against env-poisoning
// pivoting our pick details to an attacker-controlled URL).
function validDiscordWebhook(u: string | undefined): u is string {
  if (!u) return false;
  return /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(u);
}

async function postToWebhook(url: string | undefined, content: string): Promise<void> {
  if (!validDiscordWebhook(url)) {
    if (url) console.warn("discord notify skipped: not a Discord webhook URL");
    return;
  }
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content.slice(0, 1900) }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.warn("discord notify failed:", err);
  }
}

async function postWebhook(content: string): Promise<void> {
  return postToWebhook(process.env.DISCORD_WEBHOOK_URL?.trim(), content);
}

// Posts to a separate "alerts" channel for failures. Falls back to the main
// webhook if DISCORD_ERROR_WEBHOOK_URL is not set so errors aren't lost.
export async function notifyError(component: string, err: unknown, context?: Record<string, unknown>): Promise<void> {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const ctxStr = context ? `\n\`\`\`json\n${JSON.stringify(context, null, 2).slice(0, 800)}\n\`\`\`` : "";
  const content = `🚨 **${component}** failed\n${msg}${ctxStr}`;
  const errUrl = process.env.DISCORD_ERROR_WEBHOOK_URL?.trim();
  if (validDiscordWebhook(errUrl)) {
    await postToWebhook(errUrl, content);
  } else {
    // Fall back to the regular pick-notify webhook so the failure isn't silent.
    await postToWebhook(process.env.DISCORD_WEBHOOK_URL?.trim(), content);
  }
}

export async function notifyPicks(league: AgentLeague, picks: GradedPick[], runId: string): Promise<void> {
  if (picks.length === 0) {
    await postWebhook(`📊 **${league}** — no picks today (passed the slate). \`runId=${runId}\``);
    return;
  }
  const header = `🎯 **${league}** picks (\`${runId}\`) — ${picks.length} bet${picks.length === 1 ? "" : "s"}, ${picks
    .reduce((s, p) => s + p.kellyStakeUnits, 0)
    .toFixed(2)}u total`;
  const body = picks.map(pickLine).join("\n\n");
  await postWebhook(`${header}\n\n${body}`);
}

export async function notifyGraderReport(report: AutoGradeReport): Promise<void> {
  if (report.graded === 0 && report.picksChecked === 0) return;
  const lines = [`✅ **Auto-grader** — ${report.date} — checked ${report.picksChecked}, graded ${report.graded}`];
  for (const [league, stats] of Object.entries(report.byLeague)) {
    lines.push(
      `• ${league}: ${stats.wins}-${stats.losses}-${stats.pushes}, ${stats.unitsPnl >= 0 ? "+" : ""}${stats.unitsPnl.toFixed(2)}u`
    );
  }
  if (report.unmatched > 0) lines.push(`(${report.unmatched} unmatched — likely scheduled or postponed)`);
  await postWebhook(lines.join("\n"));
}
