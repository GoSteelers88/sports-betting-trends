// /x-ready — re-render the X-ready post + pick card on demand.
//
// Defaults to today's picks across all leagues. Pass runId to scope to a
// single agent run, or league/date to filter.

import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { prisma } from "@/lib/prisma";
import { formatPicksForX } from "@/lib/agent/x-formatter";
import type { GradedPick } from "@/lib/agent/grader";
import type { AgentLeague } from "@/lib/agent/tools";
import type { Command } from "./index";

const data = new SlashCommandBuilder()
  .setName("x-ready")
  .setDescription("Render an X-ready copy block + downloadable card for picks")
  .addStringOption(opt =>
    opt
      .setName("runid")
      .setDescription("Specific agent runId; default = today's picks across all runs")
  )
  .addStringOption(opt =>
    opt
      .setName("league")
      .setDescription("Filter by league")
      .addChoices(
        { name: "BOTH (NBA + MLB)", value: "BOTH" },
        { name: "ALL (NBA + MLB + WNBA)", value: "ALL" },
        { name: "NBA", value: "NBA" },
        { name: "MLB", value: "MLB" },
        { name: "WNBA", value: "WNBA" }
      )
  )
  .addStringOption(opt =>
    opt
      .setName("date")
      .setDescription("YYYY-MM-DD (UTC); default = today")
  );

function paperTrialDay(now: Date = new Date()): number {
  const start = Date.UTC(2026, 4, 6);
  const day = Math.floor((now.getTime() - start) / 86_400_000) + 1;
  return Math.max(1, Math.min(30, day));
}

function publicBaseUrl(): string | null {
  const explicit = process.env.PUBLIC_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel.replace(/\/$/, "")}`;
  return null;
}

function parseDateUtc(s: string | null): Date {
  const d = new Date();
  if (s) {
    const [y, m, day] = s.split("-").map(Number);
    if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(day)) {
      d.setUTCFullYear(y, m - 1, day);
    }
  }
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export const xReadyCommand: Command = {
  data,
  async handler(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const runId = interaction.options.getString("runid")?.trim() || null;
    const leagueFilter = (interaction.options.getString("league") ?? "BOTH") as
      | "BOTH"
      | AgentLeague;
    const dateStr = interaction.options.getString("date");

    const where: Record<string, unknown> = {};
    if (runId) {
      where.runId = runId;
    } else {
      const start = parseDateUtc(dateStr);
      const end = new Date(start);
      end.setUTCDate(end.getUTCDate() + 1);
      where.gameDate = { gte: start, lt: end };
    }
    if (leagueFilter !== "BOTH") where.league = leagueFilter;

    const rows = await prisma.agentPick.findMany({
      where,
      orderBy: [{ edge: "desc" }],
      take: 8,
    });

    if (rows.length === 0) {
      await interaction.editReply(
        runId
          ? `No picks found for runId \`${runId}\`.`
          : `No picks found for ${dateStr ?? "today"}${
              leagueFilter !== "BOTH" ? ` (${leagueFilter})` : ""
            }.`
      );
      return;
    }

    // The DB rows aren't full GradedPicks (no graderOk/graderNotes). The
    // formatter only reads matchup/selection/oddsAmerican/edge/kellyStakeUnits,
    // so cast through `unknown` to satisfy the type without inventing fields.
    const picks = rows as unknown as GradedPick[];
    const pickLeagues = rows.map(r => r.league);

    const day = paperTrialDay();
    const x = formatPicksForX({
      league: leagueFilter,
      picks,
      pickLeagues,
      paperTrialDay: day,
      paperTrialTotal: 30,
    });

    const base = publicBaseUrl();
    // Prefer runId-scoped image when the user asked for one run; otherwise
    // use date-scoped so the image matches the text block.
    const imgQuery = runId
      ? `runId=${encodeURIComponent(runId)}`
      : `date=${parseDateUtc(dateStr).toISOString().slice(0, 10)}${
          leagueFilter !== "BOTH" ? `&league=${leagueFilter}` : ""
        }`;
    const imageUrl = base ? `${base}/api/og/picks?${imgQuery}` : null;

    const truncatedNote = x.truncated ? " _(truncated)_" : "";
    const header = `📋 **X-ready** · ${x.charCount}/280 chars${truncatedNote}`;
    const content = `${header}\n\`\`\`\n${x.text}\n\`\`\``;

    const embed = imageUrl
      ? new EmbedBuilder()
          .setTitle("🎰 Pick card")
          .setDescription("Right-click → Save image → upload to X")
          .setColor(0xa855f7)
          .setImage(imageUrl)
          .setFooter({
            text: `${x.picksIncluded} picks · day ${day}/30${runId ? ` · run ${runId}` : ""}`,
          })
      : null;

    await interaction.editReply({
      content,
      embeds: embed ? [embed] : [],
    });
  },
};
