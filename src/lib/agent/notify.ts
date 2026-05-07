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

async function postWebhook(content: string): Promise<void> {
  const url = process.env.DISCORD_WEBHOOK_URL?.trim();
  if (!url) return;
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
