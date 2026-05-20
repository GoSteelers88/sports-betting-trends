// Discord webhook notifier. No-ops when DISCORD_WEBHOOK_URL is unset.

import type { GradedPick } from "./grader";
import type { AgentLeague } from "./tools";
import type { AutoGradeReport } from "./autograder";
import { formatPicksForX } from "./x-formatter";

function fmtAmerican(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

// Format the analyst's gameTime (ISO 8601 from The Odds API's commence_time)
// into a compact "Sat 8:40 PM ET" so a Sunday-afternoon pick posted Saturday
// morning doesn't read as "tonight". Returns empty when gameTime is missing
// or unparseable so the line layout still works.
function fmtGameTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const tz = "America/New_York";
  // Intl emits "EDT"/"EST"; normalize to a single "ET" label so Discord posts
  // don't churn at the DST boundary.
  const dayPart = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(d);
  const timePart = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
  }).format(d);
  return `${dayPart} ${timePart} ET`;
}

function pickLine(p: GradedPick): string {
  const when = fmtGameTime(p.gameTime);
  const matchupLine = when
    ? `• **${p.matchup}** _(${when})_ | ${p.market} | ${p.selection} @ \`${fmtAmerican(p.oddsAmerican)}\``
    : `• **${p.matchup}** | ${p.market} | ${p.selection} @ \`${fmtAmerican(p.oddsAmerican)}\``;
  return (
    `${matchupLine}\n` +
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

type DiscordEmbed = {
  title?: string;
  description?: string;
  color?: number;
  image?: { url: string };
  footer?: { text: string };
};

type WebhookPayload = {
  content?: string;
  embeds?: DiscordEmbed[];
};

async function postToWebhook(url: string | undefined, payload: string | WebhookPayload): Promise<void> {
  if (!validDiscordWebhook(url)) {
    if (url) console.warn("discord notify skipped: not a Discord webhook URL");
    return;
  }
  const body: WebhookPayload =
    typeof payload === "string" ? { content: payload.slice(0, 1900) } : {
      ...payload,
      content: payload.content ? payload.content.slice(0, 1900) : undefined,
    };
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    console.warn("discord notify failed:", err);
  }
}

async function postWebhook(payload: string | WebhookPayload): Promise<void> {
  return postToWebhook(process.env.DISCORD_WEBHOOK_URL?.trim(), payload);
}

// Days since the paper trial start (2026-05-06 UTC), clamped to [1, 30].
function paperTrialDay(): number {
  const start = Date.UTC(2026, 4, 6);
  const day = Math.floor((Date.now() - start) / 86_400_000) + 1;
  return Math.max(1, Math.min(30, day));
}

// Public base URL for Discord image embeds. Vercel sets VERCEL_URL on every
// deploy; PUBLIC_BASE_URL overrides for production aliases.
function publicBaseUrl(): string | null {
  const explicit = process.env.PUBLIC_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel.replace(/\/$/, "")}`;
  return null;
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

export async function notifyPicks(
  league: AgentLeague,
  picks: GradedPick[],
  runId: string,
  killedCount = 0
): Promise<void> {
  if (picks.length === 0) {
    // Empty + nothing-killed = silent. The "no picks today" message trained
    // the channel to be ignored; we now only post when there's actual signal
    // (a pick to ship OR a critic kill worth seeing). Errors and critic-floor
    // engagement still ping the error webhook separately.
    if (killedCount > 0) {
      await postWebhook(
        `📊 **${league}** — analyst produced picks but the critic killed all ${killedCount}. No ship. \`runId=${runId}\``
      );
    }
    return;
  }
  const header = `🎯 **${league}** picks (\`${runId}\`) — ${picks.length} bet${picks.length === 1 ? "" : "s"}, ${picks
    .reduce((s, p) => s + p.kellyStakeUnits, 0)
    .toFixed(2)}u total`;
  const body = picks.map(pickLine).join("\n\n");
  await postWebhook(`${header}\n\n${body}`);

  // X-ready post block: triple-backtick code fence so Discord shows a
  // one-click copy button. Embed the OG card so the user can right-click →
  // save image → upload to X. Both are guarded — if the X formatter or base
  // URL fail, we still ship the picks message above.
  try {
    await notifyXReady(league, picks, runId);
  } catch (err) {
    console.warn("notifyXReady failed:", err);
  }
}

// Posts a separate Discord message containing:
//   1. The X-ready text in a code block (one-click copy in Discord UI)
//   2. An embed with the OG image (right-click save → upload to X)
//
// Exported so the orchestrator or bot can also call it directly if needed.
export async function notifyXReady(
  league: AgentLeague | "BOTH",
  picks: GradedPick[],
  runId: string
): Promise<void> {
  const day = paperTrialDay();
  const x = formatPicksForX({
    league,
    picks,
    paperTrialDay: day,
    paperTrialTotal: 30,
  });

  const base = publicBaseUrl();
  const imageUrl = base ? `${base}/api/og/picks?runId=${encodeURIComponent(runId)}` : null;

  const truncatedNote = x.truncated ? ` _(truncated to fit 280)_` : "";
  const charNote = `_${x.charCount}/280 chars${truncatedNote}_`;

  const content = `📋 **X-ready post** — copy below or save the image\n${charNote}\n\`\`\`\n${x.text}\n\`\`\``;

  const payload: WebhookPayload = { content };
  if (imageUrl) {
    payload.embeds = [
      {
        title: "🎰 Pick card",
        description: "Right-click → Save image → upload to X",
        color: 0xa855f7, // violet — matches dashboard accent
        image: { url: imageUrl },
        footer: { text: `runId ${runId} · ${x.picksIncluded} picks · day ${day}/30` },
      },
    ];
  }
  await postWebhook(payload);
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
