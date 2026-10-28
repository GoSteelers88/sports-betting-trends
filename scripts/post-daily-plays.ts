/**
 * post-daily-plays.ts — post the front page's "today" list to #betting.
 *
 * Builds the rows exactly as src/app/page.tsx does (getDashboardData +
 * loadLiveActions → buildTodayRows), so the channel says what the site says.
 * Runs after each successful agent-run (daily-plays.yml).
 *
 *   npx tsx scripts/post-daily-plays.ts [--dry-run] [--state <file>]
 *
 *   --dry-run      print the messages, post nothing
 *   --state <file> remember what was posted; skip when today's plays are
 *                  unchanged (the evening run repeats the morning list)
 *
 * Posts to DISCORD_PLAYS_WEBHOOK_URL — #betting's own webhook, separate from
 * DISCORD_WEBHOOK_URL, which carries the ops alerts.
 */
import fs from "node:fs";
import { prisma } from "@/lib/prisma";
import { getDashboardData, type SlatePick } from "@/app/_data/dashboard";
import { loadLiveActions } from "@/app/_data/live-actions";
import { buildTodayRows } from "@/lib/today-list";
import { formatDailyPlays, playsSignature } from "@/lib/daily-plays-post";

const SITE_URL = process.env.PUBLIC_BASE_URL ?? "https://sports-betting-trends.vercel.app";

/** page.tsx's mergeById: one entry per pick id across the two lists. */
function mergeById(...lists: SlatePick[][]): SlatePick[] {
  const seen = new Map<number, SlatePick>();
  for (const list of lists) for (const p of list) if (!seen.has(p.id)) seen.set(p.id, p);
  return [...seen.values()];
}

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function post(url: string, content: string): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Discord webhook returned HTTP ${res.status}`);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const statePath = argValue("--state");

  const data = await getDashboardData();
  const nowMs = Date.now();
  const live = loadLiveActions(nowMs);
  const rows = buildTodayRows(
    mergeById(data.picks.games, data.lastNight.games.picks),
    mergeById(data.picks.props, data.lastNight.props.picks),
    live.nflLegs,
    nowMs,
  );
  console.log(`[daily-plays] ${rows.length} play(s) on the site right now`);

  const messages = formatDailyPlays(rows, nowMs, SITE_URL);
  if (messages.length === 0) {
    console.log("[daily-plays] nothing live — no post");
    return;
  }

  const signature = playsSignature(rows, nowMs);
  if (statePath && fs.existsSync(statePath) && fs.readFileSync(statePath, "utf-8").trim() === signature) {
    console.log("[daily-plays] same plays already posted today — no post");
    return;
  }

  if (dryRun) {
    for (const m of messages) console.log(`\n----- message (${m.length} chars) -----\n${m}`);
    return;
  }

  const url = process.env.DISCORD_PLAYS_WEBHOOK_URL?.trim();
  if (!url || !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(url)) {
    throw new Error("DISCORD_PLAYS_WEBHOOK_URL is unset or not a Discord webhook URL");
  }
  for (const m of messages) await post(url, m);
  if (statePath) fs.writeFileSync(statePath, signature);
  console.log(`[daily-plays] posted ${messages.length} message(s)`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error("[daily-plays] FAILED:", e);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
